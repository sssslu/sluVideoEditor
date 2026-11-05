import {promises as fs,createReadStream,appendFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {reverseMedia,type ReverseContext} from '../electron/reverse';
import {probeMedia,runProcess,detectEncoders} from '../electron/media';

// Run alone. Compare the complete CPU-decode and automatic modes, including
// their different default reorder budgets. This is not a UI/VRAM benchmark.
const root=path.resolve('.test-artifacts/reverse-performance'),version=JSON.parse(await fs.readFile('package.json','utf8')).version;
await fs.mkdir(root,{recursive:true});
const base:ReverseContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),derivedDir:path.join(root,'derived')};
const ff=(args:string[])=>runProcess(base.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:180000,maxOutputBytes:16*1024*1024});
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const files=['electron/reverse.ts','electron/reverse-frames.ts','electron/media.ts','electron/media-timing.ts','electron/video-color.ts','scripts/benchmark-reverse-gpu.ts','scripts/measure-process-memory.ps1'];
const hash=async(file:string)=>{const value=createHash('sha256');for await(const block of createReadStream(file))value.update(block);return value.digest('hex');};
const sourceHashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,await hash(file)]))),reports=[];
assert.ok((await detectEncoders(base)).includes('h264_nvenc'),'This comparison requires NVENC');
for(const [width,height,seconds]of [[1920,1080,12],[3840,2160,6]]){
  const source=path.join(root,`source-gpu-${width}.mp4`),bars="geq=lum='if(lt(Y,16)*lt(X,320),if(mod(floor(N/pow(2,floor(X/32))),2),235,16),p(X,Y))':cb='if(lt(Y,8)*lt(X,160),128,p(X,Y))':cr='if(lt(Y,8)*lt(X,160),128,p(X,Y))'";
  await ff(['-f','lavfi','-i',`testsrc2=size=${width}x${height}:rate=24:duration=${seconds}`,'-f','lavfi','-i',`sine=frequency=733:sample_rate=48000:duration=${seconds}`,'-vf',bars,'-c:v','h264_nvenc','-preset','p3','-rc','constqp','-qp','12','-g','48','-bf','3','-c:a','aac','-shortest',source]);
  const media=await probeMedia(source,base,undefined,{derivatives:false}),sourceHash=await hash(source),start=.137123,duration=seconds-.5;
  const times=JSON.parse((await runProcess(base.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',source])).stdout.toString()).frames.map((f:any)=>Number(f.best_effort_timestamp_time));
  const first=times.reduce((last:number,time:number,i:number)=>time<=start?i:last,0),expected=times.flatMap((time:number,i:number)=>i>=first&&time<start+duration?[i]:[]).reverse(),runs:Array<{decoder:'auto'|'cpu';elapsedSeconds:number;[key:string]:unknown}>=[];
  for(const decoder of ['auto','cpu','cpu','auto','auto','cpu'] as const){
    const owned=new Set<number>(),events:Record<string,unknown>[]=[],samples:Array<{seconds:number;processes:Array<{id:number;workingSetBytes:number;peakWorkingSetBytes:number}>;nodeRss:number}>=[];
    const audit=await fs.mkdtemp(path.join(root,'memory-audit-')),pidFile=path.join(audit,'pids.txt'),stopFile=path.join(audit,'stop');await fs.writeFile(pidFile,'');
    let readyResolve!:()=>void,readyReject!:(error:unknown)=>void,pending='',monitorFailure:unknown,peakNodeBytes=process.memoryUsage().rss;
    const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    const monitor=runProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/measure-process-memory.ps1'),'-PidFile',pidFile,'-StopFile',stopFile,'-OwnerPid',String(process.pid)],{timeoutMs:185000,captureStdout:false,onStdout:chunk=>{
      pending+=chunk.toString();const lines=pending.split(/\r?\n/);pending=lines.pop()||'';
      for(const line of lines){if(!line.trim())continue;try{const entry=JSON.parse(line);if(entry.ready){readyResolve();continue;}const rss=process.memoryUsage().rss;peakNodeBytes=Math.max(peakNodeBytes,rss);samples.push({...entry,nodeRss:rss});}catch(error){monitorFailure=error;readyReject(error);}}
    }}).catch(error=>{monitorFailure=error;readyReject(error);});
    let output,elapsedSeconds=0;const readyTimer=setTimeout(()=>readyReject(new Error('Memory monitor did not become ready')),10000);
    try{
      await ready;clearTimeout(readyTimer);const began=performance.now();
      output=await reverseMedia(media,{start,duration},{...base,reverseDecoder:decoder,diagnostics:event=>{events.push({...event,seconds:(performance.now()-began)/1000});if(typeof event.pid==='number'){owned.add(event.pid);appendFileSync(pidFile,event.pid+'\n');}}});
      elapsedSeconds=(performance.now()-began)/1000;
    }finally{clearTimeout(readyTimer);await fs.writeFile(stopFile,'stop');await monitor;}
    if(monitorFailure)throw monitorFailure;
    const raw=(await ff(['-i',output.path,'-map','0:v:0','-vf','crop=320:16:0:0','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
    const codes=Array.from({length:raw.length/(320*16*3)},(_,frame)=>{let code=0;for(let bit=0;bit<10;bit++)if(raw[(frame*320*16+5*320+bit*32+16)*3]>128)code|=1<<bit;return code;});
    assert.deepEqual(codes,expected);assert.ok(Math.abs(output.duration-duration)<.00003);assert.equal(await hash(source),sourceHash);assert.deepEqual([...owned].filter(alive),[]);
    const plan=events.find(e=>e.event==='reverse-plan')!,encoded=events.find(e=>e.event==='reverse-encoded')!;
    assert.equal(encoded.encoder,'h264_nvenc');assert.equal(encoded.decoder,decoder==='auto'?'cuda':'cpu');assert.ok(Number(plan.bufferBytes)<=Number(plan.budgetBytes));assert.ok(Number(encoded.parts)>1);assert.ok(samples.length>=3);assert.ok(!events.some(e=>String(e.event).includes('fallback')));
    if(decoder==='auto')assert.ok(events.some(e=>e.event==='reverse-process'&&e.phase==='frames'&&e.decoder==='cuda'));
    const peakBytes=Math.max(...samples.map(s=>s.processes.reduce((sum,p)=>sum+p.workingSetBytes,0))),processPeaks:Record<string,number>={};
    for(const sample of samples)for(const p of sample.processes)processPeaks[p.id]=Math.max(processPeaks[p.id]||0,p.peakWorkingSetBytes);
    assert.ok(peakBytes<2*1024**3,'Unexpected owned-process working set growth');
    runs.push({decoder,elapsedSeconds,framesPerSecond:codes.length/elapsedSeconds,peakOwnedWorkingSetBytes:peakBytes,peakObservedProcessWorkingSets:processPeaks,peakNodeRssBytes:peakNodeBytes,plan,encoded,events,samples,output});
    console.log(JSON.stringify({width,decoder,elapsedSeconds,parts:encoded.parts,peakOwnedWorkingSetBytes:peakBytes}));
  }
  const median=(decoder:string)=>runs.filter(r=>r.decoder===decoder).map(r=>r.elapsedSeconds).sort((a,b)=>a-b)[1];
  reports.push({width,height,sourceSeconds:seconds,start,duration,frames:expected.length,medianCpuSeconds:median('cpu'),medianCudaSeconds:median('auto'),sourceHash,runs});
}
for(const [file,expected]of Object.entries(sourceHashes))assert.equal(await hash(file),expected);
const result={version,passed:true,recordedAt:new Date().toISOString(),scope:'This PC; synthetic 1080p/4K24 SDR; three interleaved runs each of CPU decode/128MiB and CUDA scan/decode/reorder/256MiB, both NVENC. Working sets sampled by persistent PowerShell at 50ms plus query overhead. PeakWorkingSet64 is observed only for still-running owned processes; no VRAM, whole-app or UI speed claim.',sourceHashes,reports};
await fs.writeFile(path.join(root,'results.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(reports.map(({width,height,duration,frames,medianCpuSeconds,medianCudaSeconds})=>({width,height,duration,frames,medianCpuSeconds,medianCudaSeconds})),null,2));
