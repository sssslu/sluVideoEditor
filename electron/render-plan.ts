import type {Project,ExportSettings} from '../shared/types';
import {projectDuration} from '../shared/project';
import {audioTrackEnabled,visualTrackEnabled} from '../shared/effects';
import {compileTransitions,type TransitionPlan} from '../shared/transitions';
import {captionLayerGroups} from './render-captions';

export interface RenderWindow {startFrame:number;frames:number;start:number;duration:number;visualInputs:number}
export function planRenderWindows(project:Project,settings:ExportSettings,maxSeconds=6,transitionPlan:TransitionPlan=compileTransitions(project)):RenderWindow[]{
  const fps=settings.fps,totalFrames=Math.max(1,Math.ceil(projectDuration(project)*fps-1e-7));
  const tracks=new Map(project.tracks.map(t=>[t.id,t])),media=new Map(project.media.map(m=>[m.id,m]));
  const visual=settings.format==='wav'?[]:project.clips.filter(c=>c.text===undefined&&media.get(c.mediaId||'')?.kind!=='audio'&&visualTrackEnabled(project,tracks.get(c.trackId))).map(clip=>{const e=transitionPlan.byClip.get(clip.id)!;return {clip,start:clip.start+e.visualFrom,end:clip.start+e.visualTo};});
  const audio=settings.format==='gif'?[]:project.clips.filter(c=>c.text===undefined&&c.volume>0&&media.get(c.mediaId||'')?.hasAudio&&audioTrackEnabled(project,tracks.get(c.trackId))).map(clip=>{const e=transitionPlan.byClip.get(clip.id)!;return {clip,start:clip.start+e.audioFrom,end:clip.start+e.audioTo};});
  const richCaptions=settings.format!=='wav'&&project.clips.some(c=>(c.captionStyle||(c.text!==undefined&&c.motionBinding))&&visualTrackEnabled(project,tracks.get(c.trackId)));
  for(const [clips,label] of [[visual,'영상'],[audio,'오디오']] as const){const events=clips.flatMap(c=>[{time:c.start,delta:1},{time:c.end,delta:-1}]).sort((a,b)=>a.time-b.time||a.delta-b.delta);let active=0;for(const event of events){active+=event.delta;if(active>32)throw new Error(`한 시점에 겹치는 ${label} 소스가 32개를 초과합니다. 일부 트랙을 먼저 합성해 주세요.`);}}
  const result:RenderWindow[]=[];const maxFrames=Math.max(1,Math.round(Math.min(30,Math.max(.25,maxSeconds))*fps));
  for(let startFrame=0;startFrame<totalFrames;){
    let endFrame=Math.min(totalFrames,startFrame+maxFrames);const start=startFrame/fps;
    let clips=visual.filter(c=>c.start<endFrame/fps&&c.end>start);
    if(clips.length>8){
      const active=clips.filter(c=>c.start<=start+1e-7).length,limit=Math.max(8,active);
      const later=clips.filter(c=>c.start>start+1e-7).sort((a,b)=>a.start-b.start);
      if(later.length>limit-active){const stop=later[limit-active].start;endFrame=Math.max(startFrame+1,Math.min(endFrame,Math.floor(stop*fps+1e-7)));clips=visual.filter(c=>c.start<endFrame/fps&&c.end>start);}
    }
    // Thousands of sequential captions must not become thousands of live
    // image streams merely because they alternate legacy and rich styles.
    if(richCaptions){const groups=captionLayerGroups(project,start,endFrame/fps).filter(group=>group.rich);if(groups.length>8){const next=groups.slice(8).flatMap(group=>group.clips.map(clip=>clip.start)).filter(time=>time>start+1/fps-1e-9).sort((a,b)=>a-b)[0];if(next!==undefined){endFrame=Math.max(startFrame+1,Math.min(endFrame,Math.ceil(next*fps-1e-7)));clips=visual.filter(c=>c.start<endFrame/fps&&c.end>start);}}}
    result.push({startFrame,frames:endFrame-startFrame,start,duration:(endFrame-startFrame)/fps,visualInputs:clips.length});startFrame=endFrame;
  }
  return result;
}
