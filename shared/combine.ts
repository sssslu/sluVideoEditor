import type {Clip,MediaAsset,Project,Track,Transition} from './types';
import type {MotionBinding} from './tracking';
import {newClip,uid} from './project';
import {audioTrackEnabled,visualTrackEnabled} from './effects';
import {clipMediaIds} from './processing';

/** "합치기": selected clips are rendered into one transparent intermediate and replaced by a
 * single clip of it. The clip keeps the originals so "합치기 풀기" can put them back. */
export const MAX_COMBINED_CLIPS=2000;
export interface CombinePlan {ids:string[];start:number;end:number;visual:boolean;audio:boolean}

const overlaps=(c:Clip,start:number,end:number)=>c.start<end-1e-9&&c.start+c.duration>start+1e-9;

export function planCombination(p:Project,ids:readonly string[]):CombinePlan {
  const wanted=new Set(ids),clips=p.clips.filter(c=>wanted.has(c.id));
  if(!clips.length)throw new Error('합칠 클립을 선택하세요.');
  if(clips.length>MAX_COMBINED_CLIPS)throw new Error(`한 번에 최대 ${MAX_COMBINED_CLIPS.toLocaleString()}개 클립까지 합칠 수 있습니다.`);
  const tracks=new Map(p.tracks.map(t=>[t.id,t])),media=new Map(p.media.map(m=>[m.id,m]));
  if(clips.some(c=>tracks.get(c.trackId)?.locked))throw new Error('잠긴 트랙의 클립은 합칠 수 없습니다.');
  const visual=clips.some(c=>visualTrackEnabled(p,tracks.get(c.trackId))&&(c.text!==undefined||(!!c.mediaId&&media.get(c.mediaId)?.kind!=='audio')));
  const audio=clips.some(c=>{const m=media.get(c.mediaId||'');return c.text===undefined&&!!m&&(m.kind==='audio'||m.hasAudio)&&c.volume>0&&audioTrackEnabled(p,tracks.get(c.trackId));});
  if(!visual&&!audio)throw new Error('선택한 클립에 보이거나 들리는 내용이 없습니다. 숨김·음소거된 트랙을 확인하세요.');
  const start=Math.min(...clips.map(c=>c.start)),end=Math.max(...clips.map(c=>c.start+c.duration));
  return {ids:clips.map(c=>c.id),start,end,visual,audio};
}

const mapLinks=(binding:MotionBinding,map:(id:string|undefined)=>string|undefined):MotionBinding=>({...binding,sourceClipId:map(binding.sourceClipId),...(binding.segments?{segments:binding.segments.map(link=>({...link,sourceClipId:map(link.sourceClipId)}))}:{})});

/** The selected clips alone, starting at zero, as the render input. Track visibility, mute and
 * solo are baked in exactly as the user currently sees and hears them. */
export function combinationProject(p:Project,ids:readonly string[]):Project {
  const plan=planCombination(p,ids),wanted=new Set(plan.ids);
  const clips=p.clips.filter(c=>wanted.has(c.id)).map(c=>({...c,start:c.start-plan.start,
    // A tracked overlay whose source clip stays outside follows its stored source snapshot.
    ...(c.motionBinding?{motionBinding:mapLinks(c.motionBinding,id=>id&&wanted.has(id)?id:undefined)}:{})}));
  const used=new Set(clips.map(c=>c.trackId)),media=new Set(clips.flatMap(clipMediaIds)),analyses=new Set(clips.flatMap(c=>c.motionBinding?[c.motionBinding.analysisId]:[]));
  const tracks=p.tracks.filter(t=>used.has(t.id)).map(t=>({...t,locked:false,solo:undefined,hidden:t.type==='audio'?t.hidden:!visualTrackEnabled(p,t),muted:t.type==='text'?t.muted:!audioTrackEnabled(p,t)}));
  return {...p,media:p.media.filter(m=>media.has(m.id)),tracks,clips,transitions:(p.transitions||[]).filter(t=>wanted.has(t.fromClipId)&&wanted.has(t.toClipId)),markers:undefined,motionPaths:p.motionPaths?.filter(a=>analyses.has(a.id)),fileReferences:undefined};
}

/** Replace the combined clips by one clip of the rendered media, if they are exactly as rendered. */
export function applyCombination(p:Project,plan:CombinePlan,rendered:readonly Clip[],media:MediaAsset):{project:Project;clip:Clip} {
  const wanted=new Set(plan.ids),live=p.clips.filter(c=>wanted.has(c.id));
  if(live.length!==rendered.length||rendered.some(c=>JSON.stringify(c)!==JSON.stringify(live.find(l=>l.id===c.id))))throw new Error('합치는 동안 선택한 클립이 바뀌었습니다.');
  if(live.some(c=>p.tracks.find(t=>t.id===c.trackId)?.locked))throw new Error('잠긴 트랙의 클립은 합칠 수 없습니다.');
  const type:Track['type']=media.kind==='audio'?'audio':'video',rest=p.clips.filter(c=>!wanted.has(c.id));
  const indices=new Set(live.map(c=>p.tracks.findIndex(t=>t.id===c.trackId))),top=Math.max(...indices);
  // Use the highest selected track that is free over the span, unless an unselected picture
  // would end up sandwiched in between (moving the result below it would change the layering).
  let track:Track|undefined;
  for(let i=top;i>=0;i--){
    const t=p.tracks[i],busy=rest.some(c=>c.trackId===t.id&&overlaps(c,plan.start,plan.end));
    if(t.type===type&&!t.locked&&!busy&&indices.has(i)){track=t;break;}
    if(busy&&type==='video'&&t.type!=='audio')break;
  }
  let tracks=p.tracks;
  if(!track){
    if(p.tracks.length>=100)throw new Error('트랙이 100개라 합친 클립을 놓을 트랙을 만들 수 없습니다.');
    track={id:uid(),type,name:type==='audio'?'합친 오디오':'합친 클립',muted:false,hidden:false,locked:false};
    tracks=[...p.tracks.slice(0,top+1),track,...p.tracks.slice(top+1)];
  }
  const span=plan.end-plan.start,duration=media.duration>0?Math.min(span,media.duration):span;
  const clip:Clip={...newClip(track.id,media,plan.start),name:media.name,duration,compound:{derivedMediaId:media.id,start:plan.start,clips:structuredClone(live),tracks:p.tracks.filter(t=>live.some(c=>c.trackId===t.id)).map(t=>({...t})),transitions:(p.transitions||[]).filter(t=>wanted.has(t.fromClipId)&&wanted.has(t.toClipId)).map(t=>({...t}))}};
  return {clip,project:{...p,tracks,media:p.media.some(m=>m.id===media.id)?p.media:[...p.media,media],clips:[...rest,clip],transitions:(p.transitions||[]).filter(t=>!wanted.has(t.fromClipId)&&!wanted.has(t.toClipId))}};
}

/** Put a combined clip's originals back where the combined clip now sits. Speed, trims and
 * effects applied to the combined clip itself are not carried over. */
export function uncombineClip(p:Project,clipId:string):{project:Project;ids:string[]} {
  const clip=p.clips.find(c=>c.id===clipId),compound=clip?.compound;
  if(!clip||!compound)throw new Error('합친 클립이 아닙니다.');
  if(p.tracks.find(t=>t.id===clip.trackId)?.locked)throw new Error('잠긴 트랙의 클립은 풀 수 없습니다.');
  const known=new Set(p.media.map(m=>m.id));
  if(compound.clips.some(c=>clipMediaIds(c).some(id=>!known.has(id))))throw new Error('원래 클립의 미디어가 보관함에 없어 풀 수 없습니다.');
  const shift=clip.start-compound.start-(clip.speedCurve?0:clip.in/clip.speed);
  const remaining=p.clips.filter(c=>c.id!==clip.id),taken=new Set(remaining.map(c=>c.id));
  const ids=new Map(compound.clips.map(c=>[c.id,taken.has(c.id)?uid():c.id]));
  const restored=compound.clips.map(c=>{const copy:Clip={...structuredClone(c),id:ids.get(c.id)!,start:c.start+shift};if(copy.motionBinding)copy.motionBinding=mapLinks(copy.motionBinding,id=>id&&ids.has(id)?ids.get(id):id);return copy;});
  if(restored.some(c=>c.start<-1e-9||c.start+c.duration>86400))throw new Error('원래 클립을 놓을 타임라인 공간이 없습니다. 합친 클립을 옮긴 뒤 다시 시도하세요.');
  for(const c of restored)c.start=Math.max(0,c.start);
  let tracks=[...p.tracks],insert=tracks.findIndex(t=>t.id===clip.trackId)+1;
  for(const original of compound.tracks){
    const existing=tracks.find(t=>t.id===original.id);
    if(existing?.locked)throw new Error(`'${existing.name}' 트랙이 잠겨 있어 풀 수 없습니다.`);
    if(!existing){if(tracks.length>=100)throw new Error('트랙이 100개라 원래 트랙을 되살릴 수 없습니다.');tracks=[...tracks.slice(0,insert),{...original,locked:false,solo:undefined},...tracks.slice(insert)];insert++;}
  }
  if(remaining.length+restored.length>10000)throw new Error('클립이 10,000개를 넘어 풀 수 없습니다.');
  const transitions:Transition[]=(compound.transitions||[]).map(t=>({...t,id:uid(),fromClipId:ids.get(t.fromClipId)!,toClipId:ids.get(t.toClipId)!})).filter(t=>t.fromClipId&&t.toClipId);
  return {ids:restored.map(c=>c.id),project:{...p,tracks,clips:[...remaining,...restored],transitions:[...(p.transitions||[]).filter(t=>t.fromClipId!==clip.id&&t.toClipId!==clip.id),...transitions]}};
}
