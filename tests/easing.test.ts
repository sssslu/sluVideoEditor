import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,splitClip,trimClip,interpolate,newProject} from '../shared/project';
import {audioTrackEnabled,visualTrackEnabled} from '../shared/effects';
import {assertProject} from '../shared/validation';
import type {Easing} from '../shared/types';
test('splitting and repeated trims preserve every easing curve',()=>{
  for(const easing of ['linear','ease-in','ease-out','ease-in-out','hold'] as Easing[]){
    const c={...newClip('text-1'),duration:10,keyframes:[{time:0,x:0,y:50,scale:1,rotation:0,opacity:0,easing},{time:10,x:100,y:-50,scale:2,rotation:90,opacity:1}]};
    const [,right]=splitClip(c,3.2)!;const trimmed=trimClip(right,.6,5.4);
    for(let t=0;t<trimmed.duration;t+=.13){const expected=interpolate(c,t+3.8),actual=interpolate(trimmed,t);for(const k of ['x','y','scale','rotation','opacity'] as const)assert.ok(Math.abs(expected[k]-actual[k])<1e-8,`${easing}: ${k} ${t}`);}
  }
});
test('solo isolates picture and audio independently and respects disabled tracks',()=>{
  const p=newProject();p.tracks[0].solo=true;
  assert.equal(visualTrackEnabled(p,p.tracks[0]),true);assert.equal(visualTrackEnabled(p,p.tracks[2]),false);
  assert.equal(audioTrackEnabled(p,p.tracks[1]),false);p.tracks[0].muted=true;assert.equal(audioTrackEnabled(p,p.tracks[0]),false);
});
test('new image processing parameters are bounded before reaching a shader or filtergraph',()=>{
  const p=newProject();p.clips=[newClip('text-1')];
  for(const patch of [{crop:{left:.6,right:.6,top:0,bottom:0}},{chromaKey:{enabled:true,color:'#ffffff',similarity:1,smoothness:0}},{mask:{type:'ellipse',x:.5,y:.5,width:1,height:1,feather:NaN,invert:false}}])assert.throws(()=>assertProject({...p,clips:[{...p.clips[0],...patch}]}));
});
