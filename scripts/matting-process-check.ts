import {app} from 'electron';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {MattingProcess} from '../electron/matting-process';
import {runProcess,probeMedia,createProxy,renderProject} from '../electron/media';
import {removePersonBackground,type PersonCutoutContext} from '../electron/matting';
import {newProject,newClip} from '../shared/project';

const root=path.resolve('.test-artifacts/matting-process'),run=path.join(root,Date.now().toString());
const options={modelPath:path.resolve('resources/models/person-matting-rvm.onnx'),workerPath:path.resolve('dist-electron/matting-worker.cjs')};
const sessions:MattingProcess[]=[],diagnostics:Record<string,unknown>[]=[],checks:string[]=[];
const observe=(e:Record<string,unknown>)=>diagnostics.push({at:performance.now(),...e});
async function main(){
 await fs.mkdir(run,{recursive:true});app.setPath('userData',path.join(run,'profile'));await app.whenReady();
 try{
  const fixture=JSON.parse(await fs.readFile('.test-artifacts/matting-fixtures/fixture.json','utf8'));
  const {width,height,frames}=fixture,pixels=width*height,frame={width,height,data:Buffer.alloc(pixels*3)};
  const file=await fs.open(fixture.raw,'r'),alphaFile=await fs.open(path.join(run,'cpu-alpha.gray'),'w+');
  const read=async(i:number)=>{let offset=0;while(offset<frame.data.length){const {bytesRead}=await file.read(frame.data,offset,frame.data.length-offset,i*frame.data.length+offset);assert.ok(bytesRead);offset+=bytesRead;}};
  let ticks=0,at=performance.now(),maxDelay=0;
  const timer=setInterval(()=>{const now=performance.now();maxDelay=Math.max(maxDelay,now-at);at=now;ticks++;},10);
  const reports=[],alpha=Buffer.alloc(pixels),reference=Buffer.alloc(pixels);let totalDifference=0,maxDifference=0,changed=0;
  try{for(const backend of ['cpu','dml'] as const){
   const engine=await MattingProcess.create({...options,backend,diagnostics:observe,profilePrefix:path.join(run,'native')});sessions.push(engine);
   const milliseconds=[],coverage=[];let previous:Buffer|undefined;
   for(let i=0;i<frames;i++){
    await read(i);const start=performance.now(),out=await engine.process(frame,Math.round(i*1e6/30));milliseconds.push(performance.now()-start);
    let empty=0,opaque=0,soft=0;
    for(let p=0;p<pixels;p++){const a=out.data[p*4+3];alpha[p]=a;if(a<8)empty++;else if(a>247)opaque++;else soft++;}
    coverage.push({empty:empty/pixels,opaque:opaque/pixels,soft:soft/pixels});
    if(backend==='cpu'){
     await alphaFile.write(alpha,0,pixels,i*pixels);
     if(previous)for(let p=0;p<pixels;p++)if(Math.abs(previous[p]-alpha[p])>16)changed++;
     previous=Buffer.from(alpha);
    }else{
     const got=await alphaFile.read(reference,0,pixels,i*pixels);assert.equal(got.bytesRead,pixels);
     for(let p=0;p<pixels;p++){const d=Math.abs(alpha[p]-reference[p]);totalDifference+=d;maxDifference=Math.max(maxDifference,d);}
    }
    if(backend==='dml'&&[0,29,59].includes(i)){
     // Four panels: original / alpha / composite on white / on black.
     const sheet=Buffer.alloc(pixels*3*4);
     for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const p=y*width+x,a=alpha[p]/255;
      for(let ch=0;ch<3;ch++){
       sheet[(y*width*4+x)*3+ch]=frame.data[p*3+ch];
       sheet[(y*width*4+width+x)*3+ch]=alpha[p];
       sheet[(y*width*4+2*width+x)*3+ch]=Math.round(out.data[p*4+ch]*a+255*(1-a));
       sheet[(y*width*4+3*width+x)*3+ch]=Math.round(out.data[p*4+ch]*a);
      }
     }
     const raw=path.join(run,`review-${i}.bgr`);await fs.writeFile(raw,sheet);
     await runProcess(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-y','-f','rawvideo','-pixel_format','bgr24','-video_size',`${width*4}x${height}`,'-i',raw,'-frames:v','1','-vf','scale=2560:-1',path.join(run,`review-${i}.png`)],{timeoutMs:30000});
    }
   }
   await engine.reset();await read(0);const again=await engine.process(frame,0);assert.equal(again.data.length,pixels*4);await engine.close();
   const warm=milliseconds.slice(1).sort((a,b)=>a-b);
   reports.push({backend,frames,totalMs:milliseconds.reduce((a,b)=>a+b,0),firstMs:milliseconds[0],warmMedianMs:warm[Math.floor(warm.length/2)],warmP95Ms:warm[Math.floor(warm.length*.95)],coverage});
   assert.ok(coverage.every(c=>c.empty>.15&&c.opaque>.1&&c.soft>.001),'Real footage must produce transparent background, opaque human and soft edges');
   checks.push(`Native ${backend}: 60 moving human frames at 720p, sequential state, partial alpha, reset and close`);
  }}finally{clearInterval(timer);await file.close();await alphaFile.close();}
  const meanDifference=totalDifference/(pixels*frames);
  assert.ok(meanDifference<1,`CPU/DirectML alpha mean absolute difference ${meanDifference}/255`);assert.ok(changed>pixels*.05,'Alpha must follow real motion, not return a static cutout');
  assert.ok(ticks>50&&maxDelay<250,`Parent timer ticks ${ticks}, max gap ${maxDelay}ms`);
  checks.push('CPU/DirectML alpha agreement and changing silhouette; parent timer remains responsive');

  const control=new AbortController(),cancelled=await MattingProcess.create({...options,backend:'cpu',signal:control.signal,diagnostics:observe});sessions.push(cancelled);
  const pending=cancelled.process(frame,0),rejected=assert.rejects(pending,{name:'AbortError'});setTimeout(()=>control.abort(),5);await rejected;await cancelled.close();
  checks.push('Cancellation during a real frame rejects and waits for the owned worker to exit');
  const stalled=path.join(run,'stalled.cjs');await fs.writeFile(stalled,'setInterval(()=>{},1000);');
  await assert.rejects(MattingProcess.create({...options,workerPath:stalled,requestTimeoutMs:200,diagnostics:observe}),/응답/);
  checks.push('Unresponsive worker times out without a window');
  const crash=path.join(run,'crash.cjs');await fs.writeFile(crash,`require(${JSON.stringify(options.workerPath)});process.parentPort.on('message',({data})=>{if(data.method==='process')process.exit(9);});`);
  const crashed=await MattingProcess.create({...options,workerPath:crash,diagnostics:observe});sessions.push(crashed);await assert.rejects(crashed.process(frame,0),/종료.*9/);await crashed.close();
  checks.push('Unexpected native-worker exit is contained without a main-process error dialog');
  const invalid=path.join(run,'invalid.cjs');await fs.writeFile(invalid,`const port=process.parentPort,send=port.postMessage.bind(port);port.postMessage=value=>{if(value.result?.width)value.result.width=1;send(value);};require(${JSON.stringify(options.workerPath)});`);
  const malformed=await MattingProcess.create({...options,workerPath:invalid,diagnostics:observe});sessions.push(malformed);await assert.rejects(malformed.process(frame,0),/잘못된/);await malformed.close();
  checks.push('Malformed worker frame is rejected and the worker terminates');
  const corrupt=path.join(run,'corrupt.onnx'),bytes=await fs.readFile(options.modelPath);bytes[bytes.length-1]^=1;await fs.writeFile(corrupt,bytes);
  await assert.rejects(MattingProcess.create({...options,modelPath:corrupt,backend:'cpu',diagnostics:observe}),/손상/);checks.push('Exact-size but modified model fails SHA validation before native loading');
  const corruptGpu=path.join(run,'corrupt-gpu.onnx'),gpuBytes=await fs.readFile(path.resolve('resources/models/person-matting-rvm-bgr.onnx'));gpuBytes[gpuBytes.length-1]^=1;await fs.writeFile(corruptGpu,gpuBytes);
  await assert.rejects(MattingProcess.create({...options,gpuModelPath:corruptGpu,backend:'dml',diagnostics:observe}),/손상/);
  const fallback=await MattingProcess.create({...options,gpuModelPath:corruptGpu,backend:'auto',diagnostics:observe});sessions.push(fallback);assert.equal(fallback.backend,'cpu');const recovered=await fallback.process(frame,0);assert.equal(recovered.backend,'cpu');assert.equal(recovered.data.length,pixels*4);await fallback.close();
  checks.push('Modified GPU adapter fails SHA validation; automatic mode processes the frame using the intact CPU model');
  const context:PersonCutoutContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(run,'cache'),derivedDir:path.join(run,'derived'),diagnostics:observe,createMatting:async(config,signal)=>{const e=await MattingProcess.create({...options,...config,signal,diagnostics:observe});sessions.push(e);return e;}};
  const original=await probeMedia(fixture.source.file,context,undefined,{derivatives:false});assert.equal(original.width,3840);assert.equal(original.height,2160);
  const pipelineStart=performance.now(),cutout=await removePersonBackground(original,{start:0,duration:1,device:'gpu'},context);
  const pipelineMs=performance.now()-pipelineStart;assert.equal(cutout.width,3840);assert.equal(cutout.height,2160);assert.equal(cutout.hasAlpha,true);assert.equal(cutout.duration,1);
  const outputInfo=JSON.parse((await runProcess(context.ffprobe,['-v','error','-show_frames','-show_streams','-of','json',cutout.path])).stdout.toString());
  // The research MP4 advertises 30 fps but its actual timestamps differ. A
  // full frame scan (without interval seeking, which can skip frame zero)
  // provides an independent presentation-time oracle for the derived video.
  const originalInfo=JSON.parse((await runProcess(context.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',original.path],{timeoutMs:60000})).stdout.toString());
  const expectedPts=originalInfo.frames.map((f:any)=>Math.round((Number(f.best_effort_timestamp_time)-(original.timing?.origin??0))*1e6)).filter((t:number)=>t>=0&&t<1000000);
  assert.deepEqual(outputInfo.frames.map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*1e6)),expectedPts);assert.equal(outputInfo.streams[0].pix_fmt,'bgra');
  const proxyStart=performance.now(),proxied=await createProxy(cutout,context),proxyMs=performance.now()-proxyStart;assert.ok(proxied.proxyPath?.endsWith('-alpha-proxy.webm'));
  const project=newProject();project.width=640;project.height=360;project.fps=30;project.background='#00ff00';project.media=[proxied];project.clips=[{...newClip('video-1',proxied),duration:.3}];
  const exportPath=path.join(run,'cutout-export.mp4');await renderProject(project,{width:640,height:360,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'high',outputPath:exportPath},context);
  const exported=(await runProcess(context.ffmpeg,['-v','error','-nostdin','-i',exportPath,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
  const pixel=(x:number,y:number)=>[...exported.subarray((y*640+x)*3,(y*640+x)*3+3)];assert.ok(pixel(10,180)[1]>245&&pixel(10,180)[0]<5&&pixel(10,180)[2]<5,'Transparent corner must reveal timeline green');assert.ok(pixel(350,180)[1]<100,'Opaque human must retain foreground color');
  await runProcess(context.ffmpeg,['-v','error','-nostdin','-y','-i',exportPath,'-frames:v','1',path.join(run,'cutout-export.png')]);
  checks.push(`Actual 4K GPU pipeline: ${expectedPts.length} native frames, lossless alpha MOV, exact 1-second duration, WebM proxy and composed timeline export`);
  const cancelPipeline=new AbortController();let cancelSent=false;
  await assert.rejects(removePersonBackground(original,{start:0,duration:1,device:'gpu'},context,(progress)=>{if(progress>.1){cancelSent=true;cancelPipeline.abort();}},cancelPipeline.signal),{name:'AbortError'});assert.equal(cancelSent,true);
  assert.deepEqual((await fs.readdir(context.derivedDir!)).sort(),[path.basename(cutout.path)]);checks.push('Cancellation during actual 4K GPU matting cleans the partial file and all owned decoder/encoder/worker processes');
  for(const e of diagnostics.filter(e=>['matting-encoder-start','tracking-decoder-start','matting-mux-start'].includes(String(e.event))))assert.throws(()=>process.kill(Number(e.pid),0),{code:'ESRCH'});
  for(const e of diagnostics.filter(e=>e.event==='matting-process-start')){assert.ok(diagnostics.some(exit=>exit.event==='matting-process-exit'&&exit.pid===e.pid),'Every owned worker must emit exit');assert.throws(()=>process.kill(Number(e.pid),0),{code:'ESRCH'},`Worker ${e.pid} is still visible to the OS`);}
  assert.ok(!Object.keys(require.cache).some(key=>/onnxruntime.*(?:binding|index)/i.test(key)));checks.push('All worker PIDs exited and the parent loaded no native inference binding');
  const profiles=[];
  for(const name of await fs.readdir(run)){if(!name.startsWith('native-'))continue;const events=JSON.parse(await fs.readFile(path.join(run,name),'utf8')),providers:Record<string,number>={};for(const e of events)if(e.args?.provider)providers[e.args.provider]=(providers[e.args.provider]||0)+1;profiles.push({name,providers});}
  assert.ok(profiles.some(p=>p.providers.CPUExecutionProvider>0));assert.ok(profiles.some(p=>p.providers.DmlExecutionProvider>0));
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({version:JSON.parse(await fs.readFile('package.json','utf8')).version,scope:'720p model/worker timings include IPC and pixel conversion, excluding decoding/encoding. Separately: actual 4K video pipeline, transparent proxy and timeline export. Excludes editor UI and packaged EXE. One research clip without independent ground-truth alpha; no general quality or realtime claim.',run,fixture,checks,reports,meanDifference,maxDifference,changed,ticks,maxDelay,pipeline:{pipelineMs,proxyMs,cutout,proxied,outputBytes:(await fs.stat(cutout.path)).size,exportPath},diagnostics,profiles},null,2)+'\n');app.exit(0);
 }catch(error){await Promise.allSettled(sessions.map(s=>s.close()));await fs.writeFile(path.join(run,'diagnostics-on-failure.json'),JSON.stringify({checks,diagnostics},null,2));await fs.writeFile(path.join(run,'failure.txt'),String(error instanceof Error?error.stack:error));app.exit(1);}
}
void main().catch(async error=>{await fs.mkdir(run,{recursive:true});await fs.writeFile(path.join(run,'failure.txt'),String(error instanceof Error?error.stack:error));app.exit(1);});
