import {app} from 'electron';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MattingProcess} from '../electron/matting-process';
import {removePersonBackground,type PersonCutoutContext} from '../electron/matting';
import {probeMedia,createProxy,runProcess} from '../electron/media';
import {newProject,newClip} from '../shared/project';
import {applyCutout} from '../shared/processing';

const root=path.resolve(process.env.SLU_LONG_ROOT!),sourceFile=path.join(root,'looped-4k.mov');
const ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),ffprobe=path.resolve('resources/bin/ffprobe.exe');
const start=.2,duration=59.6,samplesAt=new Set([0,59,359,360,365,719,720,725,1079,1439,1779]);
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const ff=(args:string[],bytes=40*1024*1024)=>runProcess(ffmpeg,['-v','error','-nostdin',...args],{timeoutMs:180000,maxOutputBytes:bytes});
const sessions=new Set<MattingProcess>(),owned=new Set<number>(),diagnostics:Record<string,unknown>[]=[],memory:Record<string,any>[]=[],checks:string[]=[];
let phase='starting',frames=0,lastPts=0,abortAt=Infinity,controller:AbortController|undefined;
let timer:ReturnType<typeof setInterval>|undefined,pending=Promise.resolve();
const reference:Array<{index:number;pts:number;sha256:string}>=[];
const born=performance.now();
const record=(event:Record<string,unknown>)=>{if(typeof event.pid==='number')owned.add(event.pid);if(event.event!=='matting-frame-timing')diagnostics.push({atMs:performance.now()-born,...event});};
const context:PersonCutoutContext={ffmpeg,ffprobe,cacheDir:path.join(root,'cache'),derivedDir:path.join(root,'derived'),diagnostics:record,createMatting:async(config,signal)=>{
 const engine=await MattingProcess.create({...config,signal,modelPath:path.resolve('resources/models/person-matting-rvm.onnx'),workerPath:path.resolve('dist-electron/matting-worker.cjs'),diagnostics:record});sessions.add(engine);
 return {get backend(){return engine.backend;},async process(frame,pts){
  const result=await engine.process(frame,pts);assert.equal(result.backend,'dml');
  if(phase==='matting'&&samplesAt.has(frames)){
   // Independent byte canonicalization, deliberately not the production LUT.
   const canonical=Buffer.from(result.data);for(let i=0;i<canonical.length;i+=4)if(!canonical[i+3])canonical.fill(0,i,i+3);
   reference.push({index:frames,pts:Math.max(0,pts-Math.round(start*1e6)),sha256:sha(canonical)});
  }
  frames++;lastPts=pts;if(frames>=abortAt)controller!.abort();return result;
 },async close(){await engine.close();sessions.delete(engine);}};
}};
async function packets(file:string){return JSON.parse((await runProcess(ffprobe,['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts_time,duration_time','-of','json',file],{timeoutMs:180000,maxOutputBytes:2*1024*1024})).stdout.toString()).packets as Array<{pts_time:string;duration_time:string}>;}
async function main(){
 await fs.mkdir(root,{recursive:true});app.setPath('userData',path.join(root,'profile'));await app.whenReady();
 timer=setInterval(()=>{
  const row={atMs:performance.now()-born,phase,frames,lastPts,mainRssBytes:process.memoryUsage.rss(),processes:app.getAppMetrics().map(p=>({pid:p.pid,creationTime:p.creationTime,type:p.type,name:p.serviceName||p.name,workingSetBytes:p.memory.workingSetSize*1024,privateBytes:p.memory.privateBytes===undefined?undefined:p.memory.privateBytes*1024}))};
  memory.push(row);pending=pending.then(()=>fs.writeFile(path.join(root,'progress.json'),JSON.stringify(row)));
 },1000);
 const input=await probeMedia(sourceFile,context,undefined,{derivatives:false});assert.equal(input.width,3840);assert.equal(input.height,2160);assert.ok(input.hasAudio);
 phase='matting';const began=performance.now();const output=await removePersonBackground(input,{start,duration,device:'gpu'},context);const fileMs=performance.now()-began,processed=frames;checks.push('Sustained 4K native-frame GPU processing completed with audio and alpha');
 await fs.writeFile(path.join(root,'native-output.json'),JSON.stringify({input,output,fileMs,processed,reference},null,2));
 phase='proxy';const proxyBegan=performance.now(),playable=await createProxy(output,context),proxyMs=performance.now()-proxyBegan,readyMs=performance.now()-began;
 await fs.writeFile(path.join(root,'playable-output.json'),JSON.stringify({playable,fileMs,proxyMs,readyMs},null,2));
 checks.push('Mandatory transparent preview was fully generated before ready-to-edit timing ended');
 phase='verify';assert.ok(processed>1700);assert.equal(output.duration,duration);assert.equal(playable.hasAlpha,true);
 const sourcePackets=(await packets(sourceFile)).map(p=>Math.round(Number(p.pts_time)*1e6)).sort((a,b)=>a-b);let held=0;for(let i=0;i<sourcePackets.length&&sourcePackets[i]<=start*1e6;i++)held=i;
 const expected=sourcePackets.slice(held).filter(pts=>pts<(start+duration)*1e6).map(pts=>Math.max(0,pts-start*1e6));
 const outputPackets=await packets(output.path);assert.deepEqual(outputPackets.map(p=>Math.round(Number(p.pts_time)*1e6)),expected);assert.equal(outputPackets.length,processed);assert.equal(Math.round(Number(outputPackets.at(-1)!.duration_time)*1e6),duration*1e6-expected.at(-1)!);checks.push('Every output timestamp and the final held-frame duration match original presentation times');
 for(const sample of reference){
  const raw=(await ff(['-ss',String(Math.max(0,sample.pts/1e6-.2)),'-i',output.path,'-vf',`select=gte(t\\,${sample.pts/1e6-Math.max(0,sample.pts/1e6-.2)-.000001})`,'-frames:v','1','-pix_fmt','bgra','-f','rawvideo','pipe:1'])).stdout;
  assert.equal(raw.length,3840*2160*4);assert.equal(sha(raw),sample.sha256,`Encoded frame ${sample.index}`);
 }
 assert.equal(reference.length,samplesAt.size);checks.push('Eleven separated decoded 4K frames exactly match independently canonicalized model-output bytes');
 const a=(await ff(['-i',sourceFile,'-map','0:a:0','-af',`atrim=start=${start}:end=${start+duration},asetpts=PTS-STARTPTS`,'-f','f32le','pipe:1'])).stdout;
 const b=(await ff(['-i',output.path,'-map','0:a:0','-f','f32le','pipe:1'])).stdout;assert.equal(a.length,Math.round(duration*48000)*2*4);assert.equal(sha(a),sha(b));checks.push('All selected stereo PCM samples match the original audio exactly');
 for(const sample of reference.filter((_,i)=>i%2===0))await ff(['-y','-ss',String(Math.max(0,sample.pts/1e6-.2)),'-i',output.path,'-vf',`select=gte(t\\,${sample.pts/1e6-Math.max(0,sample.pts/1e6-.2)-.000001}),scale=640:360`,'-frames:v','1',path.join(root,`review-${sample.index}.png`)]);
 const project=newProject();project.name='4K long cutout';project.width=3840;project.height=2160;project.background='#00ff00';project.media=[input,playable];project.clips=[applyCutout({...newClip('video-1',input),in:start,duration},playable,{quality:'portrait'})];await fs.writeFile(path.join(root,'review.sluproj'),JSON.stringify(project));
 phase='cancel';const before=(await fs.readdir(context.derivedDir!)).sort();frames=0;abortAt=180;controller=new AbortController();const cancelBegan=performance.now();await assert.rejects(removePersonBackground(input,{start,duration,device:'gpu'},context,undefined,controller.signal),{name:'AbortError'});const cancelledMs=performance.now()-cancelBegan;assert.equal(frames,180);assert.deepEqual((await fs.readdir(context.derivedDir!)).sort(),before);checks.push('Cancellation after 180 real 4K GPU frames leaves no partial directory or published result');
 assert.equal(sessions.size,0);for(const pid of owned){let live=true;for(let i=0;i<20&&live;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,50));}catch{live=false;}}assert.equal(live,false,`Owned process survived: ${pid}`);}checks.push('All owned model, decoder, encoder and mux processes exited');
 clearInterval(timer);timer=undefined;await pending;
 // Chromium reports node.mojom.NodeService here, not utilityProcess's display
 // serviceName. Use the owned PID emitted by MattingProcess, not a label.
 const workerPids=new Set(diagnostics.filter(e=>e.event==='matting-process-start').map(e=>e.pid));
 const mattingMemory=memory.filter(r=>r.phase==='matting'),mainPeak=Math.max(...mattingMemory.map(r=>r.mainRssBytes)),workerRows=mattingMemory.flatMap(r=>r.processes.filter((p:any)=>workerPids.has(p.pid)).map((p:any)=>({frame:r.frames,...p}))),workerPeak=Math.max(...workerRows.map(r=>r.workingSetBytes));
 assert.ok(workerRows.length>20,'Missing worker memory telemetry');assert.ok(mainPeak<1024**3,`Main process exceeded 1GiB: ${mainPeak}`);assert.ok(workerPeak<4*1024**3,`Worker exceeded 4GiB: ${workerPeak}`);
 const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];const memoryWindows=[{from:300,to:600},{from:900,to:1200},{from:1500,to:1800}].map(w=>({...w,mainMedianBytes:median(mattingMemory.filter(r=>r.frames>=w.from&&r.frames<w.to).map(r=>r.mainRssBytes)),workerMedianBytes:median(workerRows.filter(r=>r.frame>=w.from&&r.frame<w.to).map(r=>r.workingSetBytes))}));
 const report={version:JSON.parse(await fs.readFile('package.json','utf8')).version,root,scope:'59.6 seconds from a 60-second loop of one 12-second 4K research sample plus deterministic stereo audio. Instrumented native host, not UI playback performance or varied-human quality. Ready time includes required transparent proxy. Memory covers Electron main/utility processes, excludes FFmpeg; GPU telemetry is system-wide.',checks,processed,reference,timing:{fileMs,proxyMs,readyMs,cancelledMs},output:playable,input,outputBytes:(await fs.stat(output.path)).size,proxyBytes:(await fs.stat(playable.proxyPath!)).size,audio:{bytes:a.length,sha256:sha(b)},memory:{mainPeak,workerPeak,windows:memoryWindows},diagnostics};
 await fs.writeFile(path.join(root,'memory.json'),JSON.stringify(memory));await fs.writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));phase='complete';await fs.writeFile(path.join(root,'progress.json'),JSON.stringify({phase,checks:checks.length,frames:processed}));app.exit(0);
}
void main().catch(async error=>{if(timer)clearInterval(timer);await Promise.allSettled([...sessions].map(s=>s.close()));await pending.catch(()=>{});await fs.writeFile(path.join(root,'memory.json'),JSON.stringify(memory));await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({error:String(error instanceof Error?error.stack:error),phase,frames,checks,diagnostics},null,2));app.exit(1);});
