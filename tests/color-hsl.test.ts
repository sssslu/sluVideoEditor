import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {HSL_BANDS,adjustHslColor,applyColorPixels,assertColorGrade,hasColorGrade,hslColorLut,lutValues,sampleLut} from '../shared/color';
import {patchColorGrades} from '../shared/color-edits';
import {newProject,newClip,splitClip} from '../shared/project';
import {assertProject} from '../shared/validation';
import {atomicWrite,serializeProject,readProject} from '../electron/project-store';
import type {ColorHsl,MediaAsset} from '../shared/types';

const zero={hue:0,saturation:0,lightness:0};
const near=(actual:number[],expected:number[],epsilon=1e-6)=>actual.forEach((value,index)=>assert.ok(Math.abs(value-expected[index])<=epsilon,`${actual} != ${expected}`));

test('HSL defaults and explicit neutral settings preserve existing byte-exact bypass',()=>{
  const hsl:ColorHsl=Object.fromEntries(HSL_BANDS.map(band=>[band,{...zero}]));
  assert.equal(hslColorLut(undefined),undefined);
  assert.equal(hslColorLut(hsl),undefined);
  assert.equal(hasColorGrade({enabled:true,intensity:1,hsl}),false);
  const pixels=new Uint8ClampedArray([1,2,3,0,71,129,251,128,255,12,9,255]);
  for(const enabled of [true,false]){
    const actual=pixels.slice();applyColorPixels(actual,{enabled,intensity:1,hsl});assert.deepEqual(actual,pixels);
  }
});

test('Six hue bands wrap continuously and use smooth neighboring weights',()=>{
  const colors=[[1,0,0],[1,1,0],[0,1,0],[0,1,1],[0,0,1],[1,0,1]];
  HSL_BANDS.forEach((band,index)=>{
    const input=colors[index];
    near(adjustHslColor({[band]:{...zero,hue:60}},...input as [number,number,number]),colors[(index+1)%6]);
    near(adjustHslColor({[band]:{...zero,hue:-60}},...input as [number,number,number]),colors[(index+5)%6]);
  });
  const settings:ColorHsl={red:{hue:24,saturation:-.2,lightness:.1},magenta:{hue:-15,saturation:.4,lightness:-.2}};
  near(adjustHslColor(settings,1,.0000001,0),adjustHslColor(settings,1,0,.0000001),1e-6);
  near(adjustHslColor({red:{...zero,hue:60}},1,.5,0),[1,1,0]);
});

test('Saturation and lightness keep grays neutral and protect near-gray detail',()=>{
  near(adjustHslColor({red:{...zero,saturation:-1}},1,0,0),[.5,.5,.5]);
  near(adjustHslColor({red:{...zero,lightness:.5}},1,0,0),[1,.5,.5]);
  near(adjustHslColor({red:{...zero,lightness:-.5}},1,0,0),[.5,0,0]);
  const hsl:ColorHsl=Object.fromEntries(HSL_BANDS.map((band,index)=>[band,{hue:index%2?60:-60,saturation:1,lightness:index%2?1:-1}]));
  for(let index=0;index<=255;index++)near(adjustHslColor(hsl,index/255,index/255,index/255),[index/255,index/255,index/255],0);
  near(adjustHslColor(hsl,.501,.5,.5),[.501,.5,.5],.001);
});

test('Generated HSL table is transient, bounded, cached and alpha preserving',()=>{
  const hsl:ColorHsl={red:{hue:30,saturation:-.4,lightness:.2},cyan:{hue:-12,saturation:.3,lightness:-.1}};
  const lut=hslColorLut(hsl)!;
  assert.equal(lut.size,33);assert.equal(lutValues(lut).length,3*33**3);assert.equal(hslColorLut(hsl),lut);
  for(let index=0;index<80;index++){
    const rgb=[index%33/32,(index*7)%33/32,(index*13)%33/32] as [number,number,number];
    near(sampleLut(lut,...rgb),adjustHslColor(hsl,...rgb));
  }
  const pixels=new Uint8ClampedArray(256*4);
  for(let index=0;index<256;index++)pixels.set([index,index,index,index],index*4);
  const expected=pixels.slice();applyColorPixels(pixels,{enabled:true,intensity:1,hsl});assert.deepEqual(pixels,expected);
  const transparent=new Uint8ClampedArray([255,0,0,0,255,0,0,128]);
  applyColorPixels(transparent,{enabled:true,intensity:0,hsl});
  assert.deepEqual([...transparent.subarray(0,4)],[255,0,0,0]);assert.equal(transparent[7],128);assert.notEqual(transparent[5],0);
});

test('HSL schema rejects unknown bands, incomplete settings and invalid numeric ranges',()=>{
  for(const hsl of [[],{orange:zero},{red:{hue:0}},{red:{...zero,hue:61}},{red:{...zero,saturation:NaN}},{red:{...zero,lightness:Infinity}},{red:{...zero,saturation:-1.01}},{red:{...zero,extra:1}}]){
    assert.throws(()=>assertColorGrade({enabled:true,intensity:1,hsl},new Set()));
  }
  assertColorGrade({enabled:true,intensity:0,hsl:{red:zero}},new Set());
});

test('A selected HSL band patch retains other clips bands, locked clips and prior history snapshots',()=>{
  const media:MediaAsset={id:'image',path:'C:/fixture.png',name:'Image',kind:'image',duration:0,width:320,height:180,fps:0,hasAudio:false};
  const original=newProject(),a=newClip('video-1',media),b={...newClip('video-1',media),colorGrade:{enabled:true,intensity:1,hsl:{blue:{...zero,lightness:.2}}}},locked={...newClip('locked',media)};
  const project={...original,media:[media],tracks:[...original.tracks,{id:'locked',name:'Locked',type:'video' as const,hidden:false,muted:false,locked:true}],clips:[a,b,locked]};
  const patched=patchColorGrades(project,new Set(project.clips.map(clip=>clip.id)),{hsl:{red:{...zero,hue:20}}});
  assert.equal(patched.clips[0].colorGrade?.hsl?.red?.hue,20);
  assert.equal(patched.clips[1].colorGrade?.hsl?.blue?.lightness,.2);
  assert.equal(patched.clips[2],locked);assert.equal(project.clips[0].colorGrade,undefined);
  const reset=patchColorGrades(patched,new Set([a.id]),null);assert.equal(reset.clips[0].colorGrade,undefined);
  assert.equal(patched.clips[0].colorGrade?.hsl?.red?.hue,20);
});

test('HSL band values survive split and actual project save/reopen; older projects remain readable',async()=>{
  const media:MediaAsset={id:'image',path:'C:/fixture.png',name:'Image',kind:'image',duration:0,width:320,height:180,fps:0,hasAudio:false};
  let project={...newProject(),media:[media],clips:[newClip('video-1',media)]};
  project=patchColorGrades(project,new Set([project.clips[0].id]),{hsl:{magenta:{hue:-18,saturation:.2,lightness:-.1}}});
  project={...project,clips:splitClip(project.clips[0],2)!};assertProject(project);
  const directory=await mkdtemp(path.join(os.tmpdir(),'slu-hsl-')),file=path.join(directory,'hsl.sluproj');
  await atomicWrite(file,serializeProject(project,true));const reopened=await readProject(file);
  assert.deepEqual(reopened,JSON.parse(JSON.stringify(project)));
  for(const clip of reopened.clips)assert.equal(clip.colorGrade?.hsl?.magenta?.hue,-18);
  assertProject({...newProject(),version:9});
});
