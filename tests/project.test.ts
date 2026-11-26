import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newClip,splitClip,interpolate,projectDuration,shiftTransform} from '../shared/project';
import {assertProject} from '../shared/validation';

test('splitting a sped-up clip preserves source timing and motion across both pieces',()=>{
  const clip=newClip('video-1');clip.text=undefined;clip.start=10;clip.in=4;clip.duration=8;clip.speed=2;clip.keyframes=[{time:0,x:0,y:0,scale:1,opacity:1,rotation:0},{time:8,x:800,y:200,scale:2,opacity:.5,rotation:90}];
  const parts=splitClip(clip,13)!;assert.equal(parts[0].duration,3);assert.equal(parts[1].in,10);assert.equal(parts[1].duration,5);assert.equal(parts[1].start,13);
  for(const t of [0,1,3,4.5,5]){const expected=interpolate(clip,t+3),actual=interpolate(parts[1],t);for(const field of ['x','y','scale','opacity','rotation'] as const)assert.ok(Math.abs(expected[field]-actual[field])<1e-10);}
  assert.equal(splitClip(clip,10),null);assert.equal(splitClip(clip,18),null);
});
test('project validator rejects broken values and invalid references before rendering',()=>{
  const p=newProject();p.clips=[newClip('text-1')];assert.doesNotThrow(()=>assertProject(p));assert.equal(projectDuration(p),3);
  for(const change of [{width:Infinity},{width:0},{fps:0},{background:'red;movie=evil'}])assert.throws(()=>assertProject({...p,...change}));
  for(const change of [{start:-1},{speed:0},{volume:NaN},{trackId:'missing'},{mediaId:'missing'},{textStyle:'evil'},{keyframes:[{time:0,x:NaN}]}])assert.throws(()=>assertProject({...p,clips:[{...p.clips[0],...change}]}));
});
test('editing several clips sets the transform at the playhead and moves keyframed motion as a whole',()=>{
  const still={...newClip('text-1'),x:10,y:70,scale:1,keyframes:[]};
  assert.deepEqual(shiftTransform(still,{y:-120},1),{y:-120});
  const moving={...newClip('video-1'),duration:4,x:0,y:0,scale:1,keyframes:[{time:0,x:0,y:0,scale:1,opacity:1,rotation:0},{time:4,x:400,y:100,scale:2,opacity:.5,rotation:0}]};
  const moved={...moving,...shiftTransform(moving,{x:300,scale:3},2)};
  // At the playhead (x 200, scale 1.5) it now shows the new values; the path keeps its shape.
  assert.equal(interpolate(moved,2).x,300);assert.ok(Math.abs(interpolate(moved,2).scale-3)<1e-9);
  assert.deepEqual(moved.keyframes.map(k=>k.x),[100,500]);assert.deepEqual(moved.keyframes.map(k=>k.scale),[2,4]);
  assert.deepEqual(moved.keyframes.map(k=>k.y),[0,100],'Untouched values stay');
  // Values stay inside the valid range.
  const clamped=shiftTransform(moving,{scale:8},0);assert.deepEqual(clamped.keyframes!.map(k=>k.scale),[8,8]);
});
