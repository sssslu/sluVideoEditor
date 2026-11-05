import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newClip,interpolate} from '../shared/project';
import {attachMotion,motionPoint,motionSource,motionDelta,applyMotion,reconcileMotion} from '../shared/motion';
import {clipSourceTime} from '../shared/speed';
import {planTracking,validateTrackingTarget,applyTracking,detachMotion,type TrackingApply} from '../src/tracking-edits';
import type {MediaAsset} from '../shared/types';
import type {MotionAnalysis,MotionSample} from '../shared/tracking';

const asset:MediaAsset={id:'source',path:'C:\\source.mp4',name:'source',kind:'video',duration:12,width:200,height:100,fps:30,hasAudio:false,sourceRevision:'a'.repeat(64)};
const sample=(time:number,x=.2,size=.2):MotionSample=>({time,box:{x,y:.3,width:size,height:size},score:.8,status:'tracked',anchor:false});
const analysis:MotionAnalysis={version:1,id:'motion',mediaId:asset.id,path:'C:\\motion.slutrack',sourceRevision:asset.sourceRevision!,sourceWidth:200,sourceHeight:100,analysisWidth:200,analysisHeight:100,start:2,end:7,firstFrameTime:2,frames:150,anchors:[{time:2,box:sample(2).box}],backend:'cpu'};
function scene(){const p=newProject();p.width=1000;p.height=500;p.media=[asset];p.clips=[{...newClip('video-1',asset),id:'source-clip',start:5,in:2,duration:4,speedCurve:[{position:0,speed:.5},{position:1,speed:2}]},{...newClip('text-1'),id:'caption',start:5,duration:4,x:41,y:-23,keyframes:[{time:0,x:41,y:-23,scale:.7,opacity:.6,rotation:10},{time:4,x:99,y:50,scale:1.5,opacity:1,rotation:25}]}];return p;}
const options=(overrides:Partial<TrackingApply>={}):TrackingApply=>({analysis,sample:sample(2),sourceTime:2,targetId:'new',text:'  사람  ',followScale:false,...overrides});
const near=(a:object,b:object)=>{assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort());for(const [key,value] of Object.entries(a)){const other=(b as Record<string,unknown>)[key];typeof value==='number'&&typeof other==='number'?assert.ok(Math.abs(value-other)<1e-9,key):assert.deepEqual(value,other);}};

test('authoring places new text above the tracked object and maps a variable-speed source interval',()=>{
  const p=scene(),before=JSON.stringify(p),t=6.3,sourceTime=clipSourceTime(p.clips[0],t-5),frame=sample(sourceTime,.4),target=planTracking(p,'source-clip',t),result=applyTracking(p,target,options({sourceTime,sample:frame}));
  assert.equal(JSON.stringify(p),before);assert.equal(target.time,sourceTime);assert.ok(Math.abs(result.time-t)<1e-9);assert.equal(result.clip.start,5);assert.equal(result.clip.duration,4);assert.equal(result.clip.text,'사람');assert.equal(result.clip.motionBinding!.sourceClipId,'source-clip');assert.equal(result.clip.keyframes.length,0);
  const point=motionPoint(p,motionSource(p.clips[0]),analysis,frame,t);assert.equal(result.clip.x,point.x-500);assert.equal(result.clip.y,point.y-250-result.clip.fontSize*1.2);assert.deepEqual(motionDelta(result.project,result.clip.motionBinding!,analysis,frame,t),{x:0,y:0,scale:1});
});
test('attachment preserves an existing target; reanalysis and detach preserve the current animated transform',()=>{
  const p=scene(),target=planTracking(p,'source-clip',5),initial=applyTracking(p,target,options({targetId:'caption',followScale:true})),c=initial.clip;
  assert.deepEqual(c.keyframes,p.clips[1].keyframes);assert.equal(c.x,41);const t=7,frame=sample(clipSourceTime(p.clips[0],2),.4,.3),before=applyMotion(interpolate(c,2),motionDelta(initial.project,c.motionBinding!,analysis,frame,t));
  const detached=detachMotion(initial.project,'caption',t,frame),after=interpolate(detached.clips[1],2);near(after,before);assert.equal(detached.motionPaths,undefined);assert.ok(initial.project.motionPaths?.length);
  const updated={...analysis,id:'review',path:'C:\\review.slutrack'},review=applyTracking(initial.project,planTracking(initial.project,'caption',t),options({analysis:updated,sample:frame,sourceTime:frame.time,previousSample:frame,followScale:true}));
  near(applyMotion(interpolate(review.clip,2),motionDelta(review.project,review.clip.motionBinding!,updated,frame,t)),before);assert.equal(review.project.motionPaths?.length,1);assert.equal(review.project.motionPaths?.[0].id,'review');
  assert.deepEqual(detachMotion(initial.project,'caption',t).clips[1].keyframes,p.clips[1].keyframes);
});
test('review works from a deleted source snapshot and rejects stale projects, clips, locks and path manifests',()=>{
  const p=attachMotion(scene(),'source-clip',['caption'],analysis,sample(2),5,true),detached=reconcileMotion(p,{...p,clips:[p.clips[1]]}),target=planTracking(detached,'caption',6),frame=sample(target.time);
  assert.equal(target.detached,true);const result=applyTracking(detached,target,options({sourceTime:target.time,sample:frame,previousSample:frame}));assert.equal(result.clip.motionBinding!.sourceClipId,undefined);
  const live=planTracking(p,'caption',6);
  for(const mutate of [(q:typeof p)=>{q.id='other';},(q:typeof p)=>{q.width=500;},(q:typeof p)=>{q.media[0].sourceRevision='b'.repeat(64);},(q:typeof p)=>{q.clips[0].x++;},(q:typeof p)=>{q.clips[1].text='changed';},(q:typeof p)=>{q.tracks[0].locked=true;},(q:typeof p)=>{q.tracks[2].locked=true;},(q:typeof p)=>{q.motionPaths![0].path='C:\\other.slutrack';}]){const q=structuredClone(p);mutate(q);assert.throws(()=>validateTrackingTarget(q,live));}
});
test('invalid application leaves the project intact, including locked targets, wrong results and transform overflow',()=>{
  const p=scene(),target=planTracking(p,'source-clip',5),before=JSON.stringify(p);
  for(const overrides of [{targetId:'source-clip'},{analysis:{...analysis,sourceRevision:'b'.repeat(64)}},{sourceTime:NaN},{sample:sample(9)},{sample:{...sample(2),box:{x:NaN,y:0,width:.2,height:.2}}}])assert.throws(()=>applyTracking(p,target,options(overrides)));
  assert.equal(JSON.stringify(p),before);const locked=structuredClone(p);locked.tracks[2].locked=true;assert.throws(()=>applyTracking(locked,target,options({targetId:'caption'})));assert.equal(applyTracking(locked,target,options()).project.tracks.length,4);
  const bound=attachMotion(p,'source-clip',['caption'],analysis,sample(2),5,true);bound.clips[1].scale=8;bound.clips[1].keyframes=[];const saved=JSON.stringify(bound);assert.throws(()=>detachMotion(bound,'caption',6,sample(3,.2,.4)));assert.equal(JSON.stringify(bound),saved);
});
