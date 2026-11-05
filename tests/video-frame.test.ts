import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {runProcess} from '../electron/media';
import {presentedFrameTimes} from '../electron/video-frame';
import {spoolReverseFrames} from '../electron/reverse-frames';

test('fresh timestamp probes seek directly and preserve held/adjacent B-frames and reverse spans',async()=>{
  const root=path.resolve('.test-artifacts/probe-interval-regression');await fs.mkdir(root,{recursive:true});
  const file=path.join(root,'long.mp4'),ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:root};
  await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=64x48:r=30:d=120','-c:v','libx264','-threads','1','-g','60','-bf','3',file]);
  const all=(await runProcess(ctx.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time:frame_side_data=','-of','csv=p=0',file])).stdout.toString().split(/\r?\n/).map(line=>line.split(',')[0].trim()).filter(Boolean).map(value=>Math.round(Number(value)*1e6));
  for(let i=0;i<12;i++){
    const time=60.1+i*.137,wanted=Math.round(time*1e6),index=all.reduce((last,t,n)=>t<=wanted?n:last,-1),events:Record<string,unknown>[]=[];
    assert.deepEqual(await presentedFrameTimes(file,0,0,time,{...ctx,diagnostics:e=>events.push(e)}),{time:all[index],previous:all[index-1],next:all[index+1]});
    const starts=events.filter(e=>e.event==='frame-probe-start');assert.equal(starts.length,1,'Seek must not silently fall back to a full source scan');assert.ok(Number(starts[0].seek)>0);
    const target=path.join(root,'reverse.bin'),until=wanted+200000;
    const result=await spoolReverseFrames(file,0,0,wanted,until,target,{...ctx,diagnostics:e=>events.push(e)});
    const expected=all.slice(index).filter(t=>t<until),bytes=await fs.readFile(target);assert.equal(result.count,expected.length);assert.deepEqual(Array.from({length:result.count},(_,n)=>bytes.readDoubleLE(n*8)),expected);
    for(const e of events)if(typeof e.pid==='number')assert.throws(()=>process.kill(e.pid as number,0),{code:'ESRCH'});
  }
});
