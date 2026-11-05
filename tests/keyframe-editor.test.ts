import test from 'node:test';
import assert from 'node:assert/strict';
import type {Clip,Easing,Keyframe} from '../shared/types';
import {newClip,newProject,interpolate,trimClip} from '../shared/project';
import {assertProject} from '../shared/validation';
import {editKeyframe,keyframeCurve,keyframeProperties,keyframeValueRange,sortedKeyframes,toggleKeyframe,type KeyframeProperty} from '../src/keyframe-edits';

const properties=Object.keys(keyframeProperties) as KeyframeProperty[];
const point=(time:number,x=0):Keyframe=>({time,x,y:x/2,scale:1+x/200,rotation:x,opacity:.8-x/500,easing:'ease-in-out',easingStart:.15,easingEnd:.85});
const animated=():Clip=>({...newClip('text-1'),duration:4,keyframes:[point(0),point(2,100),point(4,40)]});

test('empty and constant graphs use finite visible ranges for all five properties',()=>{
  const clip=newClip('text-1');
  for(const property of properties){
    assert.deepEqual(keyframeCurve(clip,property),[{time:0,value:clip[property]},{time:clip.duration,value:clip[property]}]);
    for(const value of [keyframeProperties[property].min,clip[property],keyframeProperties[property].max]){
      const [low,high]=keyframeValueRange({...clip,[property]:value},property);
      assert.ok(Number.isFinite(low)&&Number.isFinite(high)&&low<high);
      assert.ok(low<=value&&high>=value);
    }
  }
});

test('curve samples reuse playback easing and preserved trim intervals',()=>{
  for(const easing of ['linear','ease-in','ease-out','ease-in-out','hold'] as Easing[]){
    const original=animated();original.keyframes=original.keyframes.map(key=>({...key,easing}));
    for(const clip of [original,trimClip(original,.31,3.43)])for(const property of properties){
      const keys=sortedKeyframes(clip);
      for(const sample of keyframeCurve(clip,property)){
        const expected=interpolate(clip,sample.time)[property];
        if(Math.abs(sample.value-expected)<1e-9)continue;
        // The hold path includes both sides of its vertical step at the same time.
        const right=keys.findIndex(key=>key.time===sample.time);
        assert.ok(right>0&&keys[right-1].easing==='hold');
        assert.equal(sample.value,keys[right-1][property]);
      }
    }
  }
});

test('moving a selected value preserves other values, easing and the original input',()=>{
  const clip=animated(),before=structuredClone(clip);
  const keys=editKeyframe(clip,1,'x',{time:1.27,value:-73},30);
  assert.equal(keys[1].time,38/30);assert.equal(keys[1].x,-73);
  for(const name of ['y','scale','rotation','opacity','easing','easingStart','easingEnd'] as const)assert.equal(keys[1][name],clip.keyframes[1][name]);
  assert.deepEqual(keys[0],clip.keyframes[0]);assert.deepEqual(keys[2],clip.keyframes[2]);
  assert.deepEqual(clip,before);
});

test('dragged times stay on a free frame between neighbors and inside the clip',()=>{
  const clip=animated();
  assert.equal(editKeyframe(clip,1,'x',{time:-20},30)[1].time,1/30);
  assert.equal(editKeyframe(clip,1,'x',{time:20},30)[1].time,119/30);
  assert.equal(editKeyframe(clip,0,'x',{time:-20},30)[0].time,0);
  assert.equal(editKeyframe(clip,2,'x',{time:20},30)[2].time,4);
  const fractional={...clip,duration:4.017,keyframes:[point(0),point(4.017)]};
  assert.equal(editKeyframe(fractional,1,'x',{time:20},29.97)[1].time,fractional.duration);
});

test('close and fractional legacy keys retain valid time during value-only edits',()=>{
  const clip={...animated(),keyframes:[point(0),point(.01,10),point(.02,20)]};
  const keys=editKeyframe(clip,1,'opacity',{time:.5,value:.4},30);
  assert.equal(keys[1].time,.01);assert.equal(keys[1].opacity,.4);
  assert.equal(editKeyframe(clip,1,'y',{value:18},30)[1].time,.01);
  assert.equal(new Set(keys.map(key=>key.time)).size,keys.length);
});

test('edited values obey existing project limits and reject nonfinite changes',()=>{
  const clip=animated();
  for(const property of properties){
    const config=keyframeProperties[property];
    assert.equal(editKeyframe(clip,1,property,{value:-1e9},30)[1][property],config.min);
    assert.equal(editKeyframe(clip,1,property,{value:1e9},30)[1][property],config.max);
    assert.throws(()=>editKeyframe(clip,1,property,{value:NaN},30));
  }
  assert.throws(()=>editKeyframe(clip,1,'x',{time:Infinity},30));
});

test('add and remove reuse the coupled snapshot with a clean linear new interval',()=>{
  const clip=animated(),keys=toggleKeyframe(clip,1,30),added=keys.find(key=>key.time===1)!;
  const expected=interpolate(clip,1);
  for(const property of properties)assert.equal(added[property],expected[property]);
  assert.equal(added.easing,'linear');assert.equal(added.easingStart,undefined);assert.equal(added.easingEnd,undefined);
  assert.deepEqual(toggleKeyframe({...clip,keyframes:keys},1,30),clip.keyframes);
  const full={...clip,duration:40,keyframes:Array.from({length:1000},(_,index)=>point(index/30))};
  assert.throws(()=>toggleKeyframe(full,39,30),/1,000/);
  assert.equal(toggleKeyframe(full,0,30).length,999);
});

test('edited keys save and reload with unchanged trim playback',()=>{
  const project=newProject(),clip=animated();
  clip.keyframes=editKeyframe(clip,1,'scale',{time:1.9,value:2.1},30);
  project.clips=[clip];assertProject(project);
  const saved=JSON.parse(JSON.stringify(project));assertProject(saved);
  const restored=saved.clips[0],trimmed=trimClip(restored,.217,3.81);
  for(let index=0;index<80;index++){
    const local=index/80*trimmed.duration;
    for(const property of properties)assert.ok(Math.abs(interpolate(trimmed,local)[property]-interpolate(restored,local+.217)[property])<1e-8);
  }
});
