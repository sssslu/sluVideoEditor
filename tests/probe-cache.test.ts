import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,getEventListeners} from 'node:events';
import {PassThrough} from 'node:stream';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {ProbeCache,CancelledError} from '../electron/probe-cache';
import {detectEncoders} from '../electron/media';

function deferred<T>(){
  let resolve!:(value:T)=>void,reject!:(error:Error)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}

for(const cancelled of [0,1])test(`shared probe survives cancellation of caller ${cancelled+1}`,async()=>{
  const cache=new ProbeCache<number>(),job=deferred<number>(),controllers=[new AbortController(),new AbortController()];
  let calls=0,probeSignal:AbortSignal|undefined;
  const load=async(signal:AbortSignal)=>{calls++;probeSignal=signal;return job.promise;};
  const requests=controllers.map(c=>cache.get('source',load,c.signal));await Promise.resolve();assert.equal(calls,1);
  const rejected=assert.rejects(requests[cancelled],CancelledError);controllers[cancelled].abort();await rejected;
  assert.equal(probeSignal!.aborted,false);job.resolve(17);assert.equal(await requests[1-cancelled],17);
  assert.equal(await cache.get('source',load),17);assert.equal(calls,1);
  for(const c of controllers)assert.equal(getEventListeners(c.signal,'abort').length,0);
  controllers[1-cancelled].abort();assert.equal(probeSignal!.aborted,false,'Late cancellation must not invalidate completed work');
});

test('last waiter cancellation stops its probe and a late failure cannot erase the replacement',async()=>{
  const cache=new ProbeCache<number>(),old=deferred<number>(),next=deferred<number>(),a=new AbortController(),b=new AbortController();
  let signal:AbortSignal|undefined,calls=0;
  const load=async(s:AbortSignal)=>{signal=s;calls++;return old.promise;};
  const first=cache.get('source',load,a.signal),second=cache.get('source',load,b.signal);await Promise.resolve();
  let finalSettled=false;void second.catch(()=>{finalSettled=true;});
  const firstCancelled=assert.rejects(first,CancelledError),secondCancelled=assert.rejects(second,CancelledError);
  a.abort();assert.equal(signal!.aborted,false);await firstCancelled;b.abort();assert.equal(signal!.aborted,true);
  const replacement=cache.get('source',async()=>{calls++;return next.promise;});await Promise.resolve();
  assert.equal(finalSettled,false,'The final cancelled caller must wait for native probe cleanup');
  old.reject(new Error('Old process finally closed'));await secondCancelled;assert.equal(finalSettled,true);
  next.resolve(29);assert.equal(await replacement,29);
  assert.equal(await cache.get('source',async()=>{throw new Error('Lost replacement');}),29);assert.equal(calls,2);
});

test('already cancelled requests never start or join work, including a completed cache hit',async()=>{
  const cache=new ProbeCache<number>(),control=new AbortController();control.abort();let calls=0;
  const load=async()=>++calls;
  await assert.rejects(cache.get('source',load,control.signal),CancelledError);assert.equal(calls,0);
  assert.equal(await cache.get('source',load),1);
  await assert.rejects(cache.get('source',load,control.signal),CancelledError);assert.equal(calls,1);
});

test('cancelling before the microtask starts avoids spawning an abandoned probe',async()=>{
  const cache=new ProbeCache<number>(),control=new AbortController();let calls=0;
  const request=cache.get('source',async()=>++calls,control.signal),rejected=assert.rejects(request,CancelledError);
  control.abort();await rejected;await Promise.resolve();assert.equal(calls,0);
  assert.equal(await cache.get('source',async()=>++calls),1);
});

test('failures retry, false and missing metadata cache, and successful entries stay bounded',async()=>{
  const cache=new ProbeCache<unknown>(2);let calls=0;
  await assert.rejects(cache.get('source',async()=>{throw new Error('Probe failed');}),/Probe failed/);
  assert.equal(await cache.get('source',async()=>{calls++;return undefined;}),undefined);
  assert.equal(await cache.get('source',async()=>{throw new Error('Undefined was not cached');}),undefined);
  assert.equal(await cache.get('second',async()=>false),false);
  assert.equal(await cache.get('second',async()=>{throw new Error('False was not cached');}),false);
  await cache.get('third',async()=>3);
  assert.equal(await cache.get('source',async()=>++calls),2);
});

test('eviction never cancels a caller still waiting on its owned probe',async()=>{
  const cache=new ProbeCache<number>(1),pending=deferred<number>();let signal:AbortSignal|undefined;
  const first=cache.get('first',async s=>{signal=s;return pending.promise;});await Promise.resolve();
  assert.equal(await cache.get('second',async()=>2),2);assert.equal(signal!.aborted,false);
  pending.resolve(1);assert.equal(await first,1);assert.equal(await cache.get('second',async()=>3),2);
});

test('encoder discovery shares its real process wrapper while callers cancel independently',async t=>{
  class FakeChild extends EventEmitter {
    stdout=new PassThrough();stderr=new PassThrough();killed=false;
    kill(){this.killed=true;queueMicrotask(()=>this.emit('close',null));return true;}
  }
  const original=childProcess.spawn,children:FakeChild[]=[];
  childProcess.spawn=(()=>{
    const child=new FakeChild();
    children.push(child);return child;
  }) as unknown as typeof childProcess.spawn;syncBuiltinESMExports();
  t.after(()=>{childProcess.spawn=original;syncBuiltinESMExports();});
  const ctx={ffmpeg:'probe-cache-test',ffprobe:'unused',cacheDir:'unused'},a=new AbortController(),b=new AbortController();
  const first=detectEncoders(ctx,a.signal),second=detectEncoders(ctx,b.signal);await Promise.resolve();assert.equal(children.length,1);
  const cancelled=assert.rejects(first,CancelledError);a.abort();await cancelled;assert.equal(children[0].killed,false);
  children[0].stdout.write(' V..... libx264 H.264 software encoder\n');children[0].emit('close',0);
  assert.deepEqual(await second,['libx264']);assert.deepEqual(await detectEncoders(ctx),['libx264']);assert.equal(children.length,1);
});
