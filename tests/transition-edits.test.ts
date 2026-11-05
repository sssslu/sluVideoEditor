import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject,splitClip,trimClip} from '../shared/project';
import {copyTransitions,reconcileTransitions} from '../shared/transition-edits';
import {assertProject} from '../shared/validation';
import {insertClip} from '../src/timeline-model';
import type {MediaAsset} from '../shared/types';

function fixture(){const p=newProject(),media:MediaAsset={id:'m',name:'m',path:'C:/source.mp4',kind:'video',duration:30,videoStart:0,videoEnd:30,width:320,height:180,fps:30,hasAudio:true};p.media=[media];p.clips=[{...newClip('video-1',media),id:'a',in:3,duration:4},{...newClip('video-1',media,4),id:'b',in:10,duration:4}];p.transitions=[{id:'ab',fromClipId:'a',toClipId:'b',durationFrames:30,kind:'dissolve'}];return p;}
test('moving a group preserves the transition; moving/deleting one side detaches atomically',()=>{
  const p=fixture(),moved={...p,clips:p.clips.map(c=>({...c,start:c.start+2}))};let result=reconcileTransitions(p,moved);assert.deepEqual(result.detached,[]);assert.deepEqual(result.project.transitions,p.transitions);assertProject(result.project);
  result=reconcileTransitions(p,{...p,clips:p.clips.map(c=>c.id==='a'?{...c,start:2}:c)});assert.deepEqual(result.detached,['ab']);assert.equal(result.project.transitions,undefined);assert.equal(result.project.clips[1],p.clips[1]);
  result=reconcileTransitions(p,{...p,clips:[p.clips[1]]});assert.deepEqual(result.detached,['ab']);assertProject(result.project);
});
test('split/insert retargets the piece touching a cut while preserving nonlinear source mapping',()=>{
  const p=fixture();p.clips[0].speedCurve=[{position:0,speed:.5},{position:1,speed:2}];const parts=splitClip(p.clips[0],2)!;
  let result=reconcileTransitions(p,{...p,clips:[...parts,p.clips[1]]});assert.equal(result.project.transitions![0].fromClipId,parts[1].id);assert.deepEqual(result.detached,[]);assertProject(result.project);
  const incoming={...newClip('video-1',p.media[0],2),id:'insert',in:1,duration:1};const inserted=insertClip(p,incoming,'insert');
  result=reconcileTransitions(p,{...p,clips:inserted});const right=inserted.find(c=>c.id!==p.clips[0].id&&c.start===3)!;assert.equal(result.project.transitions![0].fromClipId,right.id);assert.equal(result.project.clips.find(c=>c.id==='b')!.start,5);assertProject(result.project);
});
test('a split within a transition and a trim removing handles detach instead of changing clip lengths',()=>{
  const p=fixture(),parts=splitClip(p.clips[0],3.8)!;const clips=[...parts,p.clips[1]],serialized=JSON.stringify(clips);let result=reconcileTransitions(p,{...p,clips});assert.deepEqual(result.detached,['ab']);assert.equal(JSON.stringify(result.project.clips),serialized);
  result=reconcileTransitions(p,{...p,clips:[trimClip(p.clips[0],0,3),p.clips[1]]});assert.deepEqual(result.detached,['ab']);
});
test('FPS changes retain seconds to the nearest project frame and unsupported new transitions fail visibly',()=>{
  const p=fixture();p.transitions![0].durationFrames=31;const result=reconcileTransitions(p,{...p,fps:24});assert.equal(result.project.transitions![0].durationFrames,25);assert.deepEqual(result.project.clips,p.clips);
  assert.throws(()=>reconcileTransitions(p,{...p,transitions:[...p.transitions!,{id:'bad',fromClipId:'missing',toClipId:'b',durationFrames:30,kind:'wipe'}]}),/컷/);
});
test('copying both clips remaps transition IDs; copying one never leaves a dangling reference',()=>{
  const p=fixture();assert.deepEqual(copyTransitions(p.transitions,new Map([['a','new-a']]),()=> 'copy'),[]);
  const copies=copyTransitions(p.transitions,new Map([['a','new-a'],['b','new-b']]),()=> 'copy');assert.deepEqual(copies,[{...p.transitions![0],id:'copy',fromClipId:'new-a',toClipId:'new-b'}]);assert.equal(p.transitions![0].id,'ab');
});
test('pasting a transition after a project FPS change retains its duration in seconds',()=>{
  const p=fixture();p.transitions![0].durationFrames=31;
  const copies=copyTransitions(p.transitions,new Map([['a','copy-a'],['b','copy-b']]),()=> 'copy',30,24);
  assert.equal(copies[0].durationFrames,25);assert.equal(p.transitions![0].durationFrames,31);
});
