import type {Clip,MediaAsset,Project} from '../shared/types';
import {clipSourceTime} from '../shared/speed';
import {compileTransitions} from '../shared/transitions';
import {uid} from '../shared/project';
import {clipState} from './preview/math';
import {minClipDuration} from './editor';
import {insertClip} from './timeline-model';

export const minFreezeFrames=(fps:number)=>Math.ceil(minClipDuration(fps)*fps-1e-7);
export function planFreeze(project:Project,clipId:string,at:number,duration:number){
  const clip=project.clips.find(c=>c.id===clipId),media=project.media.find(m=>m.id===clip?.mediaId),track=project.tracks.find(t=>t.id===clip?.trackId),minimum=minClipDuration(project.fps);
  if(!clip||!media||media.kind!=='video'||track?.type!=='video')throw new Error('영상 트랙의 영상 클립을 선택하세요.');
  if(track.locked)throw new Error('잠긴 트랙에는 정지 프레임을 넣을 수 없습니다.');
  if(!Number.isFinite(at)||at<clip.start-1e-7||at>=clip.start+clip.duration-1e-7)throw new Error('재생헤드를 선택한 영상 클립 안으로 옮기세요.');
  if(!Number.isFinite(duration)||duration<minimum-1e-7||duration>3600)throw new Error(`정지 길이는 ${minFreezeFrames(project.fps)}프레임 이상, 1시간 이하로 입력하세요.`);
  if(Math.abs(duration*project.fps-Math.round(duration*project.fps))>1e-6)throw new Error('정지 길이는 프레임 단위로 입력하세요.');
  at=Math.abs(at-clip.start)<1e-7?clip.start:at;
  for(const c of project.clips.filter(c=>c.trackId===track.id)){
    const left=at-c.start,right=c.start+c.duration-at;
    if(left>1e-7&&right>1e-7&&(left<minimum-1e-7||right<minimum-1e-7))throw new Error('잘린 구간이 한 프레임보다 짧아집니다. 재생헤드를 한 프레임 안쪽으로 옮기세요.');
    if(c.start+c.duration>at&&c.start+c.duration+duration>86400+1e-7)throw new Error('타임라인 최대 길이 24시간을 넘을 수 없습니다.');
  }
  if(compileTransitions(project).transitions.some(t=>t.trackId===track.id&&at>=t.start&&at<t.end))throw new Error('전환 구간 밖에서 정지 프레임을 삽입하세요.');
  const sourceTime=clipSourceTime(clip,at-clip.start);if(sourceTime<0||sourceTime>=media.duration)throw new Error('재생헤드가 원본 영상 범위를 벗어났습니다.');
  return {clip,media,at,duration,sourceTime};
}
export function insertFreeze(project:Project,clipId:string,at:number,duration:number,image:MediaAsset):{project:Project;clip:Clip}{
  if(image.kind!=='image')throw new Error('정지 프레임 이미지가 필요합니다.');
  const plan=planFreeze(project,clipId,at,duration),state=clipState(plan.clip,plan.at);
  if(state.scale<.01||state.scale>8||Math.abs(state.y)>16384)throw new Error('현재 애니메이션의 확대·위치가 정지 클립의 지원 범위를 벗어납니다.');
  const frozen:Clip={...structuredClone(plan.clip),x:state.x,y:state.y,scale:state.scale,opacity:state.opacity,rotation:state.rotation,id:uid(),name:`${plan.clip.name} · 정지`,mediaId:image.id,start:plan.at,duration:plan.duration,in:0,speed:1,speedCurve:undefined,volume:0,audioEQ:undefined,fadeIn:0,fadeOut:0,keyframes:[],animation:'none',captionAnimation:undefined,captionWords:undefined,stabilization:undefined,reversal:undefined,cutout:undefined,sourceClipOffset:undefined,sourceClipDuration:undefined};
  const clips=insertClip(project,frozen,'insert');if(clips.length>10000)throw new Error('프로젝트당 최대 10,000개 클립을 지원합니다.');
  const media=project.media.some(m=>m.id===image.id)?project.media:[...project.media,image];if(media.length>2000)throw new Error('프로젝트당 최대 2,000개 미디어를 지원합니다.');
  return {project:{...project,media,clips},clip:frozen};
}
