import type {Clip, Project, MediaAsset, Track, Keyframe} from './types';
import {keyframeProgress} from './effects';
import {clipSourceTime,trimSpeedCurve} from './speed';
import {trimCaptionWords} from './captions';
export const uid = () => globalThis.crypto.randomUUID();
/** Easing interval bounds; trimming must not round them past the validator's [0,1]. */
const unit=(n:number)=>Math.min(1,Math.max(0,n));
export function newProject():Project {return {version:10,id:uid(),name:'제목 없는 프로젝트',width:1920,height:1080,fps:30,background:'#08090e',media:[],tracks:[{id:'video-1',name:'영상 1',type:'video',muted:false,hidden:false,locked:false},{id:'audio-1',name:'오디오 1',type:'audio',muted:false,hidden:false,locked:false},{id:'text-1',name:'자막 · 텍스트',type:'text',muted:false,hidden:false,locked:false}],clips:[],updatedAt:new Date().toISOString()};}
export function newClip(trackId:string,media?:MediaAsset,start=0):Clip {return {id:uid(),trackId,mediaId:media?.id,name:media?.name || '텍스트',start,duration:media?.kind==='image'?5:media?.duration||3,in:0,speed:1,volume:1,fadeIn:0,fadeOut:0,opacity:1,scale:1,x:0,y:0,rotation:0,fit:'contain',flipH:false,flipV:false,brightness:0,contrast:1,saturation:1,blur:0,preset:'none',text:media?undefined:'텍스트',fontSize:64,fontFamily:'Malgun Gothic',color:'#ffffff',textBackground:'#171923',textStyle:'bold',align:'center',animation:'none',keyframes:[]};}
/** What the editor opens with: one picture track, like CapCut's main track. Other tracks appear as clips need them. */
export function startingProject():Project {const p=newProject();return {...p,tracks:p.tracks.filter(t=>t.type==='video')};}
export function projectDuration(p:Project) {return Math.max(0,...p.clips.map(c=>c.start+c.duration));}
export function interpolate(c:Clip,time:number):Keyframe {const base={time,x:c.x,y:c.y,scale:c.scale,opacity:c.opacity,rotation:c.rotation};if(!c.keyframes.length)return base;const a=[...c.keyframes].sort((a,b)=>a.time-b.time);if(time<=a[0].time)return {...a[0],time};if(time>=a[a.length-1].time)return {...a[a.length-1],time};const i=a.findIndex(k=>k.time>time),l=a[i-1],r=a[i],t=keyframeProgress(l,(time-l.time)/(r.time-l.time));return {time,x:l.x+(r.x-l.x)*t,y:l.y+(r.y-l.y)*t,scale:l.scale+(r.scale-l.scale)*t,opacity:l.opacity+(r.opacity-l.opacity)*t,rotation:l.rotation+(r.rotation-l.rotation)*t};}
/** Fade and text-animation time, independent of locally rebased motion keyframes. */
/** Values for replacing the keyframe at a time; keeps the easing of a keyframe already within the tolerance. */
export function keyframeBase(clip:Clip,time:number,tolerance:number):Keyframe{const existing=clip.keyframes.find(k=>Math.abs(k.time-time)<=tolerance);return {...existing,...interpolate(clip,time),time};}
export function clipEnvelope(clip:Clip,localTime=0){return {time:localTime+(clip.sourceClipOffset??0),duration:clip.sourceClipDuration??clip.duration};}
/** Rebases fades and caption animation onto the clip's own bounds while keeping what is visible now,
 * so editing one fade on a split piece does not add a fade or animation at its cut. */
export function localizeEnvelope(clip:Clip):Pick<Clip,'fadeIn'|'fadeOut'|'sourceClipOffset'|'sourceClipDuration'|'captionAnimation'>{
  const offset=clip.sourceClipOffset??0,tail=Math.max(0,(clip.sourceClipDuration??clip.duration)-offset-clip.duration),visible=(fade:number,hidden:number)=>Math.min(clip.duration,Math.max(0,fade-hidden));
  const animation=clip.captionAnimation&&{...clip.captionAnimation,...(offset>1e-6?{entry:'none' as const}:{}),...(tail>1e-6?{exit:'none' as const}:{})};
  return {fadeIn:visible(clip.fadeIn,offset),fadeOut:visible(clip.fadeOut,tail),sourceClipOffset:undefined,sourceClipDuration:undefined,captionAnimation:animation};
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
export function trackFor(p:Project,c:Clip):Track|undefined{return p.tracks.find(t=>t.id===c.trackId);}
