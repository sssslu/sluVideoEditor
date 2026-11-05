import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newClip,trimClip} from '../shared/project';
import {assertProject} from '../shared/validation';
import {attachMotion,bindingTime,motionPoint,motionSampleAt,motionSource,motionDelta,reconcileMotion,copyMotionBindings,restoreMotionPaths,applyMotion} from '../shared/motion';
import {assertMotionAnalysis,type MotionAnalysis,type MotionSample} from '../shared/tracking';
import type {MediaAsset} from '../shared/types';
import {clipSourceTime} from '../shared/speed';
import {clipMediaIds} from '../shared/processing';
import {resizeProject} from '../src/editor';

const asset:MediaAsset={id:'source',path:'C:\\source.mp4',name:'source',kind:'video',duration:12,width:200,height:100,fps:30,hasAudio:false,sourceRevision:'a'.repeat(64)};
const sample=(time:number,x=.2,y=.3,width=.2,height=.2):MotionSample=>({time,box:{x,y,width,height},score:.8,status:'tracked',anchor:false});
const analysis:MotionAnalysis={version:1,id:'motion',mediaId:asset.id,path:'C:\\motion.slutrack',sourceRevision:asset.sourceRevision!,sourceWidth:200,sourceHeight:100,analysisWidth:200,analysisHeight:100,start:0,end:12,firstFrameTime:0,frames:360,anchors:[{time:0,box:sample(0).box}],backend:'cpu'};
function scene(){const p=newProject();p.width=1000;p.height=500;p.media=[asset];const source={...newClip('video-1',asset),id:'source-clip'},target={...newClip('text-1'),id:'caption',start:0,duration:12,x:41,y:-23};p.clips=[source,target];return p;}

test('motion bindings compose manual transforms, source crop/fit/mirror/rotation and isotropic size',()=>{
  let p=scene();const s=p.clips[0];s.crop={left:.1,right:.1,top:.2,bottom:.2};s.flipH=true;s.rotation=90;s.scale=2;s.x=19;s.y=37;
  const frame=sample(0),point=motionPoint(p,motionSource(s),analysis,frame,0);
  // crop160x60 -> contain6.25, center(-40,-10), mirrored/scaled(500,-125), rotate(125,500)
  assert.ok(Math.abs(point.x-644)<1e-9&&Math.abs(point.y-787)<1e-9);assert.equal(point.size,Math.sqrt(40*20)*6.25*2);
  p=attachMotion(p,s.id,['caption'],analysis,frame,0,true);assertProject(p);const b=p.clips[1].motionBinding!;
  assert.deepEqual(motionDelta(p,b,analysis,frame,0),{x:0,y:0,scale:1});
  const moved=sample(1,.3,.3,.4,.4),delta=motionDelta(p,b,analysis,moved,1);assert.equal(delta.scale,2);
  const manual={time:1,x:41,y:-23,scale:.75,rotation:17,opacity:.6},state=applyMotion(manual,delta);
  assert.equal(state.scale,1.5);assert.equal(state.rotation,17);assert.equal(state.opacity,.6);assert.equal(state.x,manual.x+delta.x);assert.equal(state.y,manual.y+delta.y);
});
test('source time follows variable speed, holds outside source/analysis and preserves VFR frame identity',()=>{
  let p=scene();const s=p.clips[0];s.start=5;s.duration=4;s.in=2;s.speedCurve=[{position:0,speed:.5},{position:1,speed:2}];
  p=attachMotion(p,s.id,['caption'],analysis,sample(2),5,false);const b=p.clips[1].motionBinding!;
  assert.equal(bindingTime(p,b,analysis,0),2);assert.equal(bindingTime(p,b,analysis,6.25),clipSourceTime(s,1.25));assert.equal(bindingTime(p,b,analysis,20),clipSourceTime(s,4)-.000001);
  const frames=[sample(2),sample(2.1),sample(2.75)];assert.equal(motionSampleAt(frames,2.749),frames[1]);assert.equal(motionSampleAt(frames,2.75),frames[2]);
  const right=trimClip(p.clips[1],1,4);assert.deepEqual(right.motionBinding,b);
});
test('live edits and deletion retain the last source transform; undo snapshots remain independent',()=>{
  const p=attachMotion(scene(),'source-clip',['caption'],analysis,sample(0),0,false),b=p.clips[1].motionBinding!;
  const edited={...p,clips:p.clips.map(c=>c.id==='source-clip'?{...c,x:300,rotation:27}:c)},expected=motionDelta(edited,b,analysis,sample(1,.4),1);
  const removed=reconcileMotion(edited,{...edited,clips:edited.clips.filter(c=>c.id!=='source-clip')});assertProject(removed);
  assert.equal(removed.clips[0].motionBinding!.sourceClipId,undefined);assert.equal(removed.clips[0].motionBinding!.source.x,300);
  assert.deepEqual(motionDelta(removed,removed.clips[0].motionBinding!,analysis,sample(1,.4),1),expected);assert.equal(b.source.x,0);assert.equal(b.sourceClipId,'source-clip');
  const deleted=reconcileMotion(p,{...p,clips:[]});assert.equal(deleted.motionPaths,undefined);assert.equal(p.motionPaths?.length,1);
  assert.ok(clipMediaIds(removed.clips[0]).includes(asset.id));
});
test('copying a source with its follower remaps the live link and keeps immutable analysis',()=>{
  const p=attachMotion(scene(),'source-clip',['caption'],analysis,sample(0),0,false),ids=new Map([['source-clip','copy-source'],['caption','copy-caption']]);
  const copies=copyMotionBindings(p,p.clips.map(c=>({...structuredClone(c),id:ids.get(c.id)!,start:c.start+12})),ids,12);
  assert.equal(copies[1].motionBinding!.sourceClipId,'copy-source');const next={...p,clips:[...p.clips,...copies]};assertProject(next);
  assert.equal(bindingTime(next,copies[1].motionBinding!,analysis,14),2);
  const restored=restoreMotionPaths({...p,motionPaths:undefined},copies,p.motionPaths!);assert.equal(restored.motionPaths?.[0],analysis);
  assert.throws(()=>restoreMotionPaths({...p,media:[],motionPaths:undefined},copies,p.motionPaths!));
});
test('project validation rejects corrupt, recursive, obsolete-format and unsupported motion references',()=>{
  const valid=attachMotion(scene(),'source-clip',['caption'],analysis,sample(0),0,false);assertProject(valid);
  for(const mutate of [(p:typeof valid)=>{p.version=7;},(p:typeof valid)=>{p.clips[1].motionBinding!.sourceClipId='caption';},(p:typeof valid)=>{p.clips[1].motionBinding!.reference.size=0;},(p:typeof valid)=>{p.clips[1].motionBinding!.source.keyframes=[{time:NaN,x:0,y:0,scale:1,rotation:0,opacity:1}];},(p:typeof valid)=>{p.motionPaths!.push(p.motionPaths![0]);},(p:typeof valid)=>{p.motionPaths![0].mediaId='absent';}]){const p=structuredClone(valid);mutate(p);assert.throws(()=>assertProject(p));}
  for(const value of [{...analysis,sourceRevision:'wrong'},{...analysis,frames:2.5},{...analysis,firstFrameTime:1},{...analysis,path:'C:\\not-a-path.txt'},{...analysis,anchors:[analysis.anchors[0],analysis.anchors[0]]}])assert.throws(()=>assertMotionAnalysis(value));
  assert.throws(()=>attachMotion(valid,'source-clip',['caption'],analysis,sample(0),0,false),/기존/);
  const locked=scene();locked.tracks.find(t=>t.id==='text-1')!.locked=true;assert.throws(()=>attachMotion(locked,'source-clip',['caption'],analysis,sample(0),0,false),/잠기지/);
});
test('canvas resize preserves attachment in new project coordinates and detached source timing can be copied earlier',()=>{
  const p=attachMotion(scene(),'source-clip',['caption'],analysis,sample(0),0,true),resized=resizeProject(p,500,1000),b=resized.clips[1].motionBinding!;
  assertProject(resized);const point=motionPoint(resized,motionSource(resized.clips[0]),analysis,sample(0),0),delta=motionDelta(resized,b,analysis,sample(0),0);
  assert.equal(b.reference.x,p.clips[1].motionBinding!.reference.x*.5);assert.equal(b.reference.y,p.clips[1].motionBinding!.reference.y*2);assert.equal(delta.x,point.x-b.reference.x);assert.equal(delta.y,point.y-b.reference.y);assert.equal(delta.scale,1);
  const detached=reconcileMotion(p,{...p,clips:[{...p.clips[1],start:5,duration:3}]}),copy=copyMotionBindings(detached,[{...detached.clips[0],id:'pasted',start:0}],new Map(),-5);assert.equal(copy[0].motionBinding!.source.start,-5);assertProject({...detached,clips:copy});
});
