import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject,trimClip,splitClip} from '../shared/project';
import type {MediaAsset,SpeedPoint} from '../shared/types';
import {clipSourceSpan,clipSourceTime,clipTimelineTime} from '../shared/speed';
import {changeClipSpeed,changeClipSpeedCurve} from '../src/editor';
import {sourceTime} from '../src/preview/math';
import {assertProject} from '../shared/validation';

const ramp:SpeedPoint[]=[{position:0,speed:.5},{position:.5,speed:2},{position:1,speed:.5}];
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} !== ${expected}`);
test('curve edits preserve the exact source interval and clearing restores constant speed',()=>{
  const original={...newClip('text-1'),start:2,in:7,duration:6,speed:2},curved=changeClipSpeedCurve(original,ramp,30);
  near(curved.duration,9.6);near(clipSourceSpan(curved),12);assert.equal(curved.in,7);assert.equal(curved.speed,2);
  const changed=changeClipSpeedCurve(curved,[{position:0,speed:3},{position:1,speed:1}],30);near(changed.duration,6);near(clipSourceSpan(changed),12);
  const cleared=changeClipSpeedCurve(curved,undefined,30);assert.equal(cleared.speedCurve,undefined);near(cleared.duration,6);near(clipSourceSpan(cleared),12);
  const constant=changeClipSpeed(curved,3,30);assert.equal(constant.speedCurve,undefined);near(constant.duration,4);near(clipSourceSpan(constant),12);
  assert.equal(original.speedCurve,undefined);assertProject({...newProject(),clips:[curved]});
});
test('retiming keeps normalized motion and fade envelope positions while copying control points',()=>{
  const clip={...newClip('text-1'),duration:4,fadeIn:.4,fadeOut:.8,sourceClipOffset:2,sourceClipDuration:8,keyframes:[{time:0,x:0,y:0,scale:1,opacity:1,rotation:0},{time:3,x:20,y:0,scale:1,opacity:1,rotation:0}]};
  const next=changeClipSpeedCurve(clip,[{position:0,speed:.5},{position:1,speed:.5}],30);near(next.duration,8);near(next.keyframes[1].time,6);near(next.fadeIn,.8);near(next.fadeOut,1.6);near(next.sourceClipOffset!,4);near(next.sourceClipDuration!,16);
  const input=ramp.map(p=>Object.freeze({...p}));const applied=changeClipSpeedCurve(clip,input,30);assert.notEqual(applied.speedCurve,input);assert.notEqual(applied.speedCurve![0],input[0]);assertProject({...newProject(),clips:[next]});
});
test('invalid and too-short curves reject atomically without modifying the clip',()=>{
  const clip={...newClip('text-1'),duration:1/30},before=JSON.stringify(clip);
  assert.throws(()=>changeClipSpeedCurve(clip,[{position:0,speed:16},{position:1,speed:16}],30),/최소 길이/);
  assert.throws(()=>changeClipSpeedCurve(clip,[{position:0,speed:1},{position:0,speed:2},{position:1,speed:1}],30),/위치 또는 속도/);
  assert.throws(()=>changeClipSpeedCurve(clip,[{position:0,speed:1},{position:1,speed:Infinity}],30),/위치 또는 속도/);
  assert.equal(JSON.stringify(clip),before);
  assert.throws(()=>changeClipSpeedCurve({...clip,start:86399,duration:1},[{position:0,speed:.1},{position:1,speed:.1}],30),/24시간/);
});
test('curve edits after split and trim preserve the retained source span',()=>{
  const clip=changeClipSpeedCurve({...newClip('text-1'),duration:8,in:3},ramp,30),pieces=splitClip(clip,clip.start+clip.duration*.4)!;
  near(clipSourceTime(pieces[0],pieces[0].duration),pieces[1].in);
  const trimmed=trimClip(pieces[1],.2,pieces[1].duration-.1),span=clipSourceSpan(trimmed),next=changeClipSpeedCurve(trimmed,[{position:0,speed:1},{position:1,speed:3}],30);
  near(clipSourceSpan(next),span);near(next.in,trimmed.in);assertProject({...newProject(),clips:[next]});
});
test('preview converts global timeline seeks to the quadratic source clock',()=>{
  const clip={...newClip('video-1'),start:5,in:10,duration:4,speed:1,speedCurve:[{position:0,speed:1},{position:1,speed:3}]};
  const media:MediaAsset={id:'media',path:'C:\\video.mp4',name:'video',kind:'video',duration:30,width:1920,height:1080,fps:30,hasAudio:true};
  near(sourceTime(clip,7,media),13);near(sourceTime(clip,5,media),10);near(sourceTime(clip,9,media),18);
  near(clipTimelineTime(clip,13),2);near(clipTimelineTime(clip,0),-10);near(clipTimelineTime(clip,21),5);
});
