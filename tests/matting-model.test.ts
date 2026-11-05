import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {PersonMatting,assertMattingFrame,mattingRatio,type MattingFrame,type MattingInput,type MattingPrediction,type MattingInferenceFactory} from '../electron/matting-model';

const frame=(width=32,height=24):MattingFrame=>({width,height,data:Uint8Array.from({length:width*height*3},(_,i)=>(i*29+(i>>5)*71)%256)});
const options={modelPath:path.resolve('resources/models/person-matting-rvm.onnx')};
const prediction=(input:MattingInput,value=1,channels=[16,20,40,64]):MattingPrediction=>({foreground:input.data.slice(),alpha:new Float32Array(input.width*input.height).fill(.5),states:channels.map(c=>({data:new Float32Array(c).fill(value),dims:[1,c,1,1]}))});

test('matting preserves straight foreground BGR color and partial alpha, and bounds analysis size',async()=>{
 const f=frame(),engine=await PersonMatting.create(options,async()=>({async infer(input,states){assert.equal(states.length,4);assert.equal(input.data[0],Math.fround(f.data[2]/255));assert.equal(input.ratio,1);return prediction(input);},async close(){}}));
 try{const out=await engine.process(f,-40000);for(let i=0;i<f.width*f.height;i++){assert.deepEqual([...out.data.slice(i*4,i*4+3)],[...f.data.slice(i*3,i*3+3)]);assert.equal(out.data[i*4+3],128);}assert.equal(out.pts,-40000);}finally{await engine.close();}
 assert.equal(mattingRatio(3840,2160,'portrait'),Math.fround(512/3840));assert.equal(mattingRatio(1920,1080,'fullbody'),Math.fround(.4));
 assert.equal(mattingRatio(1920,1080,'precision'),mattingRatio(1920,1080,'fullbody'));
 for(const invalid of [{...f,data:new Uint8Array(1)},{...f,width:NaN},{...f,height:1},{width:8192,height:8192,data:new Uint8Array()}])assert.throws(()=>assertMattingFrame(invalid));
});

test('GPU frame failure retries the same RGB and accepted recurrent state on CPU',async()=>{
 const inputs:{backend:string;rgb:number[];memory:number[]}[]=[],closed:string[]=[],backends:string[]=[];let n=0;
 const factory:MattingInferenceFactory=async backend=>({async infer(input,states){inputs.push({backend,rgb:[...input.data],memory:states.map(s=>s.data[0])});if(backend==='dml'&&++n===2)throw new Error('device removed');return prediction(input,7);},async close(){closed.push(backend);}});
 const engine=await PersonMatting.create({...options,onBackend:b=>backends.push(b)},factory);
 try{
  await engine.process(frame(),0);const out=await engine.process(frame(),33333);assert.equal(out.backend,'cpu');assert.deepEqual(inputs[1].memory,[7,7,7,7]);
  assert.deepEqual({...inputs[1],backend:'cpu'},inputs[2]);await engine.process(frame(),66667);assert.deepEqual(inputs[3].memory,[7,7,7,7]);
 }finally{await engine.close();await engine.close();}
 assert.deepEqual(closed,['dml','cpu']);assert.deepEqual(backends,['dml','cpu']);
});

test('only automatic mode falls back; explicit GPU initialization failure is visible',async()=>{
 const opened:string[]=[],factory:MattingInferenceFactory=async backend=>{opened.push(backend);if(backend==='dml')throw new Error('unsupported adapter');return {async infer(input){return prediction(input);},async close(){}};};
 const engine=await PersonMatting.create(options,factory);assert.equal(engine.backend,'cpu');await engine.close();
 await assert.rejects(PersonMatting.create({...options,backend:'dml'},factory),/unsupported adapter/);assert.deepEqual(opened,['dml','cpu','dml']);
});

test('GPU byte input owns its snapshot and retains FP32 recurrent state across fallback',async()=>{
 let calls=0,release!:()=>void;const closed:string[]=[],f=frame(),original=f.data.slice();
 const engine=await PersonMatting.create(options,async backend=>backend==='dml'?{async inferFrame(source,ratio,states){
  assert.equal(ratio,1);assert.deepEqual(states.map(s=>s.data[0]),calls?[7,7,7,7]:[0,0,0,0]);
  if(++calls===2){await new Promise<void>(resolve=>{release=resolve;});assert.deepEqual(source.data,original);throw new Error('device removed');}
  return {bgra:new Uint8Array(source.width*source.height*4).fill(128),valid:true,states:[16,20,40,64].map(c=>({data:new Float32Array(c).fill(7),dims:[1,c,1,1]}))};
 },async close(){closed.push('dml');}}:{async infer(input,states){assert.deepEqual(states.map(s=>s.data[0]),[7,7,7,7]);assert.equal(input.data[0],Math.fround(original[2]/255));return prediction(input,8);},async close(){closed.push('cpu');}});
 try{
  await engine.process(f,0);const pending=engine.process(f,1);f.data.fill(0);release();const out=await pending;assert.equal(out.backend,'cpu');assert.deepEqual([...out.data.slice(0,3)],[...original.slice(0,3)]);
 }finally{await engine.close();}assert.deepEqual(closed,['dml','cpu']);
});

test('GPU nonfinite flag and malformed byte payload cannot commit a timestamp',async()=>{
 let valid=false,badSize=false;
 const engine=await PersonMatting.create({...options,backend:'dml'},async()=>({async inferFrame(source){return {bgra:new Uint8Array(badSize?1:source.width*source.height*4),valid,states:[16,20,40,64].map(c=>({data:new Float32Array(c),dims:[1,c,1,1]}))};},async close(){}}));
 try{await assert.rejects(engine.process(frame(),0),/픽셀/);valid=true;badSize=true;await assert.rejects(engine.process(frame(),0),/크기/);badSize=false;await engine.process(frame(),0);}finally{await engine.close();}
});

test('bad output never commits memory or timestamp; accepted sequence requires ordered times and stable dimensions',async()=>{
 let fail=true;const memory:number[][]=[];
 const engine=await PersonMatting.create({...options,backend:'cpu'},async()=>({async infer(input,states){memory.push(states.map(s=>s.data[0]));const out=prediction(input,9);if(fail)out.alpha[0]=NaN;return out;},async close(){}}));
 try{
  await assert.rejects(engine.process(frame(),100),/픽셀/);fail=false;await engine.process(frame(),100);assert.deepEqual(memory,[[0,0,0,0],[0,0,0,0]]);
  await assert.rejects(engine.process(frame(),100),/순서/);await assert.rejects(engine.process(frame(),99),/순서/);await assert.rejects(engine.process(frame(48),101),/크기/);
  engine.reset();await engine.process(frame(48),-100);assert.deepEqual(memory[2],[0,0,0,0]);
 }finally{await engine.close();}await assert.rejects(engine.process(frame(),200),/닫혔/);
});

test('malformed recurrent tensors cannot enter the next frame',async()=>{
 for(const mutate of [(p:MattingPrediction)=>{p.states[0].data[0]=Infinity;},(p:MattingPrediction)=>{p.states[0].dims=[1,16,2,1];},(p:MattingPrediction)=>{p.states[3].dims=[1,63,1,1];}]){
  const engine=await PersonMatting.create({...options,backend:'cpu'},async()=>({async infer(input){const out=prediction(input);mutate(out);return out;},async close(){}}));
  try{await assert.rejects(engine.process(frame(),0),/기억/);}finally{await engine.close();}
 }
});

test('UHD pixel packing preserves quantization around every byte threshold and rejects nonfinite channels',async()=>{
 const scratch=new Float32Array(1),bits=new Uint32Array(scratch.buffer),values=[-100,-0,0,1,100];
 for(let byte=0;byte<255;byte++){
  scratch[0]=(byte+.5)/255;const center=bits[0];for(const offset of [-1,0,1]){bits[0]=center+offset;values.push(scratch[0]);}
 }
 let invalid:number|undefined;
 const engine=await PersonMatting.create({...options,backend:'cpu'},async()=>({async infer(input){const p=prediction(input);for(let i=0;i<p.alpha.length;i++){p.alpha[i]=values[i%values.length];for(let c=0;c<3;c++)p.foreground[c*p.alpha.length+i]=values[(i+c*11)%values.length];}if(invalid!==undefined)p.foreground[0]=invalid;return p;},async close(){}}));
 try{
  const out=await engine.process(frame(64,16),0),byte=(v:number)=>Math.round(Math.max(0,Math.min(1,Math.fround(v)))*255);
  for(let i=0;i<64*16;i++)assert.deepEqual([...out.data.slice(i*4,i*4+4)],[byte(values[(i+22)%values.length]),byte(values[(i+11)%values.length]),byte(values[i%values.length]),byte(values[i%values.length])]);
  for(const value of [NaN,Infinity,-Infinity]){invalid=value;await assert.rejects(engine.process(frame(64,16),1),/픽셀/);}
 }finally{await engine.close();}
});

test('one in-flight frame owns its copied input; reset, close and concurrent processing are rejected',async()=>{
 let finish!:()=>void,received:Float32Array|undefined;
 const engine=await PersonMatting.create({...options,backend:'cpu'},async()=>({async infer(input){await new Promise<void>(resolve=>{finish=resolve;});received=input.data.slice();return prediction(input);},async close(){}}));
 const f=frame(),first=f.data[2],pending=engine.process(f,0);f.data.fill(0);
 await assert.rejects(engine.process(f,1),/처리 중/);assert.throws(()=>engine.reset(),/처리 중/);await assert.rejects(engine.close(),/처리 후/);
 finish();await pending;assert.equal(received![0],Math.fround(first/255));await engine.close();
});

test('each model variant rejects the other variant recurrent channels without committing state',async()=>{
 for(const quality of ['portrait','fullbody','precision'] as const){
  const channels=quality==='precision'?[16,32,64,128]:[16,20,40,64];
  const wrongChannels=quality==='precision'?[16,20,40,64]:[16,32,64,128];
  let bad=true;const memory:number[][]=[];
  const engine=await PersonMatting.create({...options,backend:'cpu',quality},async()=>({
   async infer(input,states){memory.push(states.map(s=>s.data[0]));return prediction(input,9,bad?wrongChannels:channels);},async close(){}
  }));
  try{await assert.rejects(engine.process(frame(),0),/기억/);bad=false;await engine.process(frame(),0);assert.deepEqual(memory,[[0,0,0,0],[0,0,0,0]]);}finally{await engine.close();}
 }
});

test('ResNet GPU fallback retains its model options, accepted channels and current frame',async()=>{
 const channels=[16,32,64,128],customPath='custom/resnet-original.onnx',customGpuPath='custom/resnet-adapter.onnx';
 const accepted:number[][]=[];let gpuCalls=0;
 const engine=await PersonMatting.create({modelPath:customPath,gpuModelPath:customGpuPath,quality:'precision'},async(backend,received)=>{
  assert.equal(received.modelPath,customPath);assert.equal(received.gpuModelPath,customGpuPath);assert.equal(received.quality,'precision');
  return {async infer(input,states){
   accepted.push(states.map(s=>s.dims[1]));
   if(backend==='dml'&&++gpuCalls===2)throw new Error('GPU lost');
   return prediction(input,7,channels);
  },async close(){}};
 });
 try{
  await engine.process(frame(),0);const output=await engine.process(frame(),1);assert.equal(output.backend,'cpu');
  assert.deepEqual(accepted,[[1,1,1,1],channels,channels]);
 }finally{await engine.close();}
});

test('native model selection enforces the exact supplied path and selected model identity',async()=>{
 const resnetPath=path.resolve('resources/models/person-matting-rvm-resnet50.onnx');
 await assert.rejects(PersonMatting.create({...options,quality:'precision',backend:'cpu'}),/크기/);
 await assert.rejects(PersonMatting.create({modelPath:resnetPath,quality:'fullbody',backend:'cpu'}),/크기/);
 await assert.rejects(PersonMatting.create({modelPath:resnetPath,quality:'precision',backend:'dml',gpuModelPath:options.modelPath}),/크기/);
});

for(const quality of ['portrait','precision'] as const)test(`native ${quality} CPU recurrence survives wrapper disposal and reset reproduces a fresh first frame`,async()=>{
 const modelPath=path.resolve('resources/models',quality==='precision'?'person-matting-rvm-resnet50.onnx':'person-matting-rvm.onnx');
 const f=frame(65,37),engine=await PersonMatting.create({modelPath,quality,backend:'cpu'});
 try{
  const first=await engine.process(f,0);await engine.process(f,30000);await engine.process(f,70000);engine.reset();
  assert.deepEqual((await engine.process(f,0)).data,first.data);engine.reset();assert.equal((await engine.process(frame(80,48),0)).data.length,80*48*4);
 }finally{await engine.close();}
});
