import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newClip} from '../shared/project';
import {assertProject} from '../shared/validation';
import {clipSourceTime} from '../shared/speed';
import type {MediaAsset} from '../shared/types';
import {planFreeze,insertFreeze,minFreezeFrames} from '../src/freeze';
import {clipState} from '../src/preview/math';

const media:MediaAsset={id:'video',path:'C:/clip.mp4',name:'clip',kind:'video',width:1920,height:1080,duration:30,fps:30,hasAudio:true},image:MediaAsset={...media,id:'still',path:'C:/frame.png',name:'still',kind:'image',hasAudio:false,duration:5,fps:0};
function fixture(){const project=newProject();project.fps=30;project.media=[media];const clip={...newClip('video-1',media),id:'clip',start:1,duration:4,in:2,fadeIn:2,speedCurve:[{position:0,speed:1},{position:1,speed:2}],keyframes:[{time:0,x:0,y:0,scale:1,opacity:.5,rotation:0},{time:4,x:100,y:50,scale:1.2,opacity:1,rotation:20}]};project.clips=[clip,{...newClip('audio-1',media),id:'other',start:0,duration:8},{...newClip('video-1',media),id:'later',start:6,duration:3}];return {project,clip};}
test('Inserting a freeze holds evaluated effects, retains source continuity and shifts only its track',()=>{
  const {project,clip}=fixture(),before=JSON.stringify(project),plan=planFreeze(project,clip.id,2,3),result=insertFreeze(project,clip.id,2,3,image),state=clipState(clip,2);assert.equal(plan.sourceTime,clipSourceTime(clip,1));assert.equal(JSON.stringify(project),before);assertProject(result.project);
  for(const field of ['x','y','scale','opacity','rotation'] as const)assert.equal(result.clip[field],state[field]);assert.equal(result.clip.speedCurve,undefined);assert.equal(result.clip.volume,0);assert.equal(result.clip.fadeIn,0);assert.equal(result.clip.keyframes.length,0);
  assert.deepEqual(result.project.clips.find(c=>c.id==='other'),project.clips[1]);assert.equal(result.project.clips.find(c=>c.id==='later')!.start,9);
  const fragments=result.project.clips.filter(c=>c.mediaId===media.id&&c.trackId==='video-1'&&c.id!=='later').sort((a,b)=>a.start-b.start);assert.equal(fragments.length,2);assert.equal(fragments[0].duration+fragments[1].duration,4);assert.ok(Math.abs(clipSourceTime(fragments[0],fragments[0].duration)-fragments[1].in)<1e-9);assert.equal(result.project.media.length,2);
});
test('Near-edge cuts, locked tracks, outside playhead, invalid length and 24-hour overflow cannot lose content',()=>{
  const {project,clip}=fixture();for(const at of [0,1.001,4.999,5])assert.throws(()=>planFreeze(project,clip.id,at,3));for(const duration of [0,NaN,3601,.05])assert.throws(()=>planFreeze(project,clip.id,2,duration));
  assert.doesNotThrow(()=>planFreeze(project,clip.id,1,3));project.tracks[0].locked=true;assert.throws(()=>planFreeze(project,clip.id,2,3),/잠긴/);project.tracks[0].locked=false;project.clips[2].start=86396;assert.throws(()=>planFreeze(project,clip.id,2,3),/24시간/);
  const high=fixture();high.project.fps=120;assert.equal(minFreezeFrames(120),2);assert.throws(()=>planFreeze(high.project,high.clip.id,2,1/120),/2프레임/);assertProject(insertFreeze(high.project,high.clip.id,2,2/120,image).project);
});
