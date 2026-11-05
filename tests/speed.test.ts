import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject,trimClip,splitClip} from '../shared/project';
import {assertSpeedCurve,clipSourceTime,clipTimelineTime,clipSourceSpan,clipSpeedAt,speedCurveMean,trimSpeedCurve} from '../shared/speed';
import {assertProject} from '../shared/validation';

const curve=[{position:0,speed:.2},{position:.25,speed:4},{position:.65,speed:.4},{position:1,speed:2}];
const clip={...newClip('video-1'),in:13,duration:11,speed:1,speedCurve:curve};
test('speed curve integrates exact trapezoids and inverts source time including extensions',()=>{
  const mean=.25*2.1+.4*2.2+.35*1.2;
  assert.ok(Math.abs(speedCurveMean(curve)-mean)<1e-12);
  assert.ok(Math.abs(clipSourceSpan(clip)-11*mean)<1e-12);
  for(let i=-200;i<=1400;i++){
    const t=i/100;
    assert.ok(Math.abs(clipTimelineTime(clip,clipSourceTime(clip,t))-t)<1e-9,`roundtrip ${t}`);
  }
  assert.equal(clipSpeedAt(clip,-1),.2);assert.equal(clipSpeedAt(clip,20),2);
});
test('quadratic inverse is stable for nearly flat, extreme and sub-frame speed segments',()=>{
  const curves=[
    [{position:0,speed:1},{position:1,speed:1+1e-11}],
    [{position:0,speed:16},{position:.000001,speed:.1},{position:1,speed:16}],
    [{position:0,speed:.1},{position:1,speed:.100001}],
  ];
  for(const points of curves)for(const duration of [.01,1,3600]){
    const c={...clip,duration,speedCurve:points};
    for(let i=0;i<=100;i++){const t=i*duration/100;assert.ok(Math.abs(clipTimelineTime(c,clipSourceTime(c,t))-t)<1e-7,`${duration}/${i}`);}
  }
});
test('trims and splits retain the same original source frames and instantaneous rates',()=>{
  const trimmed=trimClip(clip,1.3,9.2),split=splitClip(clip,4.2)!;
  const repeated=trimClip(trimmed,.7,6.5);
  for(const [c,offset] of [[trimmed,1.3],[repeated,2],[split[0],0],[split[1],4.2]] as const){
    for(let i=0;i<=100;i++){const t=c.duration*i/100;assert.ok(Math.abs(clipSourceTime(c,t)-clipSourceTime(clip,t+offset))<1e-9);assert.ok(Math.abs(clipSpeedAt(c,t)-clipSpeedAt(clip,t+offset))<1e-9);}
  }
  assertSpeedCurve(trimSpeedCurve(curve,-.3,1.4));
});
test('old constant-rate projects preserve mapping and new curves require a protected project version',()=>{
  const c={...clip,speedCurve:undefined,speed:2.5};
  assert.equal(clipSourceTime(c,4),23);assert.equal(clipTimelineTime(c,23),4);
  const p=newProject();p.clips=[{...clip,trackId:'text-1'}];assertProject(p);
  assert.throws(()=>assertProject({...p,version:1}));
  assertProject({...p,version:1,clips:[{...c,trackId:'text-1'}]});
  for(const points of [[],[{position:0,speed:1}],[{position:0,speed:1},{position:0,speed:2}],[{position:0,speed:0},{position:1,speed:1}],[{position:0,speed:1},{position:1,speed:Infinity}],[{position:.1,speed:1},{position:1,speed:1}]])assert.throws(()=>assertSpeedCurve(points));
  assert.throws(()=>assertProject({...p,clips:[{...p.clips[0],duration:.01,speedCurve:[{position:0,speed:1},{position:Number.MIN_VALUE,speed:2},{position:1,speed:1}]}]}));
});
