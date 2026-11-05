import test from 'node:test';
import assert from 'node:assert/strict';
import {TrackingStillService} from '../electron/tracking-source';
import {CancelledError,type EngineContext} from '../electron/media';
import type {MediaAsset} from '../shared/types';
import type {TrackingStill} from '../shared/tracking';
const ctx={ffmpeg:'',ffprobe:'',cacheDir:''} as EngineContext,media={} as MediaAsset;
test('still requests serialize teardown, reject invalid requests without cancellation and use scoped cancel tokens',async()=>{
  const events:string[]=[],release:Map<number,()=>void>=new Map();let active=0,maximum=0;
  const service=new TrackingStillService(ctx,async(_m,time,_max,_ctx,signal)=>{active++;maximum=Math.max(maximum,active);events.push('start '+time);try{await new Promise<void>(resolve=>release.set(time,resolve));if(signal?.aborted)throw new CancelledError();return {time} as TrackingStill;}finally{active--;events.push('end '+time);}});
  const first=service.request('first',media,1);const rejected=assert.rejects(first,{name:'AbortError'});await Promise.resolve();
  assert.throws(()=>service.request('bad',media,NaN));assert.throws(()=>service.request('bad',media,0,99999));assert.deepEqual(events,['start 1']);
  const second=service.request('second',media,2);await Promise.resolve();assert.deepEqual(events,['start 1']);release.get(1)!();await rejected;await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['start 1','end 1','start 2']);service.cancel('first');release.get(2)!();assert.equal((await second).time,2);assert.equal(maximum,1);
  const third=service.request('third',media,3),cancelled=assert.rejects(third,{name:'AbortError'});await new Promise(resolve=>setImmediate(resolve));const close=service.close();release.get(3)!();await cancelled;await close;assert.equal(active,0);assert.throws(()=>service.request('closed',media,0));
});
