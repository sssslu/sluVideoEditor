import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newClip,splitClip,interpolate,trimClip} from '../shared/project';
import {attachMotion,splitMotionSources,bindingTime,motionDelta,motionSource,reconcileMotion,copyMotionBindings,applyMotion} from '../shared/motion';
import {motionLinks,resolveMotionSources,MotionSourceTimeline,type ResolvedMotionSource} from '../shared/motion-sources';
import {planTracking,trackingReference,applyTracking,validateTrackingTarget,detachMotion} from '../src/tracking-edits';
import {assertProject} from '../shared/validation';
import {resizeProject} from '../src/editor';
import type {MotionAnalysis,MotionSample} from '../shared/tracking';
import type {MediaAsset,Project} from '../shared/types';
const asset:MediaAsset={id:'video',path:'C:\\split.mp4',name:'video',kind:'video',duration:40,width:200,height:100,fps:30,hasAudio:false,sourceRevision:'a'.repeat(64)};
const sample=(time:number):MotionSample=>({time,box:{x:.1+time/100,y:.2,width:.2+time/1000,height:.2},score:.9,status:'tracked',anchor:false});
const analysis:MotionAnalysis={version:1,id:'motion',mediaId:asset.id,path:'C:\\motion.slutrack',sourceRevision:asset.sourceRevision!,sourceWidth:200,sourceHeight:100,analysisWidth:200,analysisHeight:100,start:0,end:40,firstFrameTime:0,frames:1200,anchors:[{time:0,box:sample(0).box}],backend:'cpu'};
function scene(){const p=newProject();p.width=1000;p.height=500;p.media=[asset];const source={...newClip('video-1',asset),id:'source',start:5,in:2,duration:8,speedCurve:[{position:0,speed:.5},{position:1,speed:2}],crop:{left:.1,right:.2,top:.1,bottom:.1},flipH:true,keyframes:[{time:0,x:20,y:11,scale:.8,rotation:10,opacity:1,easing:'ease-in-out' as const},{time:8,x:70,y:-13,scale:1.2,rotation:35,opacity:1}]};p.clips=[source,{...newClip('text-1'),id:'text',start:5,duration:8,x:22,y:33}];return attachMotion(p,'source',['text'],analysis,sample(2),5,true);}
function split(p:Project,id:string,at:number){const parts=splitClip(p.clips.find(c=>c.id===id)!,at)!;assert.ok(parts);return {parts,project:splitMotionSources(p,p.clips.flatMap(c=>c.id===id?parts:[c]),new Map([[id,parts]]))};}
const near=(a:object,b:object,epsilon=1e-8)=>{for(const [k,value] of Object.entries(a)){const other=(b as Record<string,unknown>)[k];if(typeof value==='number'&&typeof other==='number')assert.ok(Math.abs(value-other)<epsilon,`${k}: ${value} vs ${other}`);else assert.deepEqual(value,other);}};

test('repeated source splits preserve every tested source clock and transformed follower position, including locked followers',()=>{
  const p=scene();p.tracks.find(t=>t.id==='text-1')!.locked=true;const original=JSON.stringify(p),once=split(p,'source',8.137),twice=split(once.project,once.parts[1].id,11.019).project,b=twice.clips.find(c=>c.id==='text')!.motionBinding!;assertProject(twice);assert.equal(motionLinks(b).length,3);assert.equal(twice.clips.length,4);assert.equal(JSON.stringify(p),original);
  const {motionBinding:oldBinding,...manual}=p.clips[1],{motionBinding,...after}=twice.clips.find(c=>c.id==='text')!;assert.deepEqual(after,manual);
  for(const t of [0,5,8.137-1e-9,8.137,8.137+1e-9,11.019-1e-9,11.019,11.019+1e-9,13,20,...Array.from({length:241},(_,i)=>5+i/30)]){const wanted=bindingTime(p,oldBinding!,analysis,t),actual=bindingTime(twice,b,analysis,t);assert.ok(Math.abs(wanted-actual)<1e-9);near(motionDelta(p,oldBinding!,analysis,sample(wanted),t),motionDelta(twice,b,analysis,sample(actual),t));}
});
test('source timeline matches an independent interval oracle for overlaps, gaps, reordering and 10,000 pieces',()=>{
  let seed=12345;const rand=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/2**32,base=motionSource(scene().clips[0]);
  const sources:ResolvedMotionSource[]=Array.from({length:400},(_,index)=>({index,sourceClipId:'part-'+index,source:{...base,start:Math.floor(rand()*100)-20,duration:1+Math.floor(rand()*12)}})),timeline=new MotionSourceTimeline(sources);
  const oracle=(time:number)=>{const active=sources.filter(s=>s.source.start<=time&&time<s.source.start+s.source.duration).sort((a,b)=>b.source.start-a.source.start||b.index-a.index);if(active.length)return active[0];const ended=sources.filter(s=>s.source.start+s.source.duration<=time).sort((a,b)=>(b.source.start+b.source.duration)-(a.source.start+a.source.duration)||b.source.start-a.source.start||b.index-a.index);return ended[0]||[...sources].sort((a,b)=>a.source.start-b.source.start||a.index-b.index)[0];};
  for(let t=-25;t<110;t+=.125)assert.equal(timeline.at(t).index,oracle(t).index);for(const r of timeline.ranges(-25,110)){assert.equal(timeline.at(r.from),r.value);assert.equal(timeline.at((r.from+r.to)/2),r.value);}
  const many=Array.from({length:10000},(_,index)=>({index,source:{...base,start:index*.1,duration:.1}})),large=new MotionSourceTimeline(many);for(const i of [0,1,57,4999,9999])assert.equal(large.at(i*.1+.05).index,i);assert.ok(large.ranges(0,1000).length<=20000);
});
test('edited, moved, trimmed and deleted pieces resolve individually; detached snapshots and copies retain the correct clocks',()=>{
  const {project:p,parts}=split(scene(),'source',9),right=parts[1].id,edited={...p,clips:p.clips.map(c=>c.id===right?{...trimClip(c,.5,3.5),start:11,x:333,scale:1.5,keyframes:[]}:c)},b=edited.clips.find(c=>c.id==='text')!.motionBinding!;assertProject(edited);
  const timeline=new MotionSourceTimeline(resolveMotionSources(edited,b));assert.equal(timeline.at(10).sourceClipId,'source');assert.equal(timeline.at(11).sourceClipId,right);assert.equal(timeline.at(11).source.x,333);
  const removed=reconcileMotion(edited,{...edited,clips:edited.clips.filter(c=>c.id!==right)}),rb=removed.clips.find(c=>c.id==='text')!.motionBinding!;assertProject(removed);assert.equal(rb.segments![0].sourceClipId,undefined);assert.equal(rb.segments![0].source.x,333);assert.deepEqual(motionDelta(removed,rb,analysis,sample(7),12),motionDelta(edited,b,analysis,sample(7),12));
  const caption=removed.clips.find(c=>c.id==='text')!,only=copyMotionBindings(removed,[{...caption,id:'copy',start:15}],new Map(),10)[0];assert.equal(only.motionBinding!.segments![0].source.start,11,'a detached piece does not shift away from other still-live pieces when only the follower is copied');
  const ids=new Map([['source','new-source'],['text','new-text']]),both=copyMotionBindings(removed,removed.clips.map(c=>({...c,id:ids.get(c.id)!,start:c.start+10})),ids,10);assert.equal(both[1].motionBinding!.sourceClipId,'new-source');assert.equal(both[1].motionBinding!.segments![0].source.start,21);assertProject({...removed,clips:both});assert.ok(Math.abs(bindingTime({...removed,clips:both},both[1].motionBinding!,analysis,22)-bindingTime(removed,rb,analysis,12))<1e-9);
  const resized=resizeProject(removed,500,1000);assert.equal(resized.clips[1].motionBinding!.segments![0].source.x,333*.5);assertProject(resized);
});
test('reviewing and reanalyzing either half retains every source link and guards edits to another half',()=>{
  const {project:p,parts}=split(scene(),'source',9),right=parts[1].id,target=planTracking(p,'text',11);assert.equal(target.source.id,right);assert.equal(target.sourceIndex,1);
  const at=trackingReference(p,target,3);assert.ok(at.time<9);assert.equal(at.link.sourceClipId,'source');const t=11,oldTime=bindingTime(p,p.clips.find(c=>c.id==='text')!.motionBinding!,analysis,t),old=sample(oldTime),updated={...analysis,id:'updated',path:'C:\\updated.slutrack'},result=applyTracking(p,target,{analysis:updated,sample:old,sourceTime:oldTime,targetId:'ignored',text:'',followScale:true,previousSample:old});assert.equal(result.clip.motionBinding!.segments![0].sourceClipId,right);assert.equal(result.clip.motionBinding!.sourceClipId,'source');
  const c=p.clips.find(c=>c.id==='text')!;near(applyMotion(interpolate(c,t-c.start),motionDelta(p,c.motionBinding!,analysis,old,t)),applyMotion(interpolate(result.clip,t-result.clip.start),motionDelta(result.project,result.clip.motionBinding!,updated,old,t)));assertProject(result.project);
  const edited={...p,clips:p.clips.map(c=>c.id==='source'?{...c,x:c.x+1}:c)};assert.throws(()=>validateTrackingTarget(edited,target),/분할/);
  const gone=reconcileMotion(p,{...p,clips:p.clips.filter(c=>c.id!==right)}),detached=planTracking(gone,'text',11);assert.equal(detached.detached,true);assert.equal(detached.sourceIndex,1);assert.equal(trackingReference(gone,detached,oldTime).time,t);
  const unbound=detachMotion(result.project,'text',t,old);assert.equal(unbound.clips.find(c=>c.id==='text')!.motionBinding,undefined);
});
test('invalid segment graphs are rejected before use without changing the prior project',()=>{
  const {project:p}=split(scene(),'source',9);for(const mutate of [(q:Project)=>{q.clips.at(-1)!.motionBinding!.segments![0].sourceClipId='text';},(q:Project)=>{q.clips.at(-1)!.motionBinding!.segments![0].sourceClipId='source';},(q:Project)=>{q.clips.at(-1)!.motionBinding!.segments![0].source.mediaId='other';},(q:Project)=>{q.clips.at(-1)!.motionBinding!.segments![0].source.start=NaN;},(q:Project)=>{q.clips.at(-1)!.motionBinding!.segments!.push(null as never);}]){const q=structuredClone(p);mutate(q);assert.throws(()=>assertProject(q));}
});
test('a fractional absolute clip end holds the last included source frame despite subtraction roundoff',()=>{
  const p=scene(),s=p.clips[0],b=p.clips[1].motionBinding!;Object.assign(s,{start:.3,duration:.6,in:2.2,speed:1,speedCurve:undefined,keyframes:[]});const end=s.start+s.duration;assert.ok(end-s.start<s.duration,'fixture exercises cancellation rounding');
  const t=bindingTime(p,b,analysis,end);assert.ok(t<2.8);assert.ok(Math.abs(t-(2.8-.000001))<1e-12);assert.equal(bindingTime(p,b,analysis,end+1),t);
});
