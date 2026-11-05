import {app} from 'electron';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {TrackingProcess} from '../electron/tracking-process';
import {trackMedia,type TrackingContext} from '../electron/tracking';
import {probeMedia} from '../electron/media';
import {MotionFileReader} from '../electron/tracking-file';
import type {MotionSample,MotionAnalysis} from '../shared/tracking';
import type {TrackingObservation} from '../electron/tracking-math';

const root=path.resolve('.test-artifacts/tracking-process'),options={modelPath:path.resolve('resources/models/object-tracking-vit.onnx'),workerPath:path.resolve('dist-electron/tracking-worker.cjs')};
const diagnostics:Record<string,unknown>[]=[],sessions:TrackingProcess[]=[],checks:string[]=[];
const profilePrefix='utility-profile-'+Date.now();
async function main(){
app.setPath('userData',path.join(root,'profile-'+Date.now()));
await app.whenReady();
try{
  await fs.mkdir(root,{recursive:true});
  const fixture=JSON.parse(await fs.readFile('.test-artifacts/tracking-fixtures/david.json','utf8')),file=await fs.open(fixture.raw,'r'),frames=[];
  try{for(let i=0;i<40;i++){const data=Buffer.alloc(fixture.width*fixture.height*3);let offset=0;while(offset<data.length){const read=await file.read(data,offset,data.length-offset,i*data.length+offset);assert.ok(read.bytesRead);offset+=read.bytesRead;}frames.push({width:fixture.width,height:fixture.height,data});}}finally{await file.close();}
  let ticks=0,at=performance.now(),maxDelay=0;const timer=setInterval(()=>{const now=performance.now();maxDelay=Math.max(maxDelay,now-at);at=now;ticks++;},10);
  const results=new Map<string,TrackingObservation[]>();
  try{for(const backend of ['cpu','dml'] as const){
    const tracker=await TrackingProcess.create({...options,backend,profilePrefix:path.join(root,profilePrefix),diagnostics:event=>diagnostics.push(event)});sessions.push(tracker);
    assert.equal(tracker.backend,backend);const rows=[await tracker.anchor(frames[0],fixture.ground[0])];
    for(const frame of frames.slice(1))rows.push(await tracker.update(frame));results.set(backend,rows);
    assert.ok(rows.some((r,i)=>i>0&&r.box[0]!==rows[0].box[0]),'An actual moving object must change its position');
    const again=await tracker.anchor(frames[20],fixture.ground[20]);assert.deepEqual(again.box,fixture.ground[20]);await tracker.update(frames[21]);
    await tracker.close();await tracker.close();await assert.rejects(tracker.update(frames[0]),/종료/);
    checks.push(`Native ${backend} utility process: model, 40 moving frames, re-anchor, idempotent close`);
  }}finally{clearInterval(timer);}
  assert.ok(ticks>10&&maxDelay<250,`Main thread ticks=${ticks}, maximum gap=${maxDelay}ms`);
  const cpu=results.get('cpu')!,gpu=results.get('dml')!;for(let i=0;i<cpu.length;i++)for(let c=0;c<4;c++)assert.ok(Math.abs(cpu[i].box[c]-gpu[i].box[c])<=1);
  checks.push('Main-thread timer remains responsive while native CPU/GPU inference agrees');

  const control=new AbortController(),cancelled=await TrackingProcess.create({...options,backend:'cpu',signal:control.signal,diagnostics:event=>diagnostics.push(event)});sessions.push(cancelled);
  await cancelled.anchor(frames[0],fixture.ground[0]);const pending=cancelled.update(frames[1]),rejected=assert.rejects(pending,{name:'AbortError'});control.abort();await rejected;await cancelled.close();
  checks.push('Cancellation during an in-flight frame rejects once and waits for owned process exit');

  const stalled=path.join(root,'stalled.cjs');await fs.writeFile(stalled,'setInterval(()=>{},1000);');
  await assert.rejects(TrackingProcess.create({...options,workerPath:stalled,requestTimeoutMs:200,diagnostics:event=>diagnostics.push(event)}),/응답/);
  checks.push('A nonresponding worker times out and is killed without a window');
  const exit=path.join(root,'exit.cjs');await fs.writeFile(exit,"process.parentPort.on('message',({data})=>{if(data.method==='open')process.parentPort.postMessage({id:data.id,result:{backend:'cpu'}});else process.exit(9);});");
  const crashed=await TrackingProcess.create({...options,workerPath:exit,diagnostics:event=>diagnostics.push(event)});sessions.push(crashed);
  await assert.rejects(crashed.update(frames[0]),/종료.*9/);await crashed.close();checks.push('Unexpected worker exit is contained and rejected without a main-process error dialog');
  const trackingContext:TrackingContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),derivedDir:path.join(root,'derived'),backwardBufferBytes:320*240*3*3,diagnostics:event=>diagnostics.push(event),createTracker:async(backend,signal)=>{const tracker=await TrackingProcess.create({...options,backend,signal,profilePrefix:path.join(root,profilePrefix+'-pipeline'),diagnostics:event=>diagnostics.push(event)});sessions.push(tracker);return tracker;}};
  const media=await probeMedia(path.resolve('.build-cache/tracking/samples/david/david.webm'),trackingContext,undefined,{derivatives:false});
  const anchor=(i:number)=>({time:11.96+i/25,box:{x:fixture.ground[i][0]/320,y:fixture.ground[i][1]/240,width:fixture.ground[i][2]/320,height:fixture.ground[i][3]/240}}),read=async(analysis:MotionAnalysis)=>{const reader=await MotionFileReader.open(analysis.path);try{return (await reader.range(analysis.start,4096)).samples;}finally{await reader.close();}};
  const tracks:Record<string,MotionSample[]>={},pipeline=[];
  for(const device of ['cpu','gpu'] as const){
    const began=performance.now(),result=await trackMedia(media,{start:11.96,duration:4,anchors:[anchor(20),anchor(60)],device},trackingContext),samples=await read(result);tracks[device]=samples;
    assert.equal(samples.length,100);assert.deepEqual(samples.flatMap((s,i)=>s.anchor?[i]:[]),[20,60]);
    let overlap=0;for(let i=0;i<100;i++){assert.ok(Math.abs(samples[i].time-(11.96+i/25))<.000002);const a=samples[i].box,g=fixture.ground[i],b={x:g[0]/320,y:g[1]/240,width:g[2]/320,height:g[3]/240},area=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));overlap+=area/(a.width*a.height+b.width*b.height-area);}
    const meanIoU=overlap/100;assert.ok(meanIoU>.65,device+' real tracking IoU '+meanIoU);pipeline.push({device,seconds:(performance.now()-began)/1000,meanIoU,analysis:result});
    checks.push(`Real ${device} media pipeline: 100 frames, middle anchor, manual re-anchor, backward windows and persistent path`);
  }
  for(let i=0;i<100;i++)for(const property of ['x','y','width','height'] as const)assert.ok(Math.abs(tracks.cpu[i].box[property]-tracks.gpu[i].box[property])*320<=1);
  const crashWorker=path.join(root,'crash-real.cjs');await fs.writeFile(crashWorker,`require(${JSON.stringify(options.workerPath)});let frames=0;process.parentPort.on('message',({data})=>{if(data.method==='update'&&++frames===5)process.exit(9);});`);
  const retry=await trackMedia(media,{start:11.96,duration:4,anchors:[anchor(20),anchor(60)]},{...trackingContext,createTracker:async(backend,signal)=>{const tracker=await TrackingProcess.create({...options,backend,signal,...(backend==='auto'?{workerPath:crashWorker}:{}),diagnostics:event=>diagnostics.push(event)});sessions.push(tracker);return tracker;}});
  assert.equal(retry.backend,'cpu');assert.deepEqual(await read(retry),tracks.cpu);assert.ok(diagnostics.some(e=>e.event==='tracking-process-fallback'));
  checks.push('A real worker exit after five updates restarts the whole media analysis and matches the CPU path');
  const decoderStarts=diagnostics.filter(e=>e.event==='tracking-decoder-start'),decoderExits=diagnostics.filter(e=>e.event==='tracking-decoder-exit');assert.equal(decoderStarts.length,decoderExits.length);
  for(const event of decoderStarts)assert.throws(()=>process.kill(Number(event.pid),0),{code:'ESRCH'});
  assert.ok(!(await fs.readdir(trackingContext.derivedDir!)).some(name=>name.startsWith('.tracking-')));
  const started=diagnostics.filter(e=>e.event==='tracking-process-start'),exited=diagnostics.filter(e=>e.event==='tracking-process-exit');assert.equal(started.length,exited.length);
  for(const event of started)assert.throws(()=>process.kill(Number(event.pid),0),{code:'ESRCH'});
  // Importing the controller must not initialize any native inference library
  // in the editor process; it is external and loaded only by the worker.
  assert.ok(!Object.keys(require.cache).some(key=>/onnxruntime.*(?:binding|index)/i.test(key)));
  checks.push('All owned worker PIDs have exited; the parent loaded no ONNX native binding');
  const profiles=[];
  for(const name of await fs.readdir(root)){if(!name.startsWith(profilePrefix))continue;const events=JSON.parse(await fs.readFile(path.join(root,name),'utf8')),providers:Record<string,number>={};for(const event of events)if(event.args?.provider)providers[event.args.provider]=(providers[event.args.provider]||0)+1;profiles.push({name,providers});}
  assert.ok(profiles.some(p=>p.providers.CPUExecutionProvider>0));assert.ok(profiles.some(p=>p.providers.DmlExecutionProvider>0));
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({version:JSON.parse(await fs.readFile('package.json','utf8')).version,checks,ticks,maxDelay,pipeline,diagnostics,profiles},null,2)+'\n');
  app.exit(0);
}catch(error){
  await Promise.allSettled(sessions.map(session=>session.close()));await fs.writeFile(path.join(root,'failure.txt'),String(error instanceof Error?error.stack:error));app.exit(1);
}
}
void main().catch(async error=>{await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'failure.txt'),String(error instanceof Error?error.stack:error));app.exit(1);});
