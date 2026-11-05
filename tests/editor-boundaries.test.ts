import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {assertProject} from '../shared/validation';
import {parseSrt} from '../electron/services';
import {changeClipSpeed,cuesToClips,minClipDuration,resizeProject} from '../src/editor';
import {insertClip} from '../src/timeline-model';

test('1ms SRT cues retain all text and become a saveable one-frame clip',()=>{
  const project=newProject(),cues=parseSrt('1\n00:00:01,000 --> 00:00:01,001\n짧은 자막\n');
  const clips=cuesToClips(cues,'text-1',project);assert.equal(clips.length,1);assert.equal(clips[0].text,'짧은 자막');assert.equal(clips[0].duration,1/30);assertProject({...project,clips});assert.equal(project.clips.length,0);
});
test('invalid or overlong subtitle content rejects the whole conversion before project mutation',()=>{
  const project=newProject(),before=JSON.stringify(project);
  for(const text of ['가'.repeat(20001),'문자\0오류'])assert.throws(()=>cuesToClips([{start:0,end:1,text:'정상 자막'},{start:1,end:2,text}],'text-1',project),/20,000자/);
  assert.throws(()=>cuesToClips([{start:86400,end:86401,text:'범위 오류'}],'text-1',project),/24시간/);assert.equal(JSON.stringify(project),before);
});
test('caption minimum duration stays inside source clip and 24-hour boundaries',()=>{
  const project=newProject(),bounded=cuesToClips([{start:8.039,end:8.04,text:'빠른 자막'}],'text-1',project,0,{start:8,end:8.04});
  assert.ok(bounded[0].start>=8);assert.ok(bounded[0].start+bounded[0].duration<=8.04+1e-10);assert.equal(bounded[0].duration,1/30);assertProject({...project,clips:bounded});
  const boundary=cuesToClips([{start:86399.999,end:86400,text:'마지막'}],'text-1',project);assert.ok(boundary[0].start+boundary[0].duration<=86400);assertProject({...project,clips:boundary});
  assert.throws(()=>cuesToClips([{start:8,end:8.01,text:'공간 부족'}],'text-1',project,0,{start:8,end:8.01}),/구간이 너무 짧/);
});
test('120fps subtitles still respect the shared 10ms minimum',()=>{
  const project={...newProject(),fps:120},clips=cuesToClips([{start:1,end:1.001,text:'자막'}],'text-1',project);assert.equal(minClipDuration(120),.01);assert.equal(clips[0].duration,.01);assertProject({...project,clips});
});
test('speed changes reject sub-frame results without mutating the existing clip',()=>{
  const clip={...newClip('text-1'),duration:1/30},before=JSON.stringify(clip);assert.throws(()=>changeClipSpeed(clip,16,30),/최소 길이/);assert.equal(JSON.stringify(clip),before);
  const fast={...clip,duration:.02};assert.equal(changeClipSpeed(fast,2,120).duration,.01);assert.throws(()=>changeClipSpeed(fast,3,120),/최소 길이/);
});
test('valid speed changes preserve scaled motion, fades and split envelope',()=>{
  const project=newProject(),clip={...newClip('text-1'),duration:1,fadeIn:.2,fadeOut:.4,sourceClipOffset:1,sourceClipDuration:3,keyframes:[{time:0,x:0,y:0,scale:1,opacity:1,rotation:0},{time:1,x:10,y:20,scale:1,opacity:1,rotation:0}]};
  const next=changeClipSpeed(clip,2,30);assert.equal(next.duration,.5);assert.equal(next.fadeOut,.2);assert.equal(next.sourceClipOffset,.5);assert.equal(next.sourceClipDuration,1.5);assert.equal(next.keyframes[1].time,.5);assertProject({...project,clips:[next]});
});
test('extreme supported canvas resizing clamps text size and keyframe positions to saveable bounds',()=>{
  const base=newProject(),clip={...newClip('text-1'),x:16384,y:-16384,keyframes:[{time:0,x:16384,y:-16384,scale:1,opacity:1,rotation:0}]},project={...base,clips:[clip]};
  const small=resizeProject(project,64,64);assert.equal(small.clips[0].fontSize,4);assertProject(small);
  const large=resizeProject({...small,clips:[{...small.clips[0],fontSize:1000,x:16384,y:-16384,keyframes:clip.keyframes}]},7680,7680);assert.equal(large.clips[0].fontSize,1000);assert.equal(large.clips[0].x,16384);assert.equal(large.clips[0].keyframes[0].y,-16384);assertProject(large);assert.equal(project.clips[0].fontSize,64);
});
test('source insertion and overwrite do not leave unsaveable millisecond slivers',()=>{
  const project=newProject(),existing={...newClip('video-1'),start:0,duration:1.001},incoming={...newClip('video-1'),start:0,duration:1};project.clips=[existing];
  const overwrite=insertClip(project,incoming,'overwrite');assert.equal(overwrite.length,1);assertProject({...project,clips:overwrite});
  const inserted=insertClip(project,{...incoming,start:1},'insert');assert.equal(inserted.length,2);assert.ok(inserted.every(c=>c.duration>=1/project.fps));assertProject({...project,clips:inserted});
});
