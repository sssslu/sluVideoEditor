import type {Clip, Project, MediaAsset, Keyframe} from './types';
import {keyframeProgress} from './effects';
import {clipSourceTime,trimSpeedCurve} from './speed';
import {trimCaptionWords} from './captions';
export const uid = () => globalThis.crypto.randomUUID();
/** Easing interval bounds; trimming must not round them past the validator's [0,1]. */
const unit=(n:number)=>Math.min(1,Math.max(0,n));
/** The name a project has until it is saved to a file, whose name it then takes. */
export const DEFAULT_PROJECT_NAME='제목 없는 프로젝트';
export function newProject():Project {return {version:10,id:uid(),name:DEFAULT_PROJECT_NAME,width:1920,height:1080,fps:30,background:'#08090e',media:[],tracks:[{id:'video-1',name:'영상 1',type:'video',muted:false,hidden:false,locked:false},{id:'audio-1',name:'오디오 1',type:'audio',muted:false,hidden:false,locked:false},{id:'text-1',name:'자막 · 텍스트',type:'text',muted:false,hidden:false,locked:false}],clips:[],updatedAt:new Date().toISOString()};}
export function newClip(trackId:string,media?:MediaAsset,start=0):Clip {return {id:uid(),trackId,mediaId:media?.id,name:media?.name || '텍스트',start,duration:media?.kind==='image'?5:media?.duration||3,in:0,speed:1,volume:1,fadeIn:0,fadeOut:0,opacity:1,scale:1,x:0,y:0,rotation:0,fit:'contain',flipH:false,flipV:false,brightness:0,contrast:1,saturation:1,blur:0,preset:'none',text:media?undefined:'텍스트',fontSize:64,fontFamily:'Malgun Gothic',color:'#ffffff',textBackground:'#171923',textStyle:'bold',align:'center',keyframes:[]};}
/** What the editor opens with: one picture track, like CapCut's main track. Other tracks appear as clips need them. */
export function startingProject():Project {const p=newProject();return {...p,tracks:p.tracks.filter(t=>t.type==='video')};}
export function projectDuration(p:Project) {return Math.max(0,...p.clips.map(c=>c.start+c.duration));}
export function interpolate(c:Clip,time:number):Keyframe {const base={time,x:c.x,y:c.y,scale:c.scale,opacity:c.opacity,rotation:c.rotation};if(!c.keyframes.length)return base;const a=[...c.keyframes].sort((a,b)=>a.time-b.time);if(time<=a[0].time)return {...a[0],time};if(time>=a[a.length-1].time)return {...a[a.length-1],time};const i=a.findIndex(k=>k.time>time),l=a[i-1],r=a[i],t=keyframeProgress(l,(time-l.time)/(r.time-l.time));return {time,x:l.x+(r.x-l.x)*t,y:l.y+(r.y-l.y)*t,scale:l.scale+(r.scale-l.scale)*t,opacity:l.opacity+(r.opacity-l.opacity)*t,rotation:l.rotation+(r.rotation-l.rotation)*t};}
/** Values for replacing the keyframe at a time; keeps the easing of a keyframe already within the tolerance. */
export function keyframeBase(clip:Clip,time:number,tolerance:number):Keyframe{const existing=clip.keyframes.find(k=>Math.abs(k.time-time)<=tolerance);return {...existing,...interpolate(clip,time),time};}
export type TransformValues=Partial<Pick<Keyframe,'x'|'y'|'scale'|'opacity'|'rotation'>>;
const TRANSFORM_RANGE={x:[-16384,16384],y:[-16384,16384],scale:[.01,8],opacity:[0,1],rotation:[-3600,3600]} as const;
/** Gives a clip the transform `values` at `localTime` without adding keyframes. A clip with keyframes
 * moves its whole animation (offset; scale by ratio) so its motion keeps its shape. */
export function shiftTransform(clip:Clip,values:TransformValues,localTime:number):Partial<Clip>{
  const now=interpolate(clip,localTime),entries=Object.entries(values).filter(([,v])=>v!==undefined) as [keyof TransformValues,number][];
  const bound=(key:keyof TransformValues,value:number)=>Math.min(TRANSFORM_RANGE[key][1],Math.max(TRANSFORM_RANGE[key][0],value));
  const move=(key:keyof TransformValues,value:number,target:number)=>bound(key,key==='scale'?value*target/Math.max(.01,now.scale):value+target-now[key]);
  const out:Partial<Clip>={};
  for(const [key,target] of entries)out[key]=clip.keyframes.length?move(key,clip[key],target):bound(key,target);
  if(clip.keyframes.length)out.keyframes=clip.keyframes.map(k=>{const next={...k};for(const [key,target] of entries)next[key]=move(key,k[key],target);return next;});
  return out;
}
/** What a clip is when several are edited at once: text, picture (video or image) or audio. */
export function clipKind(project:Project,clip:Clip):'text'|'picture'|'audio'{return clip.text!==undefined?'text':project.media.find(m=>m.id===clip.mediaId)?.kind==='audio'||project.tracks.find(t=>t.id===clip.trackId)?.type==='audio'?'audio':'picture';}
/** The selected clips an edit on `clip` applies to as well: the same kind, on unlocked tracks. */
export function editPeers(project:Project,selected:readonly string[],clip:Clip):Clip[]{
  const kind=clipKind(project,clip),ids=new Set(selected),locked=new Set(project.tracks.filter(t=>t.locked).map(t=>t.id));
  return project.clips.filter(c=>ids.has(c.id)&&!locked.has(c.trackId)&&clipKind(project,c)===kind);
}
/** A preview drag on several selected clips: clip `id` gets `values` at `time`, and every other clip
 * in `ids` moves by the same amount (scale: by the same ratio), so their layout is kept. All are
 * measured from `base`, the project when the drag began, so the calls of one drag don't add up. */
export function dragTogether(base:Project,ids:readonly string[],id:string,values:TransformValues,time:number):Map<string,Partial<Clip>>{
  const lead=base.clips.find(c=>c.id===id),out=new Map<string,Partial<Clip>>(),wanted=new Set(ids);if(!lead)return out;
  const local=(c:Clip)=>Math.min(c.duration,Math.max(0,time-c.start)),from=interpolate(lead,local(lead)),entries=Object.entries(values).filter(([,v])=>v!==undefined) as [keyof TransformValues,number][];
  for(const c of base.clips){
    if(!wanted.has(c.id))continue;const now=interpolate(c,local(c)),target:TransformValues={};
    for(const [key,value] of entries)target[key]=c===lead?value:key==='scale'?now.scale*value/Math.max(.01,from.scale):now[key]+value-from[key];
    out.set(c.id,shiftTransform(c,target,local(c)));
  }
  return out;
}
/** Fade time on the clip as it was before splits and trims, independent of locally rebased keyframes. */
export function clipEnvelope(clip:Clip,localTime=0){return {time:localTime+(clip.sourceClipOffset??0),duration:clip.sourceClipDuration??clip.duration};}
/** Rebases fades onto the clip's own bounds while keeping what is visible now, so editing one fade
 * on a split piece does not add a fade at its cut. */
export function localizeEnvelope(clip:Clip):Pick<Clip,'fadeIn'|'fadeOut'|'sourceClipOffset'|'sourceClipDuration'>{
  const offset=clip.sourceClipOffset??0,tail=Math.max(0,(clip.sourceClipDuration??clip.duration)-offset-clip.duration),visible=(fade:number,hidden:number)=>Math.min(clip.duration,Math.max(0,fade-hidden));
  return {fadeIn:visible(clip.fadeIn,offset),fadeOut:visible(clip.fadeOut,tail),sourceClipOffset:undefined,sourceClipDuration:undefined};
}
/** Crop the existing local interval [from,to], preserving source/motion/effect phase.
 * Extending outside the original envelope extends its boundaries as well. */
export function trimClip(clip:Clip,from:number,to:number):Clip {
  const duration=to-from,offset=(clip.sourceClipOffset??0)+from;
  const sourceClipOffset=Math.max(0,offset);
  const sourceClipDuration=Math.max((clip.sourceClipDuration??clip.duration)-Math.min(0,offset),sourceClipOffset+duration);
  const source=[...clip.keyframes].sort((a,b)=>a.time-b.time);
  const points=[from,...source.filter(k=>k.time>from&&k.time<to).map(k=>k.time),to];
  const keyframes=source.length?points.map((point,index)=>{
    const value={...interpolate(clip,point),time:point-from};
    delete value.easing;delete value.easingStart;delete value.easingEnd;
    const next=points[index+1];if(next===undefined)return value;
    const interval=source.findIndex((k,i)=>i<source.length-1&&point>=k.time&&point<source[i+1].time);
    if(interval<0)return value;
    const left=source[interval],right=source[interval+1],span=right.time-left.time;
    const a=left.easingStart??0,b=left.easingEnd??1;
    return {...value,easing:left.easing,easingStart:unit(a+(b-a)*((point-left.time)/span)),easingEnd:unit(a+(b-a)*((Math.min(next,right.time)-left.time)/span))};
  }):[];
  return {...clip,start:clip.start+from,in:Math.max(0,clipSourceTime(clip,from)),duration,keyframes,sourceClipOffset,sourceClipDuration,captionWords:trimCaptionWords(clip.captionWords,from,to),...(clip.speedCurve?{speedCurve:trimSpeedCurve(clip.speedCurve,from/clip.duration,to/clip.duration)}:{})};
}
export function splitClip(clip:Clip,time:number):[Clip,Clip]|null {const local=time-clip.start;if(local<0.02||local>clip.duration-0.02)return null;return [trimClip(clip,0,local),{...trimClip(clip,local,clip.duration),id:uid()}];}
