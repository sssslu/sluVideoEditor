import {app} from 'electron';
import {promises as fs,appendFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {trackMedia,type TrackingContext} from '../electron/tracking';
import {TrackingProcess} from '../electron/tracking-process';
import {runProcess} from '../electron/media';
import {MotionFileReader} from '../electron/tracking-file';
import {fileDigests} from '../electron/file-digest';
import type {MediaAsset} from '../shared/types';

const root=process.env.SLU_TRACKING_BENCH_ROOT!,label=process.env.SLU_TRACKING_BENCH_LABEL!,sessions:TrackingProcess[]=[];
app.setPath('userData',path.join(root,'profile'));
async function main(){
  await app.whenReady();const fixture=JSON.parse(await fs.readFile('.test-artifacts/tracking-stress-fixtures/fixtures.json','utf8')),reports:Record<string,unknown>[]=[];
  const sources=['electron/tracking.ts','electron/tracking-buffer.ts','electron/tracking-decode.ts','electron/tracking-process.ts','electron/tracking-model.ts','electron/tracking-source.ts','electron/video-frame.ts','electron/probe-interval.ts','scripts/benchmark-tracking-host.ts'];
  const sourceHashes=Object.fromEntries(await Promise.all(sources.map(async file=>[file,createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
  const specifications=process.env.SLU_TRACKING_BENCH_QUICK==='probe'?[{name:'probe',fps:30,start:60,duration:.1,anchor:60,maximum:1280}]:process.env.SLU_TRACKING_BENCH_QUICK==='1'?[{name:'uhd30-middle-1280-a',fps:30,start:60,duration:20,anchor:70,maximum:1280}]:[
    {name:'uhd30-middle-1280-a',fps:30,start:60,duration:20,anchor:70,maximum:1280},
    {name:'uhd30-middle-1920-a',fps:30,start:60,duration:10,anchor:65,maximum:1920},
    {name:'uhd60-middle-1280',fps:60,start:60,duration:10,anchor:65,maximum:1280},
    {name:'uhd30-middle-1920-b',fps:30,start:60,duration:10,anchor:65,maximum:1920},
    {name:'uhd30-middle-1280-b',fps:30,start:60,duration:20,anchor:70,maximum:1280},
    {name:'uhd30-forward-minute',fps:30,start:30,duration:60,anchor:30,maximum:1280}
  ];
  for(const spec of specifications){
    const record=fixture.cases.find((c:{fps:number})=>c.fps===spec.fps),media=record.media as MediaAsset;assert.equal((await fileDigests.read(media.path)).sha256,record.digest.sha256);
    const events:Record<string,unknown>[]=[],samples:Record<string,any>[]=[],pids=new Set<number>(),pidFile=path.join(root,spec.name+'-pids.txt'),stopFile=path.join(root,spec.name+'-stop');await fs.writeFile(pidFile,'');
    let readyResolve!:()=>void,readyReject!:(e:unknown)=>void,pending='',failure:unknown;
    const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    const monitor=runProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/measure-process-memory.ps1'),'-PidFile',pidFile,'-StopFile',stopFile,'-OwnerPid',String(process.pid)],{timeoutMs:300000,captureStdout:false,onStdout:chunk=>{pending+=chunk.toString();const lines=pending.split(/\r?\n/);pending=lines.pop()||'';for(const line of lines)if(line.trim())try{const value=JSON.parse(line);if(value.ready)readyResolve();else samples.push({...value,parentRss:process.memoryUsage().rss});}catch(error){failure=error;readyReject(error);}}}).catch(error=>{failure=error;readyReject(error);});
    const readyTimer=setTimeout(()=>readyReject(new Error('Memory sampler not ready')),10000);let timer:ReturnType<typeof setInterval>|undefined;
    try{
      await ready;clearTimeout(readyTimer);const began=performance.now();let lastTick=began,maxMainGap=0,peakParentRss=process.memoryUsage().rss;
      timer=setInterval(()=>{const now=performance.now();maxMainGap=Math.max(maxMainGap,now-lastTick);lastTick=now;peakParentRss=Math.max(peakParentRss,process.memoryUsage().rss);},10);
      const diagnostics=(event:Record<string,unknown>)=>{const entry={...event,seconds:(performance.now()-began)/1000};events.push(entry);appendFileSync(path.join(root,spec.name+'-events.jsonl'),JSON.stringify(entry)+'\n');if(typeof event.pid==='number'&&!pids.has(event.pid)){pids.add(event.pid);appendFileSync(pidFile,event.pid+'\n');}};
      const ctx:TrackingContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),derivedDir:path.join(root,'derived'),diagnostics,createTracker:async(backend,signal)=>{const tracker=await TrackingProcess.create({backend,signal,modelPath:path.resolve('resources/models/object-tracking-vit.onnx'),workerPath:path.resolve('dist-electron/tracking-worker.cjs'),diagnostics});sessions.push(tracker);return tracker;}};
      if(process.env.SLU_TRACKING_SPOOL!==undefined)Object.assign(ctx,{backwardSpoolBytes:Number(process.env.SLU_TRACKING_SPOOL)});
      const box=fixture.ground[Math.floor((spec.anchor%4)*25)],anchor={time:spec.anchor,box:{x:(box[0]*9+480)/3840,y:box[1]/240,width:box[2]*9/3840,height:box[3]/240}};
      const analysis=await trackMedia(media,{start:spec.start,duration:spec.duration,anchors:[anchor],device:'gpu',maxDimension:spec.maximum},ctx),seconds=(performance.now()-began)/1000;
      assert.equal(analysis.backend,'dml');assert.equal(analysis.frames,spec.duration*spec.fps);assert.equal(analysis.sourceWidth,3840);assert.equal(analysis.sourceHeight,2160);
      const reader=await MotionFileReader.open(analysis.path);let count=0;const recordsHash=createHash('sha256');
      try{while(count<analysis.frames){const page=await reader.samplesFrom(count,4096);for(const sample of page.samples){assert.ok(Math.abs(sample.time-(spec.start+count/spec.fps))<.000002);recordsHash.update(JSON.stringify(sample));count++;}}}finally{await reader.close();}
      const exits=events.filter(e=>e.event==='tracking-decoder-exit'),decoders=events.filter(e=>e.event==='tracking-decoder-start').length;assert.equal(decoders,exits.length);for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
      assert.ok(!(await fs.readdir(ctx.derivedDir!)).some(n=>n.startsWith('.tracking-')));assert.ok(samples.length>1);
      const report={...spec,seconds,frames:count,decodedFrames:exits.reduce((sum,e)=>sum+Number(e.frames),0),decoders,peakParentRss,maxMainGap,recordsSHA256:recordsHash.digest('hex'),peakOwnedWorkingSet:Math.max(...samples.map(s=>s.processes.reduce((sum:number,p:{workingSetBytes:number})=>sum+p.workingSetBytes,0))),analysis,events,samples};reports.push(report);await fs.writeFile(path.join(root,'partial.json'),JSON.stringify({label,sourceHashes,reports},null,2));
    }finally{clearTimeout(readyTimer);clearInterval(timer);await fs.writeFile(stopFile,'stop');await monitor;}if(failure)throw failure;
  }
  for(const [file,hash]of Object.entries(sourceHashes))assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),hash,'Source changed during benchmark');
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({label,version:JSON.parse(await fs.readFile('package.json','utf8')).version,scope:'This PC; padded/upscaled/repeated UHD30/60 H264; DirectML inference, CPU decoding; owned-process working sets, not VRAM or full UI performance. Every returned frame timestamp is checked; this is not an accuracy benchmark.',sourceHashes,reports},null,2));app.exit(0);
}
void main().catch(async error=>{await Promise.allSettled(sessions.map(s=>s.close()));await fs.writeFile(path.join(root,'failure.txt'),error instanceof Error?error.stack||error.message:String(error));app.exit(1);});
