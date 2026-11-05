import * as ort from 'onnxruntime-node';
import {mkdir,writeFile,readFile,access,readdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve('.test-artifacts/matting-adapter',Date.now().toString());await mkdir(root,{recursive:true});
const local=path.resolve('.build-cache/matting/onnx-env/Scripts/python.exe');
const python=process.env.SLU_MODEL_PYTHON||await access(local).then(()=>local,()=> 'python');
const model=path.join(root,'adapter.onnx');
await promisify(execFile)(python,['scripts/prepare-matting-adapter-test.py',model],{windowsHide:true,timeout:60000});
const pixels=16*256,src=Uint8Array.from({length:pixels*3},(_,i)=>i%256),values=[-100,-1,-0,0,1,2,100];
const f=new Float32Array(1),bits=new Uint32Array(f.buffer);
// Every byte boundary and both adjacent Float32 values: random footage rarely
// exercises the rounding error this adapter specifically needs to avoid.
for(let k=1;k<256;k++){f[0]=(k-.5)/255;const b=bits[0];for(const delta of [-1,0,1]){bits[0]=b+delta;values.push(f[0]);}}
const foreground=Float32Array.from({length:pixels*3},(_,i)=>values[i%values.length]);
const alpha=Float32Array.from({length:pixels},(_,i)=>values[(i*7)%values.length]);
const expected=new Uint8Array(pixels*4),normalized=new Float32Array(pixels*3);
for(let p=0;p<pixels;p++){
 for(let c=0;c<3;c++){expected[p*4+c]=Math.round(Math.max(0,Math.min(1,foreground[(2-c)*pixels+p]))*255);normalized[c*pixels+p]=src[p*3+2-c]/255;}
 expected[p*4+3]=Math.round(Math.max(0,Math.min(1,alpha[p]))*255);
}
const checks=[];
for(const backend of ['cpu','dml']){
 const session=await ort.InferenceSession.create(model,{executionProviders:[backend],executionMode:'sequential',enableProfiling:true,profileFilePrefix:path.join(root,'native-'+backend)});
 const feeds={src_bgr:new ort.Tensor('uint8',src,[1,16,256,3]),fgr:new ort.Tensor('float32',foreground,[1,3,16,256]),pha:new ort.Tensor('float32',alpha,[1,1,16,256])};
 try{
  const out=await session.run(feeds);
  try{assert.deepEqual(out.src.data,normalized);assert.deepEqual(out.frame_bgra.data,expected);assert.equal(out.invalid_pixels.data[0],0);}finally{Object.values(out).forEach(t=>t.dispose());}
  checks.push(`${backend}: all 256 input bytes normalize exactly; all 255 quantization boundaries and neighbors match the independent CPU byte oracle`);
  for(const invalid of [NaN,Infinity,-Infinity]){
   foreground[0]=invalid;let rejected=false;
   try{const result=await session.run(feeds);try{rejected=result.invalid_pixels.data[0]!==0;}finally{Object.values(result).forEach(t=>t.dispose());}}catch{rejected=true;}
   assert.ok(rejected,`${backend} must not accept nonfinite foreground ${invalid}`);
  }
  checks.push(`${backend}: NaN and both infinities are rejected or reported invalid`);
  foreground[0]=values[0];const healthy=await session.run(feeds);
  try{assert.equal(healthy.invalid_pixels.data[0],0);assert.deepEqual(healthy.frame_bgra.data,expected);}finally{Object.values(healthy).forEach(t=>t.dispose());}
 }finally{Object.values(feeds).forEach(t=>t.dispose());session.endProfiling();await session.release();foreground[0]=values[0];}
}
const profiles=[];
for(const name of await readdir(root))if(name.startsWith('native-')){
 // The extracted model contains only adapter nodes; DirectML may fuse them
 // into DmlFusedNode partitions rather than preserve each source node name.
 const events=JSON.parse(await readFile(path.join(root,name),'utf8')),ops=events.filter(e=>e.args?.provider);
 profiles.push({name,providers:[...new Set(ops.map(e=>e.args.provider))],nodes:[...new Set(ops.map(e=>e.name))]});
 if(name.startsWith('native-dml')){assert.ok(ops.length>0);assert.ok(ops.every(e=>e.args.provider==='DmlExecutionProvider'),'Every adapter node must execute on the GPU');}
}
await writeFile(path.join(root,'results.json'),JSON.stringify({root,scope:'Actual shipped ONNX adapter nodes, native CPU/DirectML; boundary math and provider placement, not RVM quality or UI playback.',checks,profiles},null,2));
console.log(JSON.stringify({root,checks,profiles}));
