import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {reverseMedia,type ReverseContext} from '../electron/reverse';
import {probeMedia,runProcess} from '../electron/media';

// Run alone. Sampled process working sets are observations on this machine,
// not an assertion of the total application's memory usage or editing speed.
const root=path.resolve('.test-artifacts/reverse-performance'),version=JSON.parse(await fs.readFile('package.json','utf8')).version;
await fs.mkdir(root,{recursive:true});
const base:ReverseContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),derivedDir:path.join(root,'derived'),reverseDecoder:'cpu'};
const ff=(args:string[])=>runProcess(base.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:180000,maxOutputBytes:16*1024*1024});
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const files=['electron/reverse.ts','electron/reverse-frames.ts','electron/media.ts','electron/media-timing.ts','electron/video-color.ts','scripts/benchmark-reverse.ts'],hash=async(file:string)=>{const value=createHash('sha256');for await(const block of createReadStream(file))value.update(block);return value.digest('hex');},sourceHashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,await hash(file)]))),reports=[];
for(const [width,height,seconds]of [[1920,1080,12],[3840,2160,6]]){
  const source=path.join(root,`source-${width}.mp4`),bars="geq=lum='if(lt(Y,16)*lt(X,320),if(mod(floor(N/pow(2,floor(X/32))),2),235,16),p(X,Y))':cb='if(lt(Y,8)*lt(X,160),128,p(X,Y))':cr='if(lt(Y,8)*lt(X,160),128,p(X,Y))'";
  await ff(['-f','lavfi','-i',`testsrc2=size=${width}x${height}:rate=24:duration=${seconds}`,'-f','lavfi','-i',`sine=frequency=733:sample_rate=48000:duration=${seconds}`,'-vf',bars,'-c:v','h264_nvenc','-preset','p3','-rc','constqp','-qp','12','-g','48','-bf','3','-c:a','aac','-shortest',source]);
  const media=await probeMedia(source,base,undefined,{derivatives:false}),sourceHash=await hash(source),owned=new Set<number>(),events:Record<string,unknown>[]=[],samples:Array<Record<string,number>>=[];let sampling=true,peakBytes=0,peakNodeBytes=0;
  const began=performance.now(),sampler=(async()=>{while(sampling){const ids=[...owned].filter(alive);peakNodeBytes=Math.max(peakNodeBytes,process.memoryUsage().rss);if(ids.length){const command=`$items = @(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64); ConvertTo-Json -Compress -InputObject $items`,result=await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{timeoutMs:10000});const processes=JSON.parse(result.stdout.toString()||'[]') as Array<{Id:number;WorkingSet64:number}>,bytes=processes.reduce((sum,item)=>sum+item.WorkingSet64,0);peakBytes=Math.max(peakBytes,bytes);samples.push({seconds:(performance.now()-began)/1000,workingSetBytes:bytes,processes:processes.length,nodeRss:process.memoryUsage().rss});}await new Promise(r=>setTimeout(r,250));}})();
  let output,elapsedSeconds=0;const start=.137123,duration=seconds-.5;
  try{output=await reverseMedia(media,{start,duration},{...base,diagnostics:event=>{events.push(event);if(typeof event.pid==='number')owned.add(event.pid);}});elapsedSeconds=(performance.now()-began)/1000;}finally{sampling=false;await sampler;}
  const metadata=JSON.parse((await runProcess(base.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time,duration_time','-of','json',output.path],{timeoutMs:120000})).stdout.toString()).frames;
  const raw=(await ff(['-i',output.path,'-map','0:v:0','-vf','crop=320:16:0:0','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout,codes=Array.from({length:raw.length/(320*16*3)},(_,frame)=>{let code=0;for(let bit=0;bit<10;bit++)if(raw[(frame*320*16+5*320+bit*32+16)*3]>128)code|=1<<bit;return code;});
  const times=JSON.parse((await runProcess(base.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',source])).stdout.toString()).frames.map((f:any)=>Number(f.best_effort_timestamp_time)),first=times.reduce((last:number,time:number,i:number)=>time<=start?i:last,0),expected=times.flatMap((time:number,i:number)=>i>=first&&time<start+duration?[i]:[]).reverse();
  assert.deepEqual(codes,expected);assert.equal(metadata.length,codes.length);assert.ok(Math.abs(output.duration-duration)<.00003);assert.equal(await hash(source),sourceHash);assert.deepEqual([...owned].filter(alive),[]);
  const plan=events.find(e=>e.event==='reverse-plan')!,encoded=events.find(e=>e.event==='reverse-encoded')!;assert.equal(encoded.encoder,'h264_nvenc');assert.ok(Number(plan.bufferBytes)<=128*1024*1024);assert.ok(Number(encoded.parts)>1);assert.ok(samples.length>0);assert.ok(peakBytes<2*1024**3,'Unexpected owned-process memory growth');
  reports.push({width,height,sourceSeconds:seconds,start,duration,frames:codes.length,elapsedSeconds,framesPerSecond:codes.length/elapsedSeconds,peakOwnedWorkingSetBytes:peakBytes,peakNodeRssBytes:peakNodeBytes,plan,encoded,samples,output,sourceHash});
}
for(const [file,expected]of Object.entries(sourceHashes))assert.equal(await hash(file),expected);
const result={version,passed:true,recordedAt:new Date().toISOString(),scope:'This PC; synthetic 1080p/4K24 SDR sources; CPU decode/filter with NVENC encoding. Working sets sampled every ~250ms plus PowerShell overhead; no UI speed claim.',sourceHashes,reports};
await fs.writeFile(path.join(root,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(reports.map(({width,height,duration,frames,elapsedSeconds,peakOwnedWorkingSetBytes,peakNodeRssBytes,encoded})=>({width,height,duration,frames,elapsedSeconds,peakOwnedWorkingSetBytes,peakNodeRssBytes,encoded})),null,2));
