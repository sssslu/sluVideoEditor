import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {EnhancementProcess,type EnhancementProcessOptions} from '../electron/enhancement-process';

const prepared=await fs.readFile(path.resolve('.build-cache/enhancement/prepared-runtime.json'),'utf8').then(JSON.parse).catch(()=>null) as {pythonExecutable:string;runtimeRoot:string}|null;
const available=!!prepared&&await fs.stat(prepared.pythonExecutable).then(stat=>stat.isFile(),()=>false);
const workerSource=(mode:string)=>`
import hashlib,json,os,sys
mode=${JSON.stringify(mode)}
config=None
pending=[]
emitted=0
for line in sys.stdin:
    request=json.loads(line)
    identity=request['id']
    method=request['method']
    if method=='init':
        config=request['config']
        if mode=='malformed':
            print('invalid json',flush=True)
            continue
        if mode=='oversized':
            print('X'*70000,flush=True)
            continue
        result={'protocolVersion':1,'backend':'cuda','model':'seedvr2-3b-fp16','inputCapacity':5,'chunkFrames':9,'overlapFrames':4,'outputWidth':config['width']*config['scale'],'outputHeight':config['height']*config['scale']}
        result['hardware']={'inferenceStrategy':'independent-frames-v1','modelTemporalFrames':1,'transportWindowFrames':9,'overlapReuseFrames':4}
        if mode=='wrong-id': identity+=1
        if mode=='wrong-init': result['backend']='cpu'
        if mode=='missing-strategy': result.pop('hardware')
        if mode=='temporal-strategy': result['hardware']['inferenceStrategy']='temporal-windows-v1'
        if mode=='wrong-model-frames': result['hardware']['modelTemporalFrames']=9
        if mode=='wrong-transport-window': result['hardware']['transportWindowFrames']=13
        if mode=='wrong-overlap-reuse': result['hardware']['overlapReuseFrames']=0
    elif method=='process':
        if mode=='hang': continue
        if mode=='exit': os._exit(7)
        pending.extend(request['pts'])
        count=len(pending) if request['last'] else max(0,len(pending)-4)
        pts=pending[:count]
        pending=pending[count:]
        width=config['width']*config['scale']
        height=config['height']*config['scale']
        filename=('output-'+str(emitted).zfill(9)+'.bgra') if count else None
        data=bytes([20,40,60,255])*(width*height*count)
        if filename:
            with open(filename,'wb') as output: output.write(data)
        result={'outputFirstFrame':emitted,'frameCount':count,'pts':pts,'outputFile':filename,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest() if count else None,'width':width,'height':height,'complete':request['last']}
        if mode=='bad-pts' and count: result['pts'][0]+=1
        if mode=='bad-hash' and count: result['sha256']='0'*64
        if mode=='bad-file' and count: result['outputFile']='../output.bgra'
        if mode=='bad-bytes': result['bytes']+=1
        emitted+=count
    elif method=='close':
        print(json.dumps({'id':identity,'result':{'closed':True}}),flush=True)
        break
    print(json.dumps({'id':identity,'result':result}),flush=True)
`;
async function fixture(mode='normal',signal?:AbortSignal) {
  assert.ok(prepared);
  const parent=path.resolve('.test-artifacts/enhancement-process-unit');await fs.mkdir(parent,{recursive:true});
  const directory=await fs.mkdtemp(path.join(parent,'case-')),workerPath=path.join(directory,'worker.py'),diagnostics:Record<string,unknown>[]=[];
  await fs.writeFile(workerPath,workerSource(mode));
  const options:EnhancementProcessOptions={pythonExecutable:prepared.pythonExecutable,workerPath,runtimeRoot:prepared.runtimeRoot,jobDirectory:directory,width:2,height:2,scale:2,maximumFrames:10,maximumBytes:120,signal,diagnostics:event=>diagnostics.push(event),requestTimeoutMs:1500};
  return {directory,options,diagnostics};
}
function assertExited(events:Record<string,unknown>[]) {
  const start=events.find(event=>event.event==='enhancement-worker-start'),exit=events.find(event=>event.event==='enhancement-worker-exit');
  assert.ok(start&&exit);assert.equal(start.pid,exit.pid);
  assert.throws(()=>process.kill(Number(start.pid),0),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ESRCH');
}

test('transport commits overlap frames and exact PTS, flushes the tail, and closes only its worker',{skip:!available},async()=>{
  const f=await fixture(),engine=await EnhancementProcess.create(f.options);
  try {
    const first=await engine.process('input-000000000.bgr',[0,33333,66667,100000,133333],false);
    assert.equal(first.frameCount,1);assert.deepEqual(first.pts,[0]);
    const second=await engine.process('input-000000005.bgr',[166667,200000,233333,266667,300000],false);
    assert.equal(second.frameCount,5);assert.deepEqual(second.pts,[33333,66667,100000,133333,166667]);
    const final=await engine.process(null,[],true);
    assert.equal(final.frameCount,4);assert.deepEqual(final.pts,[200000,233333,266667,300000]);assert.equal(final.complete,true);
    await assert.rejects(engine.process(null,[],true),/순서/);
  } finally {await engine.close();}
  assertExited(f.diagnostics);
});

test('transport rejects malformed or mismatched initialization and cleans up',{skip:!available},async()=>{
  for(const mode of ['malformed','oversized','wrong-id','wrong-init','missing-strategy','temporal-strategy',
    'wrong-model-frames','wrong-transport-window','wrong-overlap-reuse']) {
    const f=await fixture(mode);
    await assert.rejects(EnhancementProcess.create(f.options));assertExited(f.diagnostics);
  }
});

test('independent-frame initialization retains exact fifteen-frame VFR transport cadence',{skip:!available},async()=>{
  const f=await fixture();f.options.maximumFrames=15;f.options.maximumBytes=180;
  const engine=await EnhancementProcess.create(f.options);
  const pts=[0,17000,50000,51000,130000,175000,210000,270000,280000,400000,420000,440000,500000,570000,630000];
  const batches=[];
  try {
    for(let first=0;first<15;first+=5)batches.push(await engine.process(`input-${String(first).padStart(9,'0')}.bgr`,pts.slice(first,first+5),first===10));
    assert.deepEqual(batches.map(batch=>batch.frameCount),[1,5,9]);
    assert.deepEqual(batches.flatMap(batch=>batch.pts),pts);
    const ready=f.diagnostics.find(event=>event.event==='enhancement-worker-ready');
    assert.deepEqual(ready?.hardware,{inferenceStrategy:'independent-frames-v1',modelTemporalFrames:1,transportWindowFrames:9,overlapReuseFrames:4});
  } finally {await engine.close();}
  assertExited(f.diagnostics);
});

test('transport rejects modified PTS, sizes, paths and output hashes before accepting output',{skip:!available},async()=>{
  for(const mode of ['bad-pts','bad-bytes','bad-file','bad-hash','exit']) {
    const f=await fixture(mode),engine=await EnhancementProcess.create(f.options);
    try {await assert.rejects(engine.process('input-000000000.bgr',[0,33333,66667,100000,133333],true));}
    finally {await engine.close();}
    assertExited(f.diagnostics);
  }
});

test('transport timeout and cancellation stop a hung owned worker',{skip:!available},async()=>{
  for(const cancel of [false,true]) {
    const controller=new AbortController(),f=await fixture('hang',controller.signal),engine=await EnhancementProcess.create(f.options);
    try {
      const pending=engine.process('input-000000000.bgr',[0,33333,66667,100000,133333],false);
      if(cancel)controller.abort();
      await assert.rejects(pending);
    } finally {await engine.close();}
    assertExited(f.diagnostics);
  }
});

test('invalid input and concurrent calls are rejected without consuming the valid request',{skip:!available},async()=>{
  const f=await fixture(),engine=await EnhancementProcess.create(f.options);
  try {
    await assert.rejects(engine.process('../input.bgr',[0,1,2,3,4],false));
    await assert.rejects(engine.process('input-000000000.bgr',[0,1,1,3,4],false));
    const first=engine.process('input-000000000.bgr',[0,1,2,3,4],false);
    await assert.rejects(engine.process('input-000000005.bgr',[5,6,7,8,9],false));
    assert.equal((await first).frameCount,1);
    assert.equal((await engine.process(null,[],true)).frameCount,4);
  } finally {await engine.close();}
  assertExited(f.diagnostics);
});
