import type {Clip,Project,Keyframe} from './types';
import {pruneProjectFiles} from './project-files';
import type {MotionAnalysis,MotionBinding,MotionSample,MotionSource,MotionSourceLink} from './tracking';
import {interpolate} from './project';
import {clipSourceTime} from './speed';
import {motionLinks,resolveMotionSources,MotionSourceTimeline} from './motion-sources';
import {assertProjectMotion} from './motion-validation';

const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
export function motionSource(clip:Clip):MotionSource {
  if(!clip.mediaId||clip.motionBinding)throw new Error('추적 원본에는 움직임 연결이 없는 영상 클립이 필요합니다.');
  const {mediaId,start,duration,in:sourceIn,speed,speedCurve,x,y,scale,rotation,keyframes,fit,flipH,flipV,crop}=clip;
  return structuredClone({mediaId,start,duration,in:sourceIn,speed,speedCurve,x,y,scale,rotation,keyframes,fit,flipH,flipV,crop});
}
export function bindingSource(project:Project,binding:MotionBinding,time=0):MotionSource {
  const sources=resolveMotionSources(project,binding);return sources.length===1?sources[0].source:new MotionSourceTimeline(sources).at(time).source;
}
export function bindingTime(project:Project,binding:MotionBinding,analysis:MotionAnalysis,time:number,source:MotionSource=bindingSource(project,binding,time)){
  const ended=time>=source.start+source.duration,local=ended?source.duration:clamp(time-source.start,0,source.duration);
  // A clip's end is exclusive. Gaps/after-end holds must not read the first
  // frame belonging to the next cut from a longer shared analysis file.
  const clock=clipSourceTime(source as Clip,local),held=ended?Math.max(source.in,clock-.000001):clock;
  return clamp(held,analysis.start,analysis.end);
}
/** Held source-frame lookup. The caller must ensure its bounded page covers time. */
export function motionSampleAt(samples:readonly MotionSample[],time:number):MotionSample|undefined {
  if(!samples.length)return;let lo=0,hi=samples.length;while(lo<hi){const mid=(lo+hi)>>>1;if(samples[mid].time<=time+1e-9)lo=mid+1;else hi=mid;}return samples[Math.max(0,lo-1)];
}
/** Map displayed-source pixels through crop, fit, mirror and animated transform.
 * Size uses geometric mean of box dimensions, so optional size following has
 * one isotropic scale and never distorts the attached caption or image. */
export function motionPoint(project:Pick<Project,'width'|'height'>,source:MotionSource,analysis:MotionAnalysis,sample:MotionSample,time:number){
  const local=clamp(time-source.start,0,source.duration),state=interpolate({...source,opacity:1} as Clip,local),crop=source.crop||{left:0,top:0,right:0,bottom:0};
  const width=analysis.sourceWidth,height=analysis.sourceHeight,sw=Math.max(1,width*(1-crop.left-crop.right)),sh=Math.max(1,height*(1-crop.top-crop.bottom));
  const ratio=(source.fit==='cover'?Math.max:Math.min)(project.width/sw,project.height/sh);
  const x=((sample.box.x+sample.box.width/2-crop.left)*width-sw/2)*ratio*state.scale*(source.flipH?-1:1);
  const y=((sample.box.y+sample.box.height/2-crop.top)*height-sh/2)*ratio*state.scale*(source.flipV?-1:1),r=state.rotation*Math.PI/180;
  return {x:project.width/2+state.x+x*Math.cos(r)-y*Math.sin(r),y:project.height/2+state.y+x*Math.sin(r)+y*Math.cos(r),size:Math.sqrt(sample.box.width*width*sample.box.height*height)*ratio*state.scale};
}
export function motionDelta(project:Project,binding:MotionBinding,analysis:MotionAnalysis,sample:MotionSample,time:number,source:MotionSource=bindingSource(project,binding,time)){
  const point=motionPoint(project,source,analysis,sample,time);
  return {x:point.x-binding.reference.x,y:point.y-binding.reference.y,scale:binding.followScale?point.size/binding.reference.size:1};
}
export function applyMotion(state:Keyframe,delta:{x:number;y:number;scale:number}):Keyframe{return {...state,x:state.x+delta.x,y:state.y+delta.y,scale:state.scale*delta.scale};}
export function createMotionBinding(project:Project,source:MotionSource,analysis:MotionAnalysis,sample:MotionSample,time:number,followScale:boolean,sourceClipId?:string):MotionBinding{
  const crop=source.crop||{left:0,right:0,top:0,bottom:0};
  return {analysisId:analysis.id,sourceClipId,source:structuredClone(source),reference:{...motionPoint(project,source,analysis,sample,time),fit:source.fit,width:Math.max(1,analysis.sourceWidth*(1-crop.left-crop.right)),height:Math.max(1,analysis.sourceHeight*(1-crop.top-crop.bottom))},followScale};
}
export function attachMotion(project:Project,sourceId:string,targetIds:string[],analysis:MotionAnalysis,sample:MotionSample,time:number,followScale:boolean):Project {
  const source=project.clips.find(c=>c.id===sourceId),media=project.media.find(m=>m.id===source?.mediaId);
  if(!source||media?.kind!=='video'||media.id!==analysis.mediaId||media.sourceRevision!==analysis.sourceRevision)throw new Error('추적 원본 클립 또는 파일이 변경되었습니다.');
  if(!Number.isFinite(time)||time<source.start||time>=source.start+source.duration||sample.time<analysis.start||sample.time>=analysis.end)throw new Error('추적 연결 기준 시각이 범위를 벗어났습니다.');
  const snapshot=motionSource(source),binding=createMotionBinding(project,snapshot,analysis,sample,time,followScale,source.id),ids=new Set(targetIds);
  if(!ids.size||targetIds.length!==ids.size||[...ids].some(id=>!project.clips.some(c=>c.id===id)))throw new Error('움직임을 연결할 자막 또는 이미지를 선택하세요.');
  for(const c of project.clips.filter(c=>ids.has(c.id))){
    if(c.id===source.id||(c.text===undefined&&project.media.find(m=>m.id===c.mediaId)?.kind!=='image')||project.tracks.find(t=>t.id===c.trackId)?.locked)throw new Error('잠기지 않은 자막 또는 이미지에 움직임을 연결하세요.');
    if(c.motionBinding)throw new Error('기존 움직임 연결을 먼저 해제하세요.');
  }
  const existing=project.motionPaths?.find(a=>a.id===analysis.id);
  if(existing&&JSON.stringify(existing)!==JSON.stringify(analysis))throw new Error('다른 추적 경로에 같은 ID가 있습니다.');
  const paths=existing?project.motionPaths!:[...(project.motionPaths||[]),analysis];if(paths.length>1000)throw new Error('프로젝트의 추적 경로는 최대 1,000개입니다.');
  return {...project,version:10,motionPaths:paths,clips:project.clips.map(c=>ids.has(c.id)?{...c,motionBinding:binding}:c)};
}
/** Preserve the last live source geometry when it is deleted or replaced. */
export function reconcileMotion(previous:Project,next:Project):Project {
  let changed=false;const before=new Map(previous.clips.map(c=>[c.id,c])),after=new Map(next.clips.map(c=>[c.id,c]));
  const clips=next.clips.map(c=>{const b=c.motionBinding;if(!b)return c;let modified=false;const links=motionLinks(b).map(link=>{if(!link.sourceClipId)return link;const live=after.get(link.sourceClipId);if(live&&live.mediaId===link.source.mediaId&&!live.motionBinding)return link;
    const old=before.get(link.sourceClipId);modified=true;return {sourceClipId:undefined,source:old&&old.mediaId===link.source.mediaId&&!old.motionBinding?motionSource(old):link.source};});
    if(!modified)return c;changed=true;return {...c,motionBinding:{...b,...links[0],segments:links.length>1?links.slice(1):undefined}};
  });const used=new Set(clips.flatMap(c=>c.motionBinding?[c.motionBinding.analysisId]:[])),paths=next.motionPaths?.filter(a=>used.has(a.id));
  return pruneProjectFiles(changed||paths?.length!==next.motionPaths?.length?{...next,clips,motionPaths:paths?.length?paths:undefined}:next);
}
export function copyMotionBindings(project:Project,clips:Clip[],ids:ReadonlyMap<string,string>,timeShift:number):Clip[]{
  const lookup=new Map(project.clips.map(c=>[c.id,c]));return clips.map(c=>{const b=c.motionBinding;if(!b)return c;const sources=resolveMotionSources(project,b,lookup),shiftDetached=sources.every(s=>!s.sourceClipId||ids.has(s.sourceClipId)),links=sources.map(({sourceClipId,source}):MotionSourceLink=>{const copied=sourceClipId?ids.get(sourceClipId):undefined;return {sourceClipId:copied||sourceClipId,source:{...motionSource(source as Clip),start:source.start+(copied||(!sourceClipId&&shiftDetached)?timeShift:0)}};});
    return {...c,motionBinding:{...b,...links[0],segments:links.length>1?links.slice(1):undefined}};
  });
}
/** Splitting a source changes dependency metadata only. Locked followers retain
 * their timing, text and manual keys while their picture remains continuous. */
export function splitMotionSources(project:Project,clips:Clip[],splits:ReadonlyMap<string,readonly Clip[]>):Project{
  const result={...project,clips:clips.map(c=>{const b=c.motionBinding;if(!b)return c;let changed=false;const links=motionLinks(b).flatMap(link=>{const pieces=link.sourceClipId?splits.get(link.sourceClipId):undefined;if(!pieces)return [link];changed=true;return pieces.map(piece=>({sourceClipId:piece.id,source:motionSource(piece)}));});return changed?{...c,motionBinding:{...b,...links[0],segments:links.length>1?links.slice(1):undefined}}:c;})};assertProjectMotion(result);return result;
}
export function restoreMotionPaths(project:Project,clips:Clip[],available:readonly MotionAnalysis[]):Project{
  const ids=new Set(clips.flatMap(c=>c.motionBinding?[c.motionBinding.analysisId]:[])),paths=[...(project.motionPaths||[])];
  for(const id of ids)if(!paths.some(a=>a.id===id)){const a=available.find(a=>a.id===id);if(!a||!project.media.some(m=>m.id===a.mediaId&&m.sourceRevision===a.sourceRevision))throw new Error('복사한 클립의 추적 원본 또는 경로가 없습니다.');paths.push(a);}
  return {...project,motionPaths:paths.length?paths:undefined};
}
export function resizeMotionBinding(b:MotionBinding|undefined,old:Pick<Project,'width'|'height'>,width:number,height:number):MotionBinding|undefined {
  if(!b)return;const sx=width/old.width,sy=height/old.height,ref=b.reference,fit=ref.fit==='cover'?Math.max:Math.min;
  const ratio=fit(width/ref.width,height/ref.height)/fit(old.width/ref.width,old.height/ref.height),point=<T extends {x:number;y:number}>(p:T):T=>({...p,x:clamp(p.x*sx,-16384,16384),y:clamp(p.y*sy,-16384,16384)});
  const resize=(s:MotionSource)=>({...point(s),keyframes:s.keyframes.map(point)});
  return {...b,reference:{...ref,x:ref.x*sx,y:ref.y*sy,size:ref.size*ratio},source:resize(b.source),segments:b.segments?.map(link=>({...link,source:resize(link.source)}))};
}
