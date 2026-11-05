import {app,BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {MattingProcess} from '../electron/matting-process';
import type {MattingFrame,MattingOutput} from '../electron/matting-model';
import {removePersonBackground,type PersonCutoutContext} from '../electron/matting';
import {prepareTrackingInput} from '../electron/tracking-source';
import {decodeTrackingFrames} from '../electron/tracking-decode';
import {probeMedia,runProcess,type EngineContext} from '../electron/media';
import {requireSourceRevision} from '../electron/source-revision';

const root=path.resolve(process.env.SLU_MATTING_PRECISION_ROOT!);
const controller=new AbortController(),sessions=new Set<MattingProcess>();
const diagnostics:Record<string,unknown>[]=[],checks:string[]=[],owned=new Set<number>();
const comparisons:Record<string,unknown>[]=[],pipelines:Record<string,unknown>[]=[];
let phase='starting',frameRequests=0;
const deadline=setTimeout(()=>controller.abort(),9*60*1000);
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const observe=(event:Record<string,unknown>)=>{
 if(typeof event.pid==='number')owned.add(event.pid);
 diagnostics.push({phase,...event});
};
app.disableHardwareAcceleration();app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData',path.join(root,'profile'));

function difference(actual:Uint8Array,expected:Uint8Array){
 assert.equal(actual.length,expected.length);
 let alphaSum=0,alphaMax=0,blackSum=0,whiteSum=0;
 for(let pixel=0;pixel<actual.length/4;pixel++){
  const offset=pixel*4,a=actual[offset+3],b=expected[offset+3],delta=Math.abs(a-b);
  alphaSum+=delta;alphaMax=Math.max(alphaMax,delta);
  for(let channel=0;channel<3;channel++){
   const foreground=actual[offset+channel]*a/255,reference=expected[offset+channel]*b/255;
   blackSum+=Math.abs(foreground-reference);
   whiteSum+=Math.abs(foreground+255-a-reference-255+b);
  }
 }
 const pixels=actual.length/4;
 return {alphaMean:alphaSum/pixels,alphaMax,blackMean:blackSum/(pixels*3),whiteMean:whiteSum/(pixels*3)};
}
function canonicalHash(data:Uint8Array){
 const canonical=Buffer.from(data);
 for(let offset=0;offset<canonical.length;offset+=4){
  if(canonical[offset+3]===0)canonical.fill(0,offset,offset+3);
 }
 return sha(canonical);
}
function requireAgreement(report:ReturnType<typeof difference>){
 assert.ok(report.alphaMean<1,`CPU/DirectML alpha difference ${report.alphaMean}/255`);
 assert.ok(report.blackMean<1&&report.whiteMean<1,'CPU/DirectML visible composites differ by at least one byte on average');
}
async function waitForOwnedExit(){
 for(const pid of owned){
  let live=true;
  for(let attempt=0;attempt<40&&live;attempt++){
   try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;live=false;}
   if(live)await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(live,false,`Owned process ${pid} survived`);
 }
}

async function main(){
 const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
 await app.whenReady();assert.equal(BrowserWindow.getAllWindows().length,0);
 const context:EngineContext={ffmpeg:manifest.ffmpeg,ffprobe:manifest.ffprobe,cacheDir:path.join(root,'cache'),diagnostics:observe};
 const ff=(args:string[])=>runProcess(context.ffmpeg,['-v','error','-nostdin','-y',...args],{
  signal:controller.signal,timeoutMs:120000,onSpawn:pid=>observe({event:'qa-ffmpeg-start',pid}),
 });
 const probe=async(file:string)=>JSON.parse((await runProcess(context.ffprobe,[
  '-v','error','-show_streams','-show_frames','-of','json',file,
 ],{signal:controller.signal,timeoutMs:120000,onSpawn:pid=>observe({event:'qa-ffprobe-start',pid})})).stdout.toString());
 const verifyVideoClock=async(file:string,info:any,expectedPts:number[],endPts:number)=>{
  const stream=info.streams.find((value:{codec_type:string})=>value.codec_type==='video');
  assert.equal(stream.time_base,'1/1000000');assert.equal(stream.start_pts,0);assert.equal(stream.duration_ts,endPts);
  const packets=JSON.parse((await runProcess(context.ffprobe,[
   '-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts,duration','-of','json',file,
  ],{signal:controller.signal,timeoutMs:120000,onSpawn:pid=>observe({event:'qa-ffprobe-start',pid})})).stdout.toString()).packets;
  assert.deepEqual(packets.map((packet:{pts:number})=>packet.pts),expectedPts);
  assert.deepEqual(packets.map((packet:{duration:number})=>packet.duration),expectedPts.map((pts,index)=>(expectedPts[index+1]??endPts)-pts));
 };
 const open=async(backend:'cpu'|'dml'|'auto',overrides:Partial<Parameters<typeof MattingProcess.create>[0]>={})=>{
  const engine=await MattingProcess.create({
   modelPath:manifest.models.cpu.file,workerPath:manifest.workerPath,quality:'precision',backend,
   signal:controller.signal,diagnostics:observe,profilePrefix:path.join(root,phase),...overrides,
  });sessions.add(engine);return engine;
 };
 const close=async(engine:MattingProcess)=>{await engine.close();sessions.delete(engine);};
 const processFrame=async(engine:MattingProcess,frame:MattingFrame,pts:number)=>{
  // Reserve one additional native attempt for the deliberately injected retry.
  assert.ok(frameRequests+1<manifest.maximumNativeAttempts);frameRequests++;
  await fs.writeFile(path.join(root,'progress.json'),JSON.stringify({phase,frameRequests,pts}));
  return engine.process(frame,pts);
 };

 // Native720p source, positive absolute origin and delayed stereo PCM. The
 // source itself defines these pixels and times for every compared branch.
 phase='prepare-source';
 const sourceFile=path.join(root,'source-720p.mov');
 await ff([
  '-f','rawvideo','-pixel_format','bgr24','-video_size','1280x720','-framerate','30','-i',manifest.fixture.raw,
  '-f','lavfi','-i','aevalsrc=0.1*sin(2*PI*997*t)|0.05*sin(2*PI*701*t):s=48000:d=0.09',
  '-filter_complex_threads','1','-filter_complex','[0:v]trim=end_frame=4,settb=AVTB,setpts=PTS+3/TB[v];[1:a]asetpts=PTS+3.04/TB[a]',
  '-map','[v]','-map','[a]','-fps_mode','passthrough','-enc_time_base:v','filter',
  '-c:v','ffv1','-level','3','-threads','2','-pix_fmt','bgr0','-color_range','pc','-colorspace','rgb','-color_primaries','bt709','-color_trc','iec61966-2-1',
  '-c:a','pcm_f32le','-video_track_timescale','1000000','-movie_timescale','1000000',sourceFile,
 ]);
 const media=await probeMedia(sourceFile,context,controller.signal,{derivatives:false});
 const source=await prepareTrackingInput(media,4096,context,controller.signal);
 assert.equal(source.plan.origin,3);
 const frames:Array<MattingFrame&{pts:number;inputSha256:string}>=[];
 for await(const frame of decodeTrackingFrames(source.plan,3000000,3100000,context,controller.signal)){
  assert.equal(frame.width,frame.sourceWidth);assert.equal(frame.height,frame.sourceHeight);
  assert.equal(frame.width,1280);assert.equal(frame.height,720);
  frames.push({width:frame.width,height:frame.height,pts:frame.pts,data:Uint8Array.from(frame.data),inputSha256:sha(frame.data)});
 }
 assert.deepEqual(frames.map(frame=>frame.pts),[3000000,3033333,3066667]);
 const outputs:{cpu:MattingOutput[];dml:MattingOutput[]}={cpu:[],dml:[]};
 for(const backend of ['cpu','dml'] as const){
  phase=`sequence-${backend}`;const engine=await open(backend);
  for(const frame of frames){
   const result=await processFrame(engine,frame,frame.pts);assert.equal(result.backend,backend);
   assert.equal(sha(frame.data),frame.inputSha256);outputs[backend].push(result);
  }
  await engine.reset();
  const reset=await processFrame(engine,frames[0],frames[0].pts);
  assert.equal(sha(reset.data),sha(outputs[backend][0].data),'Reset must reproduce the fresh first frame');
  await close(engine);
 }
 for(let index=0;index<frames.length;index++){
  const delta=difference(outputs.dml[index].data,outputs.cpu[index].data);requireAgreement(delta);
  comparisons.push({index,pts:frames[index].pts,inputSha256:frames[index].inputSha256,cpuSha256:sha(outputs.cpu[index].data),dmlSha256:sha(outputs.dml[index].data),...delta});
 }
 checks.push('Native720p three-frame ResNet CPU/DirectML sequences preserve input hashes and PTS, agree in alpha/composites, and reset reproduces fresh outputs');

 // Inject one failure immediately before the second GPU inference. Compare
 // every accepted recurrent tensor's hash and shape across the actual retry.
 const failureWorker=path.join(root,'fail-second-gpu.cjs');
 await fs.writeFile(failureWorker,`
const fs=require('node:fs'),crypto=require('node:crypto'),ort=require('onnxruntime-node');
const traceFile=${JSON.stringify(path.join(root,'fallback-state.json'))},trace={};
const digest=data=>crypto.createHash('sha256').update(new Uint8Array(data.buffer,data.byteOffset,data.byteLength)).digest('hex');
const states=feeds=>[1,2,3,4].map(i=>({dims:[...feeds['r'+i+'i'].dims],sha256:digest(feeds['r'+i+'i'].data),length:feeds['r'+i+'i'].data.length}));
const create=ort.InferenceSession.create.bind(ort.InferenceSession);
ort.InferenceSession.create=async(...args)=>{
 const session=await create(...args),backend=args[1].executionProviders[0],run=session.run.bind(session);let calls=0;
 session.run=async feeds=>{
  if(backend==='dml'&&++calls===2){trace.beforeFailure=states(feeds);fs.writeFileSync(traceFile,JSON.stringify(trace));throw new Error('qa-injected-second-gpu-frame');}
  if(backend==='cpu'&&trace.beforeFailure&&!trace.cpuRetry){trace.cpuRetry=states(feeds);fs.writeFileSync(traceFile,JSON.stringify(trace));}
  return run(feeds);
 };return session;
};
require(${JSON.stringify(manifest.workerPath)});
`);
 phase='auto-fallback';const automatic=await open('auto',{workerPath:failureWorker});
 assert.equal(automatic.backend,'dml');
 const first=await processFrame(automatic,frames[0],frames[0].pts);assert.equal(sha(first.data),sha(outputs.dml[0].data));
 for(let index=1;index<frames.length;index++){
  const result=await processFrame(automatic,frames[index],frames[index].pts);assert.equal(result.backend,'cpu');
  requireAgreement(difference(result.data,outputs.cpu[index].data));
 }
 const fallback=JSON.parse(await fs.readFile(path.join(root,'fallback-state.json'),'utf8'));
 assert.deepEqual(fallback.cpuRetry,fallback.beforeFailure);
 assert.deepEqual(fallback.cpuRetry.map((state:{dims:number[]})=>state.dims[1]),[16,32,64,128]);
 assert.ok(fallback.cpuRetry.every((state:{length:number})=>state.length>1));await close(automatic);
 await fs.rename(path.join(root,'fallback-state.json'),path.join(root,'fallback-state-auto.json'));
 checks.push('Automatic retry uses the same ResNet model and exact accepted GPU recurrent tensor hashes/shapes, then continues sequentially on CPU');
 phase='strict-gpu-failure';const strict=await open('dml',{workerPath:failureWorker});
 await processFrame(strict,frames[0],frames[0].pts);
 await assert.rejects(processFrame(strict,frames[1],frames[1].pts),/qa-injected-second-gpu-frame/);
 await close(strict);
 const strictTrace=JSON.parse(await fs.readFile(path.join(root,'fallback-state.json'),'utf8'));
 assert.equal(strictTrace.cpuRetry,undefined);
 await fs.rename(path.join(root,'fallback-state.json'),path.join(root,'fallback-state-strict.json'));
 checks.push('Explicit GPU mode rejects the injected inference failure');

 const pipelineFrames:Record<string,unknown>[]=[];
 const pipelineContext:PersonCutoutContext={...context,derivedDir:path.join(root,'derived'),createMatting:async(config,signal)=>{
  assert.equal(config.quality,'precision');
  const engine=await open(config.backend??'auto',{quality:config.quality,signal});
  return {get backend(){return engine.backend;},async process(frame,pts){
   const output=await processFrame(engine,frame,pts);
   pipelineFrames.push({phase,pts,width:frame.width,height:frame.height,inputSha256:sha(frame.data),canonicalSha256:canonicalHash(output.data)});
   return output;
  },async close(){await close(engine);}};
 }};
 phase='pipeline-720p';
 const cutout=await removePersonBackground(media,{start:0,duration:.1,device:'gpu',quality:'precision'},pipelineContext,undefined,controller.signal);
 assert.equal(cutout.width,1280);assert.equal(cutout.height,720);assert.equal(cutout.hasAlpha,true);assert.equal(cutout.hasAudio,true);assert.equal(cutout.duration,.1);
 const info=await probe(cutout.path),videoFrames=info.frames.filter((frame:{media_type:string})=>frame.media_type==='video');
 assert.deepEqual(videoFrames.map((frame:{best_effort_timestamp_time:string})=>Math.round(Number(frame.best_effort_timestamp_time)*1e6)),[0,33333,66667]);
 await verifyVideoClock(cutout.path,info,[0,33333,66667],100000);
 const decoded=(await ff(['-threads','1','-i',cutout.path,'-map','0:v:0','-pix_fmt','bgra','-threads','1','-f','rawvideo','pipe:1'])).stdout;
 for(let index=0;index<frames.length;index++){
  const byteLength=1280*720*4,actual=decoded.subarray(index*byteLength,(index+1)*byteLength);
  assert.equal(sha(actual),canonicalHash(outputs.dml[index].data));
  assert.equal(pipelineFrames[index].inputSha256,frames[index].inputSha256);
 }
 assert.equal(decoded.length,1280*720*4*3);
 const expectedAudio=(await ff(['-copyts','-i',sourceFile,'-map','0:a:0','-af','atrim=start=3:end=3.1,asetpts=PTS-round(3/TB)','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
 const actualAudio=(await ff(['-i',cutout.path,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
 assert.ok(expectedAudio.length>0);assert.deepEqual(actualAudio,expectedAudio);
 const firstAudio=info.frames.find((frame:{media_type:string})=>frame.media_type==='audio');assert.equal(Number(firstAudio.best_effort_timestamp_time),.04);
 assert.equal(info.streams.find((stream:{codec_type:string})=>stream.codec_type==='audio').channels,2);
 pipelines.push({name:phase,cutout,frames:pipelineFrames.filter(frame=>frame.phase===phase),audioSha256:sha(actualAudio),audioBytes:actualAudio.length});
 checks.push('Actual precision720p pipeline preserves every canonical BGRA byte, PTS, exact final hold, positive source origin, delayed stereo PCM and native size');

 phase='pipeline-4k';const native=await probeMedia(manifest.fixture.source.file,context,controller.signal,{derivatives:false});
 assert.equal(native.width,3840);assert.equal(native.height,2160);
 const large=await removePersonBackground(native,{start:0,duration:.01,device:'gpu',quality:'precision'},pipelineContext,undefined,controller.signal);
 assert.equal(large.width,3840);assert.equal(large.height,2160);assert.equal(large.duration,.01);assert.equal(large.hasAlpha,true);
 await verifyVideoClock(large.path,await probe(large.path),[0],10000);
 const largeFrames=pipelineFrames.filter(frame=>frame.phase===phase);assert.equal(largeFrames.length,1);
 const largePixels=(await ff(['-threads','1','-i',large.path,'-map','0:v:0','-frames:v','1','-pix_fmt','bgra','-threads','1','-f','rawvideo','pipe:1'])).stdout;
 assert.equal(largePixels.length,3840*2160*4);assert.equal(sha(largePixels),largeFrames[0].canonicalSha256);
 pipelines.push({name:phase,cutout:large,frames:largeFrames});
 checks.push('Actual precision4K GPU pipeline processes one native frame and preserves every canonical BGRA byte and exact10ms duration');

 phase='pipeline-cancel';const cancellation=new AbortController();let sent=false;
 const published=(await fs.readdir(pipelineContext.derivedDir!)).sort();
 await assert.rejects(removePersonBackground(media,{start:0,duration:.1,device:'cpu',quality:'precision'},pipelineContext,progress=>{
  if(progress>=.05&&!sent){sent=true;cancellation.abort();}
 },cancellation.signal),{name:'AbortError'});
 assert.equal(sent,true);assert.deepEqual((await fs.readdir(pipelineContext.derivedDir!)).sort(),published);
 checks.push('Cancellation after an actual precision frame removes the partial pipeline output');
 phase='worker-crash';const crashWorker=path.join(root,'crash.cjs');
 await fs.writeFile(crashWorker,`require(${JSON.stringify(manifest.workerPath)});process.parentPort.on('message',({data})=>{if(data.method==='process')process.exit(9);});`);
 const crashed=await open('cpu',{workerPath:crashWorker});
 await assert.rejects(processFrame(crashed,frames[0],frames[0].pts),/종료.*9/);await close(crashed);
 checks.push('Unexpected precision worker exit rejects the request and closes the owned process');

 await requireSourceRevision(sourceFile,source.revision);
 await requireSourceRevision(native.path,native.sourceRevision);
 await waitForOwnedExit();assert.equal(BrowserWindow.getAllWindows().length,0);
 assert.ok(!Object.keys(require.cache).some(file=>/onnxruntime.*(?:binding|index)/i.test(file)));
 const profiles=[];
 for(const file of await fs.readdir(root)){
  if(!/^sequence-(cpu|dml)-(cpu|dml)_.*\.json$/.test(file))continue;
  const events=JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
  const providers:Record<string,number>={},core:Record<string,number>={},coreNames=new Set<string>();
  for(const event of events){
   const provider=event.args?.provider,operation=String(event.args?.op_name??'');if(!provider)continue;
   providers[provider]=(providers[provider]??0)+1;
   if(/Conv/.test(operation)&&!String(event.name).startsWith('slu_')){
    core[provider]=(core[provider]??0)+1;coreNames.add(String(event.name));
   }
  }
  profiles.push({file,providers,coreConvolutionEvents:core,coreConvolutionNodes:[...coreNames]});
 }
 assert.ok(profiles.some(profile=>(profile.coreConvolutionEvents.CPUExecutionProvider??0)>20));
 assert.ok(profiles.some(profile=>(profile.coreConvolutionEvents.DmlExecutionProvider??0)>20),'Profile must place model convolution kernels on DirectML');
 checks.push('ORT profiles place original model convolution kernels on DirectML, beyond byte adapter or copy operations');
 checks.push('All owned workers/decoders/encoders exited, zero BrowserWindows, and parent loaded no native inference binding');
 await fs.writeFile(path.join(root,'results.json'),JSON.stringify({
  frameRequests,automaticRetryCount:1,nativeAttemptUpperBound:frameRequests+1,checks,comparisons,pipelines,fallback,profiles,diagnostics,
  modelSha256:manifest.models.cpu.sha256,gpuModelSha256:manifest.models.dml.sha256,workerSha256:manifest.workerSha256,
  version:manifest.version,buildReceiptId:manifest.buildReceiptId,
  scope:manifest.scope,distribution:manifest.distribution,
 },null,2));
}
main().then(()=>{clearTimeout(deadline);app.exit(0);},async error=>{
 controller.abort();await Promise.allSettled([...sessions].map(session=>session.close()));clearTimeout(deadline);
 await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({phase,frameRequests,error:String(error),stack:error.stack,checks,comparisons,pipelines,diagnostics},null,2));app.exit(1);
});
