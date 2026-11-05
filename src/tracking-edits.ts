import type {Clip,MediaAsset,Project} from '../shared/types';
import {assertMotionAnalysis,validMotionBox,type MotionAnalysis,type MotionSample} from '../shared/tracking';
import {newClip,uid} from '../shared/project';
import {clipSourceSpan,clipSourceTime,clipTimelineTime} from '../shared/speed';
import {motionSource,motionPoint,motionDelta,createMotionBinding,reconcileMotion} from '../shared/motion';
import {resolveMotionSources,MotionSourceTimeline} from '../shared/motion-sources';
import {assertProject} from '../shared/validation';
import {defaultCaptionStyle,defaultCaptionAnimation} from '../shared/captions';

export interface TrackingTarget {projectId:string;width:number;height:number;source:Clip;sourceIndex:number;relatedSources:Clip[];media:MediaAsset;start:number;end:number;time:number;existing?:{clip:Clip;analysis:MotionAnalysis};detached:boolean}
const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
export function planTracking(project:Project,clipId:string,playhead:number):TrackingTarget {
  const chosen=project.clips.find(c=>c.id===clipId);if(!chosen)throw new Error('추적할 영상 클립을 선택하세요.');if(project.tracks.find(t=>t.id===chosen.trackId)?.locked)throw new Error('잠긴 트랙의 추적은 수정할 수 없습니다.');
  const binding=chosen.motionBinding,analysis=binding?project.motionPaths?.find(a=>a.id===binding.analysisId):undefined;
  if(binding&&!analysis)throw new Error('연결된 추적 경로를 찾지 못했습니다.');
  const media=project.media.find(m=>m.id===(analysis?.mediaId||chosen.mediaId));if(!media||media.kind!=='video')throw new Error('영상 클립 또는 추적이 연결된 자막·이미지를 선택하세요.');
  if(analysis&&analysis.sourceRevision!==media.sourceRevision)throw new Error('원본 파일이 변경되었습니다. 기존 연결을 해제한 뒤 다시 추적하세요.');
  const sources=binding?resolveMotionSources(project,binding):[],active=binding?new MotionSourceTimeline(sources).at(playhead):undefined,live=active?.sourceClipId?project.clips.find(c=>c.id===active.sourceClipId):undefined;
  const source=binding?(live||{...newClip('video-1',media),...active!.source,id:'detached-tracking-source'}):chosen,relatedSources=sources.flatMap(s=>s.sourceClipId?[project.clips.find(c=>c.id===s.sourceClipId)!]:[]);
  if(source.text!==undefined||source.motionBinding||(!binding&&project.tracks.find(t=>t.id===source.trackId)?.type!=='video'))throw new Error('영상 트랙의 원본 클립을 선택하세요.');
  const start=analysis?.start??Math.max(source.in,media.videoStart??0),end=analysis?.end??Math.min(source.in+clipSourceSpan(source),media.videoEnd??media.duration);
  if(end<=start||end-start>86400)throw new Error('추적할 영상 구간은 0초보다 길고 24시간 이하여야 합니다.');
  const time=clamp(clipSourceTime(source,clamp(playhead-source.start,0,source.duration)),start,Math.min(end,clipSourceTime(source,source.duration))-.000001);
  return structuredClone({projectId:project.id,width:project.width,height:project.height,source,sourceIndex:active?.index||0,relatedSources,media,start,end,time,existing:analysis?{clip:chosen,analysis}:undefined,detached:!!binding&&!live});
}
export function validateTrackingTarget(project:Project,target:TrackingTarget){
  if(project.id!==target.projectId||project.width!==target.width||project.height!==target.height)throw new Error('프로젝트가 변경되었습니다. 추적 화면을 다시 여세요.');
  const media=project.media.find(m=>m.id===target.media.id);if(!media||media.path!==target.media.path||media.sourceRevision!==target.media.sourceRevision)throw new Error('추적 원본 파일이 변경되었습니다.');
  if(!target.detached){const source=project.clips.find(c=>c.id===target.source.id);if(JSON.stringify(source)!==JSON.stringify(target.source)||project.tracks.find(t=>t.id===source?.trackId)?.locked)throw new Error('원본 클립이 변경되었거나 잠겼습니다. 추적 화면을 다시 여세요.');}
  for(const old of target.relatedSources){const source=project.clips.find(c=>c.id===old.id);if(JSON.stringify(source)!==JSON.stringify(old)||project.tracks.find(t=>t.id===source?.trackId)?.locked)throw new Error('분할된 원본 클립이 변경되었거나 잠겼습니다. 추적 화면을 다시 여세요.');}
  if(target.existing){const c=project.clips.find(c=>c.id===target.existing!.clip.id);if(JSON.stringify(c)!==JSON.stringify(target.existing.clip)||JSON.stringify(project.motionPaths?.find(a=>a.id===target.existing!.analysis.id))!==JSON.stringify(target.existing.analysis)||project.tracks.find(t=>t.id===c?.trackId)?.locked)throw new Error('연결된 클립 또는 경로가 변경되었거나 잠겼습니다.');}
}
/** Map the reviewed original frame back through the selected split piece. A
 * trimmed-out/occluded source moment can be reviewed, but is not an attachment
 * reference on this timeline. Never silently bind its sample to another time. */
export function trackingReference(project:Project,target:TrackingTarget,sourceTime:number){
  const binding=target.existing?.clip.motionBinding,sources=binding?resolveMotionSources(project,binding):[{index:0,source:motionSource(target.source),sourceClipId:target.detached?undefined:target.source.id}],timeline=new MotionSourceTimeline(sources);
  for(const link of [...sources].sort((a,b)=>Number(b.index===target.sourceIndex)-Number(a.index===target.sourceIndex))){const s=link.source,c=s as Clip,end=clipSourceTime(c,s.duration);if(sourceTime<s.in-1e-6||sourceTime>=end)continue;const time=s.start+clipTimelineTime(c,sourceTime);if(timeline.at(time).index!==link.index)continue;return {time,link,sources};}
  throw new Error('이 원본 시각에 해당하는 타임라인 구간이 없습니다. 연결된 원본 조각의 시각으로 이동한 뒤 적용하세요.');
}
export function detachMotion(project:Project,clipId:string,time:number,sample?:MotionSample):Project {
  const c=project.clips.find(c=>c.id===clipId),b=c?.motionBinding;if(!c||!b)return project;
  if(project.tracks.find(t=>t.id===c.trackId)?.locked)throw new Error('잠긴 트랙의 연결은 해제할 수 없습니다.');
  const analysis=project.motionPaths?.find(a=>a.id===b.analysisId);if(sample&&!analysis)throw new Error('추적 경로가 없습니다.');
  const delta=sample?motionDelta(project,b,analysis!,sample,time):{x:0,y:0,scale:1},move=<T extends {x:number;y:number;scale:number}>(p:T):T=>({...p,x:p.x+delta.x,y:p.y+delta.y,scale:p.scale*delta.scale});
  const result=reconcileMotion(project,{...project,clips:project.clips.map(v=>v.id===c.id?{...move(c),keyframes:c.keyframes.map(move),motionBinding:undefined}:v)});assertProject(result);return result;
}
export interface TrackingApply {analysis:MotionAnalysis;sample:MotionSample;sourceTime:number;targetId:string;text:string;followScale:boolean;previousSample?:MotionSample}
export function applyTracking(project:Project,target:TrackingTarget,apply:TrackingApply):{project:Project;clip:Clip;time:number}{
  validateTrackingTarget(project,target);const {analysis,sample,sourceTime,followScale}=apply;assertMotionAnalysis(analysis);
  if(!Number.isFinite(sourceTime)||!Number.isFinite(sample.time)||!validMotionBox(sample.box))throw new Error('추적 기준 프레임이 올바르지 않습니다.');
  if(analysis.mediaId!==target.media.id||analysis.sourceRevision!==target.media.sourceRevision||sourceTime<analysis.start||sourceTime>=analysis.end||sample.time>sourceTime+1e-6||sample.time<analysis.start)throw new Error('추적 결과의 원본 또는 기준 시각이 일치하지 않습니다.');
  const reference=trackingReference(project,target,sourceTime),{time}=reference;if(time<0||time>=86400)throw new Error('연결 시각이 타임라인 범위를 벗어났습니다.');let p=project,c:Clip|undefined;
  if(target.existing){if(!apply.previousSample)throw new Error('기존 추적 위치를 확인하지 못했습니다.');p=detachMotion(p,target.existing.clip.id,time,apply.previousSample);c=p.clips.find(c=>c.id===target.existing!.clip.id);}
  else if(apply.targetId==='new'){
    if(p.clips.length>=10000)throw new Error('클립은 최대 10,000개입니다.');let track=p.tracks.find(t=>t.type==='text'&&!t.locked);if(!track){if(p.tracks.length>=100)throw new Error('트랙은 최대 100개입니다.');track={id:uid(),name:'추적 텍스트',type:'text',muted:false,hidden:false,locked:false};p={...p,tracks:[...p.tracks,track]};}
    const from=Math.max(target.source.start,target.source.start+clipTimelineTime(target.source,analysis.start)),to=Math.min(target.source.start+target.source.duration,target.source.start+clipTimelineTime(target.source,analysis.end));if(to-from<Math.max(.01,1/p.fps))throw new Error('텍스트를 넣을 추적 구간이 한 프레임보다 짧습니다.');
    const point=motionPoint(p,motionSource(target.source),analysis,sample,time),fontSize=clamp(Math.round(Math.min(p.width,p.height)*.06),16,96),text=apply.text.trim()||'텍스트';
    c={...newClip(track.id),start:from,duration:to-from,text,name:text.slice(0,100),fontSize,x:point.x-p.width/2,y:point.y-p.height/2-fontSize*1.2,captionStyle:defaultCaptionStyle(),captionAnimation:defaultCaptionAnimation(),animation:'none'};p={...p,clips:[...p.clips,c]};
  }else c=p.clips.find(c=>c.id===apply.targetId);
  if(!c||c.motionBinding||(c.text===undefined&&p.media.find(m=>m.id===c!.mediaId)?.kind!=='image')||p.tracks.find(t=>t.id===c!.trackId)?.locked)throw new Error('잠기지 않은 자막·이미지를 선택하세요. 이미 연결된 클립은 해당 클립의 추적 검토를 사용하세요.');
  const links=reference.sources.map(({source,sourceClipId})=>({sourceClipId,source:motionSource(source as Clip)})),binding={...createMotionBinding(p,reference.link.source,analysis,sample,time,followScale,reference.link.sourceClipId),...links[0],segments:links.length>1?links.slice(1):undefined},paths=[...(p.motionPaths||[])],existing=paths.find(a=>a.id===analysis.id);if(existing&&JSON.stringify(existing)!==JSON.stringify(analysis))throw new Error('다른 추적 경로에 같은 ID가 있습니다.');if(!existing)paths.push(analysis);
  const clip={...c,motionBinding:binding},result=reconcileMotion(p,{...p,version:10,motionPaths:paths,clips:p.clips.map(v=>v.id===c!.id?clip:v)});assertProject(result);return {project:result,clip,time};
}
