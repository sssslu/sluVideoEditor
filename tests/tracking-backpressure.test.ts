import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {decodeTrackingFrames} from '../electron/tracking-decode';
import {runProcess} from '../electron/media';

test('native decoder idle timer pauses while its consumer owns a frame and cancellation still closes it',async context=>{
  const directory=path.resolve('.test-artifacts/tracking-backpressure',`${Date.now()}-${process.pid}`);
  await fs.mkdir(directory,{recursive:true});
  const source=path.join(directory,'source.mkv');
  const ffmpeg=path.resolve('resources/bin/ffmpeg.exe');
  await runProcess(ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=64x48:r=30:d=2','-c:v','ffv1','-threads','1',source],{timeoutMs:30000});
  const timers=new Set<unknown>();
  const schedule=globalThis.setTimeout,clear=globalThis.clearTimeout;
  context.mock.method(globalThis,'setTimeout',((callback:()=>void,milliseconds?:number,...args:unknown[])=>{
    const timer=schedule(callback,milliseconds,...args);
    if(milliseconds===180000)timers.add(timer);
    return timer;
  }) as typeof setTimeout);
  context.mock.method(globalThis,'clearTimeout',((timer:ReturnType<typeof setTimeout>)=>{
    timers.delete(timer);clear(timer);
  }) as typeof clearTimeout);
  const control=new AbortController();
  let pid=0,received=0;
  await assert.rejects(async()=>{
    for await(const frame of decodeTrackingFrames({file:source,stream:0,origin:0,filter:'null',decoder:[],maxDimension:64},0,2000000,{
      ffmpeg,ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:directory,
      diagnostics:event=>{if(event.event==='tracking-decoder-start')pid=Number(event.pid);},
    },control.signal)){
      received++;assert.equal(frame.data.length,64*48*3);
      assert.equal(timers.size,0,'Decoder idle clock must be suspended during model backpressure');
      await delay(100);
      assert.equal(timers.size,0,'Incoming timestamp diagnostics must not restart the suspended idle clock');
      control.abort();
    }
  },{name:'AbortError'});
  assert.equal(received,1);assert.equal(timers.size,0);
  assert.ok(pid>0);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
