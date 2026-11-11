import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newClip} from '../shared/project';
import {gapAt,closeGap,closeAllGaps,trackGapCount} from '../src/timeline-model';
import type {MediaAsset,Project} from '../shared/types';

const video:MediaAsset={id:'video',path:'C:/v.mp4',name:'v',kind:'video',width:1920,height:1080,duration:60,fps:30,hasAudio:true};
function project():Project{
  const p=newProject();p.media=[video];
  const at=(id:string,trackId:string,start:number,duration:number)=>({...newClip(trackId,video,start),id,duration});
  // video-1: gap 0–1, [1,2], gap 2–4, [4,6] overlapping [5,7], gap 7–9, [9,10]. audio-1 has its own clip.
  p.clips=[at('a','video-1',1,1),at('b','video-1',4,2),at('c','video-1',5,2),at('d','video-1',9,1),at('music','audio-1',3,2)];
  return p;
}
const starts=(p:Project)=>Object.fromEntries(p.clips.map(c=>[c.id,c.start]));

test('the gap under a point runs from what ends before it to the next clip',()=>{
  const p=project();
  assert.deepEqual(gapAt(p.clips,'video-1',3),{start:2,end:4});
  assert.deepEqual(gapAt(p.clips,'video-1',.5),{start:0,end:1});
  assert.deepEqual(gapAt(p.clips,'video-1',8),{start:7,end:9},'the overlapping pair ends at 7');
  assert.equal(gapAt(p.clips,'video-1',1.5),null,'inside a clip');
  assert.equal(gapAt(p.clips,'video-1',12),null,'after the last clip');
  assert.equal(gapAt(p.clips,'text-1',1),null,'empty track');
});

test('closing one gap moves only that track, from the gap onwards',()=>{
  const p=project(),next=closeGap(p,'video-1',{start:2,end:4});
  assert.deepEqual(starts(next),{a:1,b:2,c:3,d:7,music:3});
});

test('closing all gaps packs the track from zero and keeps overlaps',()=>{
  const p=project();
  assert.equal(trackGapCount(p.clips,'video-1'),3);
  const next=closeAllGaps(p,'video-1');
  assert.deepEqual(starts(next),{a:0,b:1,c:2,d:4,music:3});
  assert.equal(trackGapCount(next.clips,'video-1'),0);
  assert.equal(closeAllGaps(next,'video-1').clips.every((c,i)=>c===next.clips[i]),true,'nothing left to move');
  assert.equal(trackGapCount(p.clips,'audio-1'),1);
});
