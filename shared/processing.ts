import type {Clip,MediaAsset,Project,StabilizationOptions,SubtitleCue,PersonCutoutOptions} from './types';
import {clipSourceSpan,clipSourceTime,clipTimelineTime} from './speed';
import {assertCaptionWords} from './captions';

export function clipMediaAvailable(clip:Clip,media:readonly MediaAsset[]):boolean {
  return clipMediaIds(clip).every(id=>media.some(asset=>asset.id===id));
}
export function clipMediaIds(clip:Clip):string[] {
  const c=clip.cutout,e=clip.enhancement;
  return [...new Set([clip.mediaId,clip.motionBinding?.source.mediaId,clip.stabilization?.sourceMediaId,clip.reversal?.sourceMediaId,clip.reversal?.derivedMediaId,clip.reversal?.priorStabilization?.sourceMediaId,c?.sourceMediaId,c?.derivedMediaId,c?.priorStabilization?.sourceMediaId,c?.priorReversal?.sourceMediaId,c?.priorReversal?.derivedMediaId,c?.priorReversal?.priorStabilization?.sourceMediaId,e?.sourceMediaId,e?.derivedMediaId,e?.priorStabilization?.sourceMediaId,e?.priorReversal?.sourceMediaId,e?.priorReversal?.derivedMediaId,e?.priorReversal?.priorStabilization?.sourceMediaId].filter((id):id is string=>!!id))];
}

/** The fields whose changes invalidate analysis of a selected source interval. */
export function sameSourceInterval(a:Clip,b:Clip):boolean {
  return a.mediaId===b.mediaId&&a.in===b.in&&a.duration===b.duration&&a.speed===b.speed&&JSON.stringify(a.speedCurve)===JSON.stringify(b.speedCurve)&&JSON.stringify(a.stabilization)===JSON.stringify(b.stabilization)&&JSON.stringify(a.reversal)===JSON.stringify(b.reversal)&&JSON.stringify(a.cutout)===JSON.stringify(b.cutout)&&JSON.stringify(a.enhancement)===JSON.stringify(b.enhancement);
}
export function sourceCuesToTimeline(clip:Clip,cues:SubtitleCue[]):SubtitleCue[] {
  const end=clipSourceTime(clip,clip.duration);
  return cues.flatMap(cue=>{
    if(!Number.isFinite(cue.start)||!Number.isFinite(cue.end)||cue.end<=cue.start)return [];
    if(cue.words)assertCaptionWords(cue.text,cue.words,cue.start,cue.end);
    const sourceStart=Math.max(clip.in,cue.start),sourceEnd=Math.min(end,cue.end);
    if(sourceEnd<=sourceStart)return [];
    const timeline=(time:number)=>clip.start+clipTimelineTime(clip,time);
    const mapped:SubtitleCue={text:cue.text,start:timeline(sourceStart),end:timeline(sourceEnd)};
    if(cue.words){
      // The inverse source clock is nonlinear: map every boundary independently.
      const words=cue.words.flatMap(word=>{
        const start=Math.max(sourceStart,word.start),finish=Math.min(sourceEnd,word.end);
        return finish>start?[{...word,start:timeline(start),end:timeline(finish)}]:[];
      });
      if(words.length)mapped.words=words;
    }
    return [mapped];
  });
}
export function stabilizationSource(project:Project,clip:Clip){
  const source=clip.stabilization;
  const media=project.media.find(m=>m.id===(source?.sourceMediaId??clip.mediaId));
  if(!media||media.kind!=='video')throw new Error('보정할 원본 영상을 찾을 수 없습니다.');
  return {media,start:(source?.sourceIn??0)+clip.in,duration:clipSourceSpan(clip)};
}
/** Applying a processed source preserves the current timeline placement and all effects. */
export function applyStabilization(clip:Clip,media:MediaAsset,source:MediaAsset,start:number,options:StabilizationOptions):Clip {
  const {start:ignoredStart,duration:ignoredDuration,...settings}=options;
  return {...clip,mediaId:media.id,in:0,stabilization:{sourceMediaId:source.id,sourceIn:start,options:settings}};
}
export function restoreStabilization(clip:Clip):Clip {
  const state=clip.stabilization;
  return state?{...clip,mediaId:state.sourceMediaId,in:state.sourceIn+clip.in,stabilization:undefined}:clip;
}

export function reversalSource(project:Project,clip:Clip){
  const media=project.media.find(m=>m.id===clip.mediaId),duration=clipSourceSpan(clip);
  if(!media||!['video','audio'].includes(media.kind)||clip.reversal)throw new Error('역재생할 영상 또는 오디오 클립을 선택하세요.');
  if(clip.in+duration>media.duration+.002)throw new Error('역재생 구간이 원본 범위를 벗어났습니다.');
  return {media,start:clip.in,duration};
}
export function applyReversal(clip:Clip,media:MediaAsset):Clip {
  if(!clip.mediaId||clip.reversal)throw new Error('이미 역재생 중이거나 원본이 없는 클립입니다.');
  return {...clip,mediaId:media.id,in:0,stabilization:undefined,reversal:{sourceMediaId:clip.mediaId,sourceIn:clip.in,sourceDuration:clipSourceSpan(clip),derivedMediaId:media.id,priorStabilization:clip.stabilization?structuredClone(clip.stabilization):undefined}};
}
/** Reverse the selected source interval back into forward order. Timeline
 * effects/rate curves stay attached; trims select the opposite original end. */
export function restoreReversal(clip:Clip):Clip {
  const state=clip.reversal;if(!state)return clip;
  const effective=restoreStabilization(clip);
  if(effective.mediaId!==state.derivedMediaId)throw new Error('역재생 원본 연결이 일치하지 않습니다.');
  const offset=state.sourceDuration-effective.in-clipSourceSpan(effective);
  if(offset<-.002||effective.in<0)throw new Error('클립 구간이 역재생 원본 범위를 벗어났습니다.');
  return {...effective,mediaId:state.sourceMediaId,in:state.sourceIn+Math.max(0,offset),reversal:undefined,stabilization:state.priorStabilization?structuredClone(state.priorStabilization):undefined};
}

export function cutoutSource(project:Project,clip:Clip){
  const media=project.media.find(m=>m.id===clip.mediaId),duration=clipSourceSpan(clip);
  if(!media||media.kind!=='video'||clip.text!==undefined||clip.cutout)throw new Error('배경 제거할 영상 클립을 선택하세요.');
  if(media.hasAlpha)throw new Error('이미 투명한 영상에는 배경 제거를 적용할 수 없습니다.');
  if(clip.in+duration>media.duration+.002)throw new Error('배경 제거 구간이 원본 범위를 벗어났습니다.');
  return {media,start:clip.in,duration};
}
/** One cutout layer captures prior source operations. Later stabilization and
 * reversal use their existing, bounded provenance. Removing cutout unwinds
 * those later operations before restoring the corresponding original span. */
export function applyCutout(clip:Clip,media:MediaAsset,options:Pick<PersonCutoutOptions,'quality'>):Clip {
  if(!clip.mediaId||clip.cutout||media.kind!=='video'||!media.hasAlpha)throw new Error('배경 제거 결과 또는 원본 연결이 올바르지 않습니다.');
  return {...clip,mediaId:media.id,in:0,stabilization:undefined,reversal:undefined,cutout:{sourceMediaId:clip.mediaId,sourceIn:clip.in,sourceDuration:clipSourceSpan(clip),derivedMediaId:media.id,quality:options.quality??'portrait',priorStabilization:clip.stabilization?structuredClone(clip.stabilization):undefined,priorReversal:clip.reversal?structuredClone(clip.reversal):undefined}};
}
export function restoreCutout(clip:Clip):Clip {
  const state=clip.cutout;if(!state)return clip;
  const effective=restoreStabilization(restoreReversal(clip));
  if(effective.mediaId!==state.derivedMediaId||effective.in<0||effective.in+clipSourceSpan(effective)>state.sourceDuration+.002)throw new Error('배경 제거 원본 연결 또는 구간이 일치하지 않습니다.');
  return {...effective,mediaId:state.sourceMediaId,in:state.sourceIn+effective.in,cutout:undefined,stabilization:state.priorStabilization?structuredClone(state.priorStabilization):undefined,reversal:state.priorReversal?structuredClone(state.priorReversal):undefined};
}

export function enhancementSource(project:Project,clip:Clip){
  const media=project.media.find(m=>m.id===clip.mediaId),duration=clipSourceSpan(clip);
  if(!media||media.kind!=='video'||clip.text!==undefined||clip.enhancement)throw new Error('화질을 향상할 영상 클립을 선택하세요.');
  if(media.hasAlpha||clip.cutout)throw new Error('투명 영상은 화질 향상을 지원하지 않습니다. 배경 제거를 먼저 해제하세요.');
  if(clip.in+duration>media.duration+.002)throw new Error('화질 향상 구간이 원본 범위를 벗어났습니다.');
  return {media,start:clip.in,duration};
}
export function applyEnhancement(clip:Clip,media:MediaAsset,scale:2|4):Clip {
  if(!clip.mediaId||clip.enhancement||clip.cutout||media.kind!=='video'||media.hasAlpha||![2,4].includes(scale))throw new Error('화질 향상 결과 또는 원본 연결이 올바르지 않습니다.');
  return {...clip,mediaId:media.id,in:0,stabilization:undefined,reversal:undefined,enhancement:{sourceMediaId:clip.mediaId,sourceIn:clip.in,sourceDuration:clipSourceSpan(clip),derivedMediaId:media.id,scale,priorStabilization:clip.stabilization?structuredClone(clip.stabilization):undefined,priorReversal:clip.reversal?structuredClone(clip.reversal):undefined}};
}
/** Later source operations are unwound in their nesting order. The retained
 * original interval remains usable after splits and nonlinear rate edits. */
export function restoreEnhancement(clip:Clip):Clip {
  const state=clip.enhancement;if(!state)return clip;
  const effective=restoreStabilization(restoreReversal(restoreCutout(clip)));
  if(effective.mediaId!==state.derivedMediaId||effective.in<0||effective.in+clipSourceSpan(effective)>state.sourceDuration+.002)throw new Error('화질 향상 원본 연결 또는 구간이 일치하지 않습니다.');
  return {...effective,mediaId:state.sourceMediaId,in:state.sourceIn+effective.in,enhancement:undefined,stabilization:state.priorStabilization?structuredClone(state.priorStabilization):undefined,reversal:state.priorReversal?structuredClone(state.priorReversal):undefined};
}
