import { useCallback, useEffect, useRef, useState } from 'react';
import type { Clip, Project, SubtitleCue,MediaAsset,SpeedPoint,Track } from '../shared/types';
import { newClip, newProject, uid } from '../shared/project';
import {assertSpeedCurve,clipSourceSpan,speedCurveMean,MIN_SPEED,MAX_SPEED,MAX_CURVE_SPEED} from '../shared/speed';
import {reconcileTransitions} from '../shared/transition-edits';
import {assertCaptionWords,trimCaptionWords,defaultCaptionStyle,defaultCaptionAnimation,resizeCaptionStyle} from '../shared/captions';
import {previewProxyPath} from '../shared/media-clock';
import {reconcileMotion,resizeMotionBinding} from '../shared/motion';

export function useHistory() {
  const [project, setState] = useState<Project>(newProject);
  const current = useRef(project);
  const past = useRef<Project[]>([]);
  const future = useRef<Project[]>([]);
  // Filesystem revisions are external facts. Undo changes edits, not the bytes
  // now stored at a source path, nor the derivatives produced for those bytes.
  const sources=useRef(new Map<string,{asset:MediaAsset;seen:Set<string|undefined>}>());
  const rebasedAssets=useRef(new WeakMap<MediaAsset,{source:MediaAsset;asset:MediaAsset}>());
  const [revision, setRevision] = useState(0);
  // A text or color field records one undo step per focus, however many input events it sends.
  const coalesced=useRef<EventTarget|undefined>(undefined);
  useEffect(()=>{const end=(event:FocusEvent)=>{if(event.target===coalesced.current)coalesced.current=undefined;};document.addEventListener('focusout',end);return()=>document.removeEventListener('focusout',end);},[]);
  const [transitionNotice,setTransitionNotice]=useState<{count:number}|null>(null);
  const clearTransitionNotice=useCallback(()=>setTransitionNotice(null),[]);
  const rebase=useCallback((snapshot:Project)=>{
    let changed=false;
    const media=snapshot.media.map(asset=>{
      const authority=sources.current.get(asset.path)?.asset;if(!authority)return asset;
      const cached=rebasedAssets.current.get(asset);
      if(cached?.source===authority){changed ||= cached.asset!==asset;return cached.asset;}
      const merged=mergeAsset(asset,authority),keys=Object.keys(merged) as (keyof MediaAsset)[];
      const result=keys.length===Object.keys(asset).length&&keys.every(key=>asset[key]===merged[key])?asset:merged;
      rebasedAssets.current.set(asset,{source:authority,asset:result});changed ||= result!==asset;return result;
    });
    if(!changed)return {project:snapshot,detached:[] as string[]};
    const result=reconcileTransitions(snapshot,{...snapshot,media});
    return {...result,project:{...result.project,updatedAt:new Date().toISOString()}};
  },[]);
  const checkpoint = useCallback(() => {
    past.current = [...past.current.slice(-79), current.current];
    future.current = [];
    coalesced.current = undefined;
    setRevision(r => r + 1);
  }, []);
  const change = useCallback((update: Project | ((p:Project) => Project), record=true,options?:ChangeOptions) => {
    const previous=current.current,next = typeof update === 'function' ? update(previous) : update;
    if (next === previous) return;
    const oldAssets=new Map(previous.media.map(asset=>[asset.path,asset]));let sourceChanged=false;
    for(const asset of options?.authoritativeSources||[]){
      const old=oldAssets.get(asset.path),authority=sources.current.get(asset.path),seen=authority?.seen||new Set<string|undefined>();
      seen.add(old?.sourceRevision);seen.add(asset.sourceRevision);
      sourceChanged ||= old?.sourceRevision!==asset.sourceRevision;
      sources.current.set(asset.path,{asset,seen});
    }
    for(const asset of next.media){
      const old=oldAssets.get(asset.path),authority=sources.current.get(asset.path);
      if(authority){
        if(asset.sourceRevision===authority.asset.sourceRevision){if(asset!==old)authority.asset=mergeAsset(authority.asset,asset);}
        else if(asset.sourceRevision&&!authority.seen.has(asset.sourceRevision)){authority.seen.add(asset.sourceRevision);authority.asset=asset;sourceChanged=true;}
        // A drag may still carry a pre-refresh project snapshot. It must not
        // make an already observed obsolete filesystem revision authoritative.
      }else if(old&&asset.sourceRevision&&asset.sourceRevision!==old.sourceRevision){
        sources.current.set(asset.path,{asset,seen:new Set([old.sourceRevision,asset.sourceRevision])});sourceChanged=true;
      }
    }
    const before=rebase(previous),after=rebase({...next,version:10});
    const reconciled=reconcileTransitions(previous,reconcileMotion(previous,after.project));
    let onlySourceRefresh=false;
    if(sourceChanged||options?.authoritativeSources?.length){
      const contents=JSON.stringify({...reconciled.project,updatedAt:''});
      onlySourceRefresh=JSON.stringify({...before.project,updatedAt:''})===contents;
      if(onlySourceRefresh&&JSON.stringify({...previous,updatedAt:''})===contents)return;
    }
    current.current=before.project;
    if(record&&!onlySourceRefresh){if(!options?.coalesce||options.coalesce!==coalesced.current)checkpoint();coalesced.current=options?.coalesce;}
    current.current = {...reconciled.project, updatedAt:new Date().toISOString()};
    const detached=new Set([...before.detached,...after.detached,...reconciled.detached]);
    if(detached.size)setTransitionNotice({count:detached.size});
    setState(current.current);
  }, [checkpoint,rebase]);
  const reset = useCallback((next:Project) => {
    const migrated={...next,version:10 as const};past.current=[]; future.current=[];coalesced.current=undefined;sources.current.clear();for(const asset of migrated.media)sources.current.set(asset.path,{asset,seen:new Set([asset.sourceRevision])});rebasedAssets.current=new WeakMap();current.current=migrated;setState(migrated);setRevision(r=>r+1);setTransitionNotice(null);
  }, []);
  const undo = useCallback(() => {
    const next=past.current.pop();if(!next)return;const restored=rebase(next);coalesced.current=undefined;
    future.current.push(current.current);current.current=restored.project;setState(current.current);setRevision(r=>r+1);
    if(restored.detached.length)setTransitionNotice({count:restored.detached.length});
  }, [rebase]);
  const redo = useCallback(() => {
    const next=future.current.pop();if(!next)return;const restored=rebase(next);coalesced.current=undefined;
    past.current.push(current.current);current.current=restored.project;setState(current.current);setRevision(r=>r+1);
    if(restored.detached.length)setTransitionNotice({count:restored.detached.length});
  }, [rebase]);
  return {project,current,change,reset,checkpoint,undo,redo,canUndo:!!past.current.length,canRedo:!!future.current.length,revision,transitionNotice,clearTransitionNotice};
}

export interface ChangeOptions {authoritativeSources?:readonly MediaAsset[];/** Consecutive recorded changes from this field while it keeps focus share one undo step. */coalesce?:EventTarget}
export type Change = (update:Project|((p:Project)=>Project),record?:boolean,options?:ChangeOptions)=>void;
export const formatTime = (seconds:number, fps=30) => {
  const safe=Math.max(0,Number.isFinite(seconds)?seconds:0), whole=Math.floor(safe);
  return `${Math.floor(whole/3600).toString().padStart(2,'0')}:${Math.floor(whole/60%60).toString().padStart(2,'0')}:${(whole%60).toString().padStart(2,'0')}:${Math.floor((safe-whole)*fps+0.0001).toString().padStart(2,'0')}`;
};
export const shortTime = (seconds:number) => `${Math.floor(seconds/60)}:${Math.floor(seconds%60).toString().padStart(2,'0')}`;
export const minClipDuration=(fps:number)=>Math.max(.01,1/fps);
export function cuesToClips(cues:SubtitleCue[],trackId:string,project:Project,offset=0,bounds?:{start:number;end:number}):Clip[] {
  const minimum=minClipDuration(project.fps),lower=bounds?.start??0,upper=bounds?.end??86400;
  if(![lower,upper,offset].every(Number.isFinite)||lower<0||upper>86400||upper-lower+1e-10<minimum)throw new Error('자막을 넣을 구간이 너무 짧거나 유효하지 않습니다.');
  return cues.flatMap((cue,index)=>{
    if(typeof cue.text!=='string'||cue.text.length>20000||cue.text.includes('\0'))throw new Error(`${index+1}번째 자막의 글자 수 또는 내용이 유효하지 않습니다 (최대 20,000자).`);
    if(![cue.start,cue.end].every(Number.isFinite)||cue.end<=cue.start)throw new Error(`${index+1}번째 자막의 시작·끝 시간이 유효하지 않습니다.`);
    if(cue.words!==undefined)assertCaptionWords(cue.text,cue.words,cue.start,cue.end);
    if(!cue.text.trim())return [];
    const rawStart=cue.start+offset,rawEnd=cue.end+offset;
    if(rawStart<0||rawEnd>86400)throw new Error(`${index+1}번째 자막 시간이 24시간 범위를 벗어납니다.`);
    let start=Math.max(lower,rawStart),end=Math.min(upper,rawEnd);
    if(end<=start)throw new Error(`${index+1}번째 자막이 선택한 클립 구간을 벗어납니다.`);
    const duration=Math.max(minimum,end-start);start=Math.min(start,upper-duration);
    const captionWords=trimCaptionWords(cue.words?.map(word=>({...word,start:word.start+offset,end:word.end+offset})),start,start+duration);
    return [{...newClip(trackId),id:uid(),name:cue.text.replace(/\n/g,' ').slice(0,36),text:cue.text,start,duration,y:project.height*.32,fontSize:clamp(Math.round(project.height*.052),4,1000),textStyle:'bold' as const,animation:'fade' as const,captionWords,captionStyle:defaultCaptionStyle(),captionAnimation:defaultCaptionAnimation()}];
  });
}
function retimeClip(clip:Clip,rawDuration:number,fps:number):Clip {
  const duration=Math.max(minClipDuration(fps),rawDuration),factor=duration/clip.duration;
  if(rawDuration+1e-10<minClipDuration(fps))throw new Error('이 속도에서는 클립이 최소 길이보다 짧아집니다. 속도를 낮추거나 클립을 늘리세요.');
  if(clip.start+duration>86400||[clip.fadeIn*factor,clip.fadeOut*factor,(clip.sourceClipOffset??0)*factor,(clip.sourceClipDuration??0)*factor].some(v=>v>86400))throw new Error('이 속도에서는 클립 또는 효과 구간이 24시간을 넘습니다.');
  return {...clip,duration,fadeIn:clip.fadeIn*factor,fadeOut:clip.fadeOut*factor,keyframes:clip.keyframes.map(k=>({...k,time:k.time*factor})),captionWords:clip.captionWords?.map(word=>({...word,start:word.start*factor,end:word.end*factor})),captionAnimation:clip.captionAnimation?{...clip.captionAnimation,entrySeconds:clip.captionAnimation.entrySeconds*factor,exitSeconds:clip.captionAnimation.exitSeconds*factor}:undefined,sourceClipOffset:clip.sourceClipOffset===undefined?undefined:clip.sourceClipOffset*factor,sourceClipDuration:clip.sourceClipDuration===undefined?undefined:clip.sourceClipDuration*factor};
}
export function changeClipSpeed(clip:Clip,speed:number,fps:number):Clip {
  if(!Number.isFinite(speed)||speed<MIN_SPEED||speed>MAX_SPEED)throw new Error('재생 속도는 10~50000%여야 합니다.');
  return {...retimeClip(clip,clipSourceSpan(clip)/speed,fps),speed,speedCurve:undefined};
}
export function changeClipSpeedCurve(clip:Clip,points:SpeedPoint[]|undefined,fps:number):Clip {
  if(!points)return changeClipSpeed(clip,clip.speed,fps);
  assertSpeedCurve(points);
  return {...retimeClip(clip,clipSourceSpan(clip)/speedCurveMean(points),fps),speedCurve:points.map(point=>({...point}))};
}
/** Clips for files dropped on a track: one after another from the drop point. A file the track
 * cannot hold (audio on a video track, anything on a text track) starts at the same point on the
 * first unlocked track that can, which is created when there is none. */
export function placeDroppedMedia(p:Project,media:readonly MediaAsset[],trackId:string,at:number):{project:Project;clips:Clip[]} {
  let tracks=[...p.tracks];const clips:Clip[]=[],cursor=new Map<string,number>(),target=tracks.find(t=>t.id===trackId);
  for(const asset of media){
    const type:Track['type']=asset.kind==='audio'?'audio':'video';
    let track=target&&target.type===type&&!target.locked?target:tracks.find(t=>t.type===type&&!t.locked);
    if(!track){
      if(tracks.length>=100)throw new Error('프로젝트당 최대 100개 트랙을 지원합니다.');
      track={id:uid(),type,name:type==='audio'?'오디오':'영상',muted:false,hidden:false,locked:false};tracks=[...tracks,track];
    }
    const start=cursor.get(track.id)??at,clip=newClip(track.id,asset,start);
    clip.duration=Math.min(clip.duration,86400-start);
    if(clip.duration<minClipDuration(p.fps))throw new Error('타임라인 길이는 최대 24시간입니다.');
    clips.push(clip);cursor.set(track.id,start+clip.duration);
  }
  if(p.clips.length+clips.length>10000)throw new Error('프로젝트당 최대 10,000개 클립을 지원합니다.');
  return {project:{...p,tracks,clips:[...p.clips,...clips]},clips};
}
/** Video and audio clips play at a rate; text and still images only last a duration. */
export const hasPlaybackRate=(clip:Clip,media:readonly MediaAsset[])=>clip.text===undefined&&media.some(m=>m.id===clip.mediaId&&m.kind!=='image');
/** The constant speed shared by the rate-bearing clips, 1 when there are none, or undefined when they differ or use curves. */
export function commonSpeed(clips:readonly Clip[],media:readonly MediaAsset[]):number|undefined {
  const rated=clips.filter(c=>hasPlaybackRate(c,media));
  if(!rated.length)return 1;
  return rated.every(c=>!c.speedCurve&&Math.abs(c.speed-rated[0].speed)<1e-9)?rated[0].speed:undefined;
}
const roundSpeed=(speed:number)=>Math.round(speed*1e9)/1e9;
/** Play the selection `factor` times faster as one block, the way a nested sequence would:
 * each clip keeps its place relative to the selection's start, rate-bearing clips change speed
 * (curves scale point by point), and text, stills, fades, keyframes and transitions shrink with them. */
export function scaleSelectionSpeed(p:Project,ids:readonly string[],factor:number,fps:number):Project {
  if(!Number.isFinite(factor)||factor<=0)throw new Error('속도 배율이 올바르지 않습니다.');
  const locked=new Set(p.tracks.filter(t=>t.locked).map(t=>t.id)),wanted=new Set(ids);
  const chosen=p.clips.filter(c=>wanted.has(c.id)&&!locked.has(c.trackId));
  if(!chosen.length||Math.abs(factor-1)<1e-12)return p;
  const origin=Math.min(...chosen.map(c=>c.start)),updated=new Map<string,Clip>();
  for(const c of chosen){
    let next:Clip;
    if(hasPlaybackRate(c,p.media)&&c.speedCurve){
      const speedCurve=c.speedCurve.map(point=>({...point,speed:roundSpeed(point.speed*factor)}));
      if(speedCurve.some(point=>point.speed<MIN_SPEED||point.speed>MAX_CURVE_SPEED))throw new Error(`'${c.name}'의 속도 커브가 10~1600% 범위를 벗어납니다. 커브를 해제하거나 배율을 줄이세요.`);
      next={...retimeClip(c,c.duration/factor,fps),speedCurve};
    }else if(hasPlaybackRate(c,p.media)){
      const speed=roundSpeed(c.speed*factor);
      if(speed<MIN_SPEED||speed>MAX_SPEED)throw new Error(`'${c.name}' 클립의 속도가 10~50000% 범위를 벗어납니다.`);
      next={...retimeClip(c,c.duration/factor,fps),speed};
    }else next=retimeClip(c,c.duration/factor,fps);
    next.start=origin+(c.start-origin)/factor;
    if(next.start+next.duration>86400)throw new Error('이 속도에서는 타임라인이 24시간을 넘습니다.');
    updated.set(c.id,next);
  }
  const transitions=p.transitions?.map(t=>updated.has(t.fromClipId)&&updated.has(t.toClipId)?{...t,durationFrames:Math.max(1,Math.round(t.durationFrames/factor))}:t);
  return {...p,clips:p.clips.map(c=>updated.get(c.id)||c),...(transitions?{transitions}:{})};
}
export const toCues = (project:Project):SubtitleCue[] => project.clips.filter(c=>c.text!==undefined).sort((a,b)=>a.start-b.start).map(c=>({start:c.start,end:c.start+c.duration,text:c.text!,...(c.captionWords?{words:c.captionWords.map(word=>({...word,start:c.start+word.start,end:c.start+word.end}))}:{})}));
export const clamp=(n:number,min:number,max:number)=>Math.min(max,Math.max(min,n));
export const inputTarget=(target:EventTarget|null)=>target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable="true"]');
export const fileUrl=(path?:string)=>path ? window.studio.mediaUrl(path) : '';
export function mergeAsset(base:MediaAsset,update?:Partial<MediaAsset>):MediaAsset {
  const changed=update?.sourceRevision!==undefined&&update.sourceRevision!==base.sourceRevision;
  const retained={...base};
  if(changed){delete retained.proxyPath;delete retained.thumbnail;delete retained.waveform;delete retained.videoStart;delete retained.videoEnd;delete retained.timing;delete retained.hasAlpha;}
  const result={...retained,...Object.fromEntries(Object.entries(update||{}).filter(([,value])=>value!==undefined)),id:base.id};if(!previewProxyPath(result))delete result.proxyPath;return result;
}
export function resizeProject(p:Project,width:number,height:number):Project {
  const sx=width/p.width,sy=height/p.height;
  return {...p,width,height,clips:p.clips.map(c=>({...c,x:clamp(c.x*sx,-16384,16384),y:clamp(c.y*sy,-16384,16384),fontSize:clamp(c.fontSize*sy,4,1000),captionStyle:resizeCaptionStyle(c.captionStyle,sy),...(c.motionBinding?{motionBinding:resizeMotionBinding(c.motionBinding,p,width,height)}:{}),keyframes:c.keyframes.map(k=>({...k,x:clamp(k.x*sx,-16384,16384),y:clamp(k.y*sy,-16384,16384)}))}))};
}
export function effectFilter(c:Clip):string {
  const preset={none:'',cinematic:'contrast(1.15) saturate(0.8)',warm:'sepia(0.18) saturate(1.15)',cool:'hue-rotate(12deg) saturate(0.9)',mono:'saturate(0)',vivid:'saturate(1.4) contrast(1.1)'}[c.preset];
  return `brightness(${1+c.brightness}) contrast(${c.contrast}) saturate(${c.saturation}) blur(${c.blur}px) ${preset}`;
}
