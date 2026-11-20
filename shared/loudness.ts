import type {Clip,Project} from './types';
import {audioTrackEnabled} from './effects';

export const LOUDNESS_TARGET=-16;
export const LOUDNESS_PEAK=-1;
export type LoudnessSkip='locked'|'muted'|'no-audio'|'silent'|'short';
export interface LoudnessItem {clipId:string;volume?:number;integrated?:number;truePeak?:number;limited?:'peak'|'volume';skip?:LoudnessSkip}
export interface LoudnessResult {items:LoudnessItem[]}

export function loudnessSelection(project:Project,ids:readonly string[]):{clip:Clip;skip?:LoudnessSkip}[]{
  if(!Array.isArray(ids)||!ids.length||ids.length>10000||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new Error('음량을 맞출 클립을 선택하세요.');
  const clips=new Map(project.clips.map(c=>[c.id,c])),tracks=new Map(project.tracks.map(t=>[t.id,t])),media=new Map(project.media.map(m=>[m.id,m]));
  return ids.map(id=>{
    const clip=clips.get(id);if(!clip)throw new Error('선택한 클립이 변경되었습니다. 다시 선택하세요.');
    const track=tracks.get(clip.trackId),asset=media.get(clip.mediaId||'');
    const skip:LoudnessSkip|undefined=track?.locked?'locked':clip.text!==undefined||!asset?.hasAudio?'no-audio':clip.volume===0||!audioTrackEnabled(project,track)?'muted':undefined;
    return {clip,skip};
  });
}

/** Include audio-affecting inputs and transition neighbours, but allow cosmetic edits
 * and newly prepared thumbnails/proxies while the measurement is running. */
export function loudnessSignature(project:Project,ids:readonly string[]):string{
  loudnessSelection(project,ids);
  const related=new Set(ids),transitions=(project.transitions||[]).filter(t=>related.has(t.fromClipId)||related.has(t.toClipId));
  for(const t of transitions){related.add(t.fromClipId);related.add(t.toClipId);}
  const audio=({id,trackId,mediaId,text,start,duration,in:sourceIn,speed,speedCurve,volume,fadeIn,fadeOut,sourceClipOffset,sourceClipDuration,audioEQ}:Clip)=>({id,trackId,mediaId,text,start,duration,sourceIn,speed,speedCurve,volume,fadeIn,fadeOut,sourceClipOffset,sourceClipDuration,audioEQ});
  const mediaIds=new Set(project.clips.filter(c=>related.has(c.id)).map(c=>c.mediaId));
  return JSON.stringify({projectId:project.id,fps:project.fps,ids,clips:project.clips.filter(c=>related.has(c.id)).map(audio),tracks:project.tracks.map(({id,type,muted,solo,locked})=>({id,type,muted,solo,locked})),transitions,media:project.media.filter(m=>mediaIds.has(m.id)).map(({id,path,sourceRevision,hasAudio,duration})=>({id,path,sourceRevision,hasAudio,duration}))});
}

export function matchedVolume(volume:number,integrated:number,truePeak:number):Pick<LoudnessItem,'volume'|'limited'>{
  if(!Number.isFinite(volume)||volume<=0||volume>8||!Number.isFinite(integrated)||!Number.isFinite(truePeak))throw new Error('음량 측정값이 올바르지 않습니다.');
  // FFmpeg reports two decimal places; retain one extra hundredth of peak headroom.
  const targetGain=LOUDNESS_TARGET-integrated,peakGain=LOUDNESS_PEAK-truePeak-.01,volumeGain=20*Math.log10(8/volume),gain=Math.min(targetGain,peakGain,volumeGain);
  return {volume:Math.min(8,volume*10**(gain/20)),limited:gain<targetGain-.01?(peakGain<=volumeGain?'peak':'volume'):undefined};
}

/** One immutable replacement lets the editor record the entire selection as one undo. */
export function applyLoudnessResult(project:Project,ids:readonly string[],signature:string,result:LoudnessResult):Project{
  if(loudnessSignature(project,ids)!==signature)throw new Error('분석 중 클립 구간·음량·원본 또는 트랙이 변경되어 적용하지 않았습니다. 다시 실행하세요.');
  const selected=new Set(ids),eligible=new Set(loudnessSelection(project,ids).filter(item=>!item.skip).map(item=>item.clip.id));
  if(result.items.length!==ids.length||new Set(result.items.map(item=>item.clipId)).size!==ids.length||result.items.some(item=>!selected.has(item.clipId)||item.volume!==undefined&&(!eligible.has(item.clipId)||!!item.skip||!Number.isFinite(item.volume)||item.volume<0||item.volume>8)))throw new Error('음량 분석 결과가 올바르지 않습니다.');
  const volumes=new Map(result.items.filter(item=>item.volume!==undefined).map(item=>[item.clipId,item.volume!]));let changed=false;
  const clips=project.clips.map(clip=>{const volume=volumes.get(clip.id);if(volume===undefined||Math.abs(volume-clip.volume)<1e-7)return clip;changed=true;return {...clip,volume};});
  return changed?{...project,clips}:project;
}

export function loudnessSummary(result:LoudnessResult,applied=true):string{
  const measured=result.items.filter(item=>item.volume!==undefined).length,peak=result.items.filter(item=>item.limited==='peak').length,volume=result.items.filter(item=>item.limited==='volume').length;
  const labels:Record<LoudnessSkip,string>={locked:'잠김',muted:'음소거·솔로 제외', 'no-audio':'소리 없음',silent:'무음·측정 불가',short:'0.4초 미만'};
  const skipped=(Object.keys(labels) as LoudnessSkip[]).flatMap(skip=>{const count=result.items.filter(item=>item.skip===skip).length;return count?[`${labels[skip]} ${count}개`]:[];});
  return [`${measured}개 클립 음량 ${applied?'맞춤':'분석'} 완료`,...(peak?[`피크 제한 ${peak}개`]:[]),...(volume?[`800% 제한 ${volume}개`]:[]),...(skipped.length?[`제외: ${skipped.join(', ')}`]:[])].join(' · ')+'.';
}
