import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {frameTime,insertClip,moveDelta,tickSpacing,visibleTimelineClips} from '../src/timeline-model';
test('source insertion splits an occupied track, retains source trims, and shifts later material only on target track',()=>{
  const project=newProject(),source={...newClip('video-1'),text:undefined,mediaId:'m',start:0,duration:6,in:4,speed:2},later={...source,id:'later',start:8},audio={...source,id:'audio',trackId:'audio-1'};project.clips=[source,later,audio];
  const added={...newClip('video-1'),id:'added',start:2,duration:3,in:1,text:undefined,mediaId:'n'};
  const result=insertClip(project,added,'insert'),pieces=result.filter(c=>c.mediaId==='m'&&c.trackId==='video-1');
  assert.equal(result.length,5);assert.equal(result.find(c=>c.id===source.id)?.duration,2);assert.equal(pieces.find(c=>c.start===5)?.in,8);assert.equal(pieces.find(c=>c.start===5)?.duration,4);assert.equal(result.find(c=>c.id==='later')?.start,11);assert.equal(result.find(c=>c.id==='audio')?.start,0);
});
test('source overwrite keeps left/right source segments and does not shift following clips',()=>{
  const project=newProject(),source={...newClip('video-1'),id:'source',mediaId:'m',text:undefined,start:0,duration:6,in:4,speed:2},later={...source,id:'later',start:8};project.clips=[source,later];
  const added={...newClip('video-1'),id:'added',start:2,duration:3};const result=insertClip(project,added,'overwrite'),right=result.find(c=>c.start===5)!;
  assert.equal(result.length,4);assert.equal(right.in,14);assert.equal(right.duration,1);assert.notEqual(right.id,source.id);assert.equal(result.find(c=>c.id==='later')?.start,8);
});
test('group dragging snaps any selected edge while preserving relative offsets and frame quantization',()=>{
  const a={...newClip('video-1'),id:'a',start:1,duration:2},b={...a,id:'b',start:5,duration:1};const move=moveDelta([a,b],['a','b'],1.05,[7.1],.1,30,true);
  assert.equal(move.delta,1.1);assert.equal(move.guide,7.1);assert.equal(moveDelta([a,b],['a','b'],-100,[],0,30).delta,-1);assert.equal(moveDelta([a,b],['a','b'],1.05,[7.1],.1,30,false).guide,null);
});
test('fit zoom supports a full-day project with bounded ruler ticks',()=>{
  const zoom=900/86400,spacing=tickSpacing(zoom);assert.ok(86400/spacing<20);assert.equal(tickSpacing(48),2);assert.ok(Math.abs(frameTime(1.04,30)-31/30)<1e-12);
});
test('large selected groups snap against thousands of unsorted edges without changing relative positions',()=>{
  const seed=newClip('video-1'),clips=Array.from({length:5000},(_,i)=>({...seed,id:`group-${i}`,start:i*8,duration:2})),points=clips.flatMap(c=>[c.start+1.1,c.start+7.7]).reverse();
  const result=moveDelta(clips,clips.map(c=>c.id),1.05,points,.1,30,true);
  assert.ok(Math.abs(result.delta-1.1)<1e-8);assert.notEqual(result.guide,null);assert.ok(Math.abs((clips[4999].start+result.delta)-(clips[0].start+result.delta)-39992)<1e-8);
});
test('10,000 sequential clips collapse into bounded overview bins while normal zoom preserves every visible clip',()=>{
  const seed=newClip('video-1'),clips=Array.from({length:10000},(_,i)=>({...seed,id:`clip-${i}`,start:i*7,duration:5}));
  assert.ok(visibleTimelineClips(clips,0,1000,1000/70000,new Set()).length<=251);
  const visible=visibleTimelineClips(clips,0,1000,50,new Set());assert.equal(visible.length,3);assert.deepEqual(visible.map(c=>c.id),['clip-0','clip-1','clip-2']);
});
