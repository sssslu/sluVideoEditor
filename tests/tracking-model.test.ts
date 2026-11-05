import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ObjectTracker,type TrackingInferenceFactory} from '../electron/tracking-model';
import {trackingInput,trackingOutput,assertTrackingFrame,assertTrackingBox,type TrackingMaps,type TrackingFrame,type TrackingBox} from '../electron/tracking-math';

const frame=(width=64,height=64):TrackingFrame=>({width,height,data:Uint8Array.from({length:width*height*3},(_,i)=>(i*29+(i>>5)*71)%256)});
const options={modelPath:path.resolve('resources/models/object-tracking-vit.onnx')};
const maps=():TrackingMaps=>{const confidence=new Float32Array(256),size=new Float32Array(512).fill(.25),offset=new Float32Array(512).fill(.5);confidence[8*16+8]=.9;return {confidence,size,offset};};
const hash=(array:Float32Array)=>createHash('sha256').update(new Uint8Array(array.buffer,array.byteOffset,array.byteLength)).digest('hex');

test('tracking crop uses BGR channels, fixed-size buffers and isolated zero borders',()=>{
  const data=new Uint8Array(4*4*3);for(let i=0;i<data.length;i+=3){data[i]=255;data[i+1]=128;data[i+2]=0;}
  const input=trackingInput({width:4,height:4,data},[0,0,4,4],2,128);
  assert.equal(input.crop,8);assert.equal(input.x,-2);assert.equal(input.y,-2);
  const at=(channel:number,y:number,x:number)=>input.data[channel*128*128+y*128+x];
  assert.ok(Math.abs(at(0,0,0)-(-.485/.229))<1e-6);
  assert.ok(Math.abs(at(0,64,64)-(1-.485)/.229)<1e-6);
  assert.ok(Math.abs(at(1,64,64)-(128/255-.456)/.224)<1e-6);
  assert.ok(Math.abs(at(2,64,64)-(-.406/.225))<1e-6);
  assert.equal(input.data.length,3*128*128);
  const huge=frame(4096,16),reused=new Float32Array(3*256*256);
  assert.equal(trackingInput(huge,[0,0,4096,16],4,256,reused).data,reused);
});

test('invalid frame, crop and inference data cannot become tracking coordinates',()=>{
  assert.throws(()=>assertTrackingFrame({...frame(),data:new Uint8Array(1)}));
  assert.throws(()=>assertTrackingFrame({width:16384,height:16384,data:new Uint8Array()}));
  for(const box of [[-1,0,2,2],[0,0,0,2],[63,0,2,2],[0,.5,2,2],[0,0,NaN,2]])assert.throws(()=>assertTrackingBox(box as TrackingBox,64,64));
  const invalid=maps();invalid.offset[3]=NaN;
  assert.throws(()=>trackingOutput(invalid,{crop:64,x:-8,y:-8},64,64,[16,16,16,16]));
  const empty=maps();empty.confidence=new Float32Array(255);
  assert.throws(()=>trackingOutput(empty,{crop:64,x:-8,y:-8},64,64,[16,16,16,16]));
});

test('confidence loss holds the previous box; valid coordinates and review hints remain separate',()=>{
  const previous:TrackingBox=[16,16,16,16],input={crop:64,x:-8,y:-8};
  assert.deepEqual(trackingOutput(maps(),input,64,64,previous).box,[18,18,16,16]);
  const low=maps();low.confidence.fill(.1);const lost=trackingOutput(low,input,64,64,previous);
  assert.equal(lost.status,'lost');assert.deepEqual(lost.box,previous);assert.notEqual(lost.box,previous);
  const review=maps();review.confidence[136]=.45;assert.equal(trackingOutput(review,input,64,64,previous).status,'review');
  const grow=maps();grow.size.fill(.5);assert.equal(trackingOutput(grow,input,64,64,previous).status,'review');
});

test('GPU run failure retries exactly the same anchor/search on CPU and releases both sessions',async()=>{
  const inputs:Array<{backend:string;template:string;search:string}>=[],closed:string[]=[],backends:string[]=[];
  const factory:TrackingInferenceFactory=async backend=>({async infer(template,search){inputs.push({backend,template:hash(template),search:hash(search)});if(backend==='dml')throw new Error('injected device removal');return maps();},async close(){closed.push(backend);}});
  const tracker=await ObjectTracker.create({...options,onBackend:backend=>backends.push(backend)},factory);
  try{
    const f=frame();tracker.anchor(f,[16,16,16,16]);assert.deepEqual((await tracker.update(f)).box,[18,18,16,16]);
    assert.equal(tracker.backend,'cpu');assert.deepEqual(inputs.map(({backend,...i})=>i),[inputs[0],inputs[0]].map(({backend,...i})=>i));
    assert.deepEqual((await tracker.update(f)).box,[20,20,16,16]);assert.equal(inputs.length,3);
  }finally{await tracker.close();await tracker.close();}
  assert.deepEqual(closed,['dml','cpu']);assert.deepEqual(backends,['dml','cpu']);
});

test('GPU initialization fallback is automatic only in auto mode',async()=>{
  const opened:string[]=[],factory:TrackingInferenceFactory=async backend=>{opened.push(backend);if(backend==='dml')throw new Error('unsupported adapter');return {async infer(){return maps();},async close(){}};};
  const tracker=await ObjectTracker.create(options,factory);assert.equal(tracker.backend,'cpu');await tracker.close();
  await assert.rejects(ObjectTracker.create({...options,backend:'dml'},factory),/unsupported adapter/);
  assert.deepEqual(opened,['dml','cpu','dml']);
});

test('failed or concurrent updates cannot overwrite the anchor or accepted position',async()=>{
  let finish!:()=>void,fail=true;
  const factory:TrackingInferenceFactory=async()=>({async infer(){if(fail){fail=false;throw new Error('one failure');}await new Promise<void>(resolve=>{finish=resolve;});return maps();},async close(){}});
  const tracker=await ObjectTracker.create({...options,backend:'cpu'},factory),f=frame();
  tracker.anchor(f,[16,16,16,16]);await assert.rejects(tracker.update(f),/one failure/);
  assert.throws(()=>tracker.anchor(f,[-1,0,16,16]));
  const pending=tracker.update(f);
  await assert.rejects(tracker.update(f),/처리 중/);assert.throws(()=>tracker.anchor(f,[1,1,16,16]),/처리 중/);
  await assert.rejects(tracker.close(),/처리 후/);finish();assert.deepEqual((await pending).box,[18,18,16,16]);
  await tracker.close();await assert.rejects(tracker.update(f),/닫혔/);
});

test('native CPU model can re-anchor; black-frame loss does not advance the object',async()=>{
  const tracker=await ObjectTracker.create({...options,backend:'cpu'}),f=frame(128,96),box:TrackingBox=[30,20,40,40];
  try{
    await assert.rejects(tracker.update(f),/지정/);tracker.anchor(f,box);
    const normal=await tracker.update(f);assert.ok(Number.isFinite(normal.score));assertTrackingBox(normal.box,f.width,f.height);
    await assert.rejects(tracker.update(frame(64,64)),/크기/);
    tracker.anchor(f,box);const lost=await tracker.update({width:128,height:96,data:new Uint8Array(128*96*3)});
    assert.equal(lost.status,'lost');assert.deepEqual(lost.box,box);
    // Procedural noise is not a recognizable object. Check re-anchor state
    // against a fresh session; accuracy belongs to the real-video GT gate.
    tracker.anchor(f,[50,30,25,25]);const restored=await tracker.update(f);
    const fresh=await ObjectTracker.create({...options,backend:'cpu'});
    try{fresh.anchor(f,[50,30,25,25]);assert.deepEqual(restored,await fresh.update(f));}finally{await fresh.close();}
    assertTrackingBox(restored.box,128,96);
  }finally{await tracker.close();}
});
