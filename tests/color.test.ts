import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCube,sampleLut,lutValues,encodeLutData,curveEvaluator,curveTable,sampleCurve,applyColorPixels,assertColorGrade,assertColorLut,hasColorGrade} from '../shared/color';
import {addColorLut,patchColorGrades,restoreColorLuts} from '../shared/color-edits';
import {newProject,newClip,splitClip} from '../shared/project';
import {assertProject} from '../shared/validation';
import {serializeProject,readProject,atomicWrite} from '../electron/project-store';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {ColorLut,MediaAsset} from '../shared/types';
const cube=(n=2)=>`TITLE "RGB test"\nLUT_3D_SIZE ${n}\n`+Array.from({length:n**3},(_,i)=>[i%n/(n-1),Math.floor(i/n)%n/(n-1),Math.floor(i/n/n)/(n-1)].join(' ')).join('\n');
const identity=():ColorLut=>({...parseCube(cube()),id:'lut'});
const near=(a:number,b:number,tol=1e-6)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
test('3D cube imports red-fastest rows, BOM, scientific values, comments and both domain conventions',()=>{
  const a=parseCube('\uFEFF# comment\r\n'+cube(3).replace('LUT_3D_SIZE 3','LUT_3D_SIZE 3\nDOMAIN_MIN -1 -2 -3\nDOMAIN_MAX 2 3 4').replace('0 0 0','0e0 0.0 +0 # black'));
  assert.equal(a.name,'RGB test');assert.deepEqual(a.domainMin,[-1,-2,-3]);assert.deepEqual(Array.from(lutValues({...a,id:"a"}).subarray(0,9)),[0,0,0,.5,0,0,1,0,0]);
  assert.deepEqual(parseCube(cube().replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE -1 2')).domainMax,[2,2,2]);
});
test('ambiguous, truncated, excessive, non-finite and mixed 1D cube data is rejected',()=>{
  for(const bad of [cube()+'\n0 0 0',cube().split('\n').slice(0,-1).join('\n'),cube().replace('0 0 0','NaN 0 0'),cube().replace('0 0 0','1e999 0 0'),cube().replace('LUT_3D_SIZE 2','LUT_3D_SIZE 66'),cube()+'\nDOMAIN_MAX 1 1 1',cube().replace('LUT_3D_SIZE 2','LUT_1D_SIZE 2\nLUT_3D_SIZE 2'),cube().replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MIN 0 0 0'),cube().replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2\nDOMAIN_MAX 0 1 1'),cube().replace('LUT_3D_SIZE 2','LUT_3D_SIZE 2\nLUT_3D_INPUT_RANGE 0 1\nDOMAIN_MIN 0 0 0')])assert.throws(()=>parseCube(bad));
});
test('tetrahedral interpolation matches independent sorted-axis barycentric reference in all six sectors',()=>{
  const lut=identity();lut.data=encodeLutData(lutValues(lut).map((_,i)=>((i*71+13)%97)/96));lut.domainMin=[-.2,.1,-.1];lut.domainMax=[.9,.8,1.3];
  for(const v of [[.1,.3,.7],[.1,.7,.3],[.3,.1,.7],[.3,.7,.1],[.7,.1,.3],[.7,.3,.1],[0,0,0],[1,1,1],[.5,.5,.5]]){
    const axes=[0,1,2].sort((a,b)=>v[b]-v[a]),corners=[[0,0,0]],weights=[1-v[axes[0]],v[axes[0]]-v[axes[1]],v[axes[1]]-v[axes[2]],v[axes[2]]];
    for(const axis of axes){const next=[...corners.at(-1)!];next[axis]=1;corners.push(next);}
    const expected=[0,1,2].map(c=>corners.reduce((sum,p,i)=>sum+weights[i]*lutValues(lut)[(p[0]+2*p[1]+4*p[2])*3+c],0)),input=v.map((p,i)=>lut.domainMin[i]+p*(lut.domainMax[i]-lut.domainMin[i]));
    const actual=sampleLut(lut,input[0],input[1],input[2]);actual.forEach((p,i)=>near(p,expected[i]));
  }
});
test('LUT domain edges clamp input, interpolate out-of-range outputs before clipping, and preserve identity',()=>{
  const lut=identity();for(let i=0;i<100;i++){const rgb=[(i*17%101)/100,(i*31%101)/100,(i*47%101)/100];sampleLut(lut,...rgb as [number,number,number]).forEach((x,c)=>near(x,rgb[c]));}
  lut.domainMin=[.2,.2,.2];lut.domainMax=[.8,.8,.8];assert.deepEqual(sampleLut(lut,-1,2,.5),[0,1,.4999999999999999]);
  lut.data=encodeLutData(lutValues(lut).map(v=>v*3-1));sampleLut(lut,.5,.5,.5).forEach(v=>near(v,.5));
});
test('curve interpolation is identity by default, reaches points and never overshoots local extrema',()=>{
  const points=[{x:0,y:.2},{x:.1,y:.9},{x:.6,y:.1},{x:.6002,y:.6},{x:1,y:.4}],f=curveEvaluator(points);
  points.forEach(p=>near(f(p.x),p.y));for(let i=0;i<points.length-1;i++)for(let j=0;j<=100;j++){const value=f(points[i].x+(points[i+1].x-points[i].x)*j/100);assert.ok(value>=Math.min(points[i].y,points[i+1].y)-1e-10&&value<=Math.max(points[i].y,points[i+1].y)+1e-10);}
  for(let i=0;i<=255;i++)near(curveEvaluator()(i/255),i/255);
});
test('master then individual curves use immutable cached 4096-sample tables',()=>{
  const curves={master:[{x:0,y:.1},{x:1,y:.9}],red:[{x:0,y:1},{x:1,y:0}]},table=curveTable(curves);assert.equal(table,curveTable(curves));near(sampleCurve(table,.25,0),.7);near(sampleCurve(table,.25,1),.3);const changed={...curves,red:[{x:0,y:0},{x:1,y:1}]};assert.notEqual(curveTable(changed),table);near(sampleCurve(curveTable(changed),.25,0),.3);
});
test('CPU grade preserves alpha and blends LUT strength after curves; bypass is byte exact',()=>{
  const lut=identity();lut.data=encodeLutData(lutValues(lut).map(v=>1-v));const original=new Uint8ClampedArray([51,102,153,128,1,2,3,0]);const data=original.slice();applyColorPixels(data,{enabled:true,intensity:.5,lutId:'lut'},lut);assert.deepEqual([...data],[128,128,128,128,1,2,3,0]);
  const bypass=original.slice();applyColorPixels(bypass,{enabled:false,intensity:1,lutId:'lut'},lut);assert.deepEqual(bypass,original);assert.equal(hasColorGrade({enabled:true,intensity:0,lutId:'lut'}),false);
});
test('grade and LUT schema reject malformed points, missing assets and uncontrolled arrays',()=>{
  for(const points of [[{x:0,y:0},{x:.5,y:1}],[{x:0,y:0},{x:.2,y:.3},{x:.2,y:.5},{x:1,y:1}],[{x:0,y:NaN},{x:1,y:1}]])assert.throws(()=>assertColorGrade({enabled:true,intensity:1,curves:{master:points}},new Set()));
  assert.throws(()=>assertColorGrade({enabled:true,intensity:1,lutId:'missing'},new Set()));assert.throws(()=>assertColorLut({...identity(),data:Array(25).fill(0)}));
});
test('packed LUT uses little-endian float32 bytes and rejects malformed base64 and non-finite payloads',()=>{
  const expected=Buffer.alloc(12);expected.writeFloatLE(1,0);expected.writeFloatLE(-2,4);expected.writeFloatLE(.5,8);assert.equal(encodeLutData([1,-2,.5]),expected.toString('base64'));
  const lut=identity(),values=lutValues(lut);assert.equal(values,lutValues({...lut}));assert.equal(values.length,24);
  assert.throws(()=>assertColorLut({...lut,data:lut.data.slice(0,-1)+'!'}));assert.throws(()=>assertColorLut({...lut,encoding:'other'}));
  const bad=Buffer.from(lut.data,'base64');bad.writeFloatLE(NaN,0);assert.throws(()=>assertColorLut({...lut,data:bad.toString('base64')}));bad.writeFloatLE(Infinity,0);assert.throws(()=>assertColorLut({...lut,data:bad.toString('base64')}));
});
const asset:MediaAsset={id:'image',path:'C:/fixture.png',name:'Image',kind:'image',duration:0,width:320,height:180,fps:0,hasAudio:false};
test('clipboard restores only required embedded LUTs after cleanup and rejects conflicting or missing assets',()=>{
  const p=newProject(),lut=identity(),clip={...newClip('video-1',asset),colorGrade:{enabled:true,intensity:1,lutId:lut.id}};
  const restored=restoreColorLuts(p,[clip],[lut,{...lut,id:'unused'}]);assert.deepEqual(restored.colorLuts,[lut]);assert.equal(restoreColorLuts(restored,[clip],[lut]),restored);assert.throws(()=>restoreColorLuts(p,[clip],[]));assert.throws(()=>restoreColorLuts(restored,[clip],[{...lut,name:'different'}]));assert.equal(p.colorLuts,undefined);
});
test('multi-selection applies only unlocked visual clips, retaining distinct existing LUT choices',()=>{
  let p=newProject();const a=newClip('video-1',asset),b={...newClip('locked',asset)},text=newClip('text-1'),audio={...newClip('audio-1',asset)};p={...p,media:[asset],tracks:[...p.tracks,{id:'locked',name:'Locked',type:'video',hidden:false,muted:false,locked:true}],clips:[a,b,text,audio]};p=addColorLut(p,identity());const next=patchColorGrades(p,new Set(p.clips.map(c=>c.id)),{lutId:'lut'});assert.equal(next.clips[0].colorGrade?.lutId,'lut');assert.equal(next.clips[1],b);assert.equal(next.clips[2],text);assert.equal(next.clips[3],audio);assertProject(next);
  assert.throws(()=>assertProject({...next,version:4}));assert.equal(p.clips[0].colorGrade,undefined);
});
test('embedded LUT and curve settings survive splitting and actual atomic save/reopen without external LUT path',async()=>{
  let p=addColorLut({...newProject(),media:[asset],clips:[newClip('video-1',asset)]},identity());p=patchColorGrades(p,new Set([p.clips[0].id]),{lutId:'lut',curves:{master:[{x:0,y:.1},{x:1,y:.9}]}});
  const pieces=splitClip(p.clips[0],2);assert.ok(pieces);p={...p,clips:pieces!};assertProject(p);const root=await mkdtemp(path.join(os.tmpdir(),'slu-color-')),file=path.join(root,'embedded.sluproj');await atomicWrite(file,serializeProject(p,true));const read=await readProject(file);assert.deepEqual(read,JSON.parse(JSON.stringify(p)));assert.equal(read.version,10);read.clips.forEach(c=>assert.equal(c.colorGrade?.lutId,'lut'));
});
