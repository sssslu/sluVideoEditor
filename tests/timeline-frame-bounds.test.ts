import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {assertProject} from '../shared/validation';
import {changeClipSpeedCurve} from '../src/editor';
import {boundedFrameStart,boundedNudgeDelta} from '../src/timeline-model';

const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} !== ${expected}`);
const move=(clips:readonly {start:number;duration:number}[],frames:number,fps:number)=>{
  const delta=boundedNudgeDelta(clips,frames,fps);
  near(delta*fps,Math.round(delta*fps));
  const result=clips.map(c=>({...c,start:c.start+delta}));
  for(const c of result){assert.ok(c.start>=0);assert.ok(c.start+c.duration<=86400);}
  return {delta,result};
};

test('right nudge at the 24-hour boundary rejects a partial frame for a fractional curve duration',()=>{
  const curved=changeClipSpeedCurve({...newClip('text-1'),duration:2.02},[{position:0,speed:1},{position:1,speed:3}],30);
  near(curved.duration,1.01);
  const clip={...curved,start:86398+29/30};
  assertProject({...newProject(),clips:[clip]});
  const {delta,result}=move([clip],1,30);
  assert.equal(delta,0);assert.equal(result[0].start,clip.start);
  assertProject({...newProject(),clips:[{...clip,start:result[0].start}]});
  assert.equal(move([clip],-1,30).delta,-1/30);
});

test('left nudge stops at the first whole frame before zero without resetting the fractional phase',()=>{
  const clip={start:1.015,duration:2.01};
  const {delta,result}=move([clip],-300,30);
  assert.equal(delta,-1);near(result[0].start,.015);
  assert.equal(move(result,-1,30).delta,0);
  assert.equal(move([{start:1/30,duration:1}],-1,30).result[0].start,0);
  assert.equal(move([{start:0,duration:1}],-1,30).delta,0);
});

test('a selected group preserves offsets and distinct fractional phases in both directions',()=>{
  const clips=[{start:1.015,duration:2.01},{start:4.023,duration:1.14},{start:8.007,duration:4.012}];
  for(const frames of [-1000,-1,1,10,1000]){
    const {delta,result}=move(clips,frames,30);
    for(let i=0;i<clips.length;i++){
      near(result[i].start-clips[i].start,delta);
      near(result[i].start-result[0].start,clips[i].start-clips[0].start);
    }
  }
  assert.equal(move(clips,-1000,30).delta,-1);
});

test('the latest ending member constrains the whole group even if another clip starts later',()=>{
  const clips=[{start:86390.011,duration:9.91},{start:86398.023,duration:.5}];
  const {delta,result}=move(clips,1000,30);
  assert.equal(delta,2/30);near(result[1].start-result[0].start,clips[1].start-clips[0].start);
  assert.equal(move(result,1,30).delta,0);
});

test('nudge supports frame rates through 120 fps, empty selection, and large groups',()=>{
  assert.equal(boundedNudgeDelta([],1,30),0);
  for(const fps of [24,25,30,50,60,120]){
    const clips=Array.from({length:10000},(_,i)=>({start:.001+i*8,duration:1.001}));
    assert.equal(move(clips,-1,fps).delta,0);
    near(move(clips,1,fps).delta,1/fps);
  }
});

test('Inspector absolute start rounds to a legal frame for fractional curve durations at both boundaries',()=>{
  const clip=changeClipSpeedCurve({...newClip('text-1'),duration:2.02},[{position:0,speed:1},{position:1,speed:3}],30);
  const maximum=86400-clip.duration;
  const start=boundedFrameStart(maximum,clip.duration,30);
  near(start,86398+29/30);near(start*30,Math.round(start*30));
  assert.ok(start+clip.duration<=86400);
  assertProject({...newProject(),clips:[{...clip,start}]});
  assert.equal(boundedFrameStart(100000,clip.duration,30),start);
  assert.equal(boundedFrameStart(-100,clip.duration,30),0);
  assert.equal(boundedFrameStart(.01,clip.duration,30),0);
  near(boundedFrameStart(.02,clip.duration,30),1/30);
});

test('Inspector boundary clamp remains valid for every supported frame rate and full-day clips',()=>{
  for(const fps of [24,25,30,50,60,120])for(const duration of [.01,.051,1.01,9.999,86399.991,86400]){
    const start=boundedFrameStart(86400,duration,fps);
    assert.ok(start>=0);assert.ok(start+duration<=86400);
    near(start*fps,Math.round(start*fps));
  }
});
