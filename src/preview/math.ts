import type {Clip,MediaAsset,Project,Track} from '../../shared/types';
import {clipEnvelope,interpolate} from '../../shared/project';
import {visualTrackEnabled,audioTrackEnabled} from '../../shared/effects';
import {clipSourceTime} from '../../shared/speed';
import {captionAnimationState} from '../../shared/captions';
import {compileTransitions,type ClipExposure,type TransitionPlan} from '../../shared/transitions';

export const clamp=(n:number,a=0,b=1)=>Math.max(a,Math.min(b,n));
export interface Crop {left:number;top:number;right:number;bottom:number}
export interface Chroma {enabled:boolean;color:string;similarity:number;smoothness:number}
export interface Mask {type:'none'|'rect'|'ellipse';x:number;y:number;width:number;height:number;feather:number;invert:boolean}
export type PreviewClip=Clip&{crop?:Crop;chromaKey?:Chroma;mask?:Mask};
export const EMPTY_CROP:Crop={left:0,top:0,right:0,bottom:0};
export const EMPTY_MASK:Mask={type:'none',x:.5,y:.5,width:1,height:1,feather:0,invert:false};
export function hexRgb(hex:string):[number,number,number]{return [parseInt(hex.slice(1,3),16)/255,parseInt(hex.slice(3,5),16)/255,parseInt(hex.slice(5,7),16)/255];}
export function fadeAt(clip:Clip,local:number){const e=clipEnvelope(clip,local);return Math.min(clip.fadeIn?clamp(e.time/clip.fadeIn):1,clip.fadeOut?clamp((e.duration-e.time)/clip.fadeOut):1);}
export function clipState(clip:Clip,time:number){const local=time-clip.start,state=interpolate(clip,local),animation=captionAnimationState(clip,local);return {...state,opacity:state.opacity*fadeAt(clip,local)*animation.opacity,scale:state.scale*animation.scale,y:state.y+animation.y};}
export function fittedSize(sourceWidth:number,sourceHeight:number,project:Pick<Project,'width'|'height'>,fit:Clip['fit'],crop:Crop=EMPTY_CROP){
  const sw=Math.max(1,sourceWidth*(1-crop.left-crop.right)),sh=Math.max(1,sourceHeight*(1-crop.top-crop.bottom));
  const ratio=(fit==='cover'?Math.max:Math.min)(project.width/sw,project.height/sh);
  return {width:sw*ratio,height:sh*ratio,uv:[crop.left,crop.top,1-crop.right,1-crop.bottom] as [number,number,number,number]};
}
export function sourceTime(clip:Clip,time:number,media:MediaAsset,exposure?:ClipExposure){const from=exposure?Math.min(exposure.visualFrom,exposure.audioFrom):0,to=exposure?Math.max(exposure.visualTo,exposure.audioTo):clip.duration;return clamp(clipSourceTime(clip,clamp(time-clip.start,from,to)),0,Math.max(0,media.duration-.000001));}
export function previewSize(width:number,height:number,maximumHeight=720){const scale=Math.min(1,maximumHeight/height,1920/width);return {width:Math.max(2,Math.round(width*scale/2)*2),height:Math.max(2,Math.round(height*scale/2)*2)};}
export const visualEnabled=visualTrackEnabled;
export const audioEnabled=audioTrackEnabled;
export interface PlannedMedia {clip:PreviewClip;media:MediaAsset;track:Track;exposure:ClipExposure;active:boolean;distance:number}
export function planMedia(project:Project,time:number,limit=32,ahead=1.2,plan:TransitionPlan=compileTransitions(project)):{media:PlannedMedia[];overflow:boolean}{
  const assets=new Map(project.media.map(m=>[m.id,m])),tracks=new Map(project.tracks.map(t=>[t.id,t]));
  const candidates:PlannedMedia[]=[];
  for(const clip of project.clips){if(clip.text!==undefined)continue;const media=assets.get(clip.mediaId||''),track=tracks.get(clip.trackId);if(!media||!track)continue;
    const visual=visualEnabled(project,track),audible=media.hasAudio&&audioEnabled(project,track);if(!visual&&!audible)continue;
    const exposure=plan.byClip.get(clip.id)!;
    const from=clip.start+Math.min(visual?exposure.visualFrom:Infinity,audible?exposure.audioFrom:Infinity),to=clip.start+Math.max(visual?exposure.visualTo:-Infinity,audible?exposure.audioTo:-Infinity);
    const active=time>=from&&time<to;
    if(!active&&(from<time||from>time+ahead))continue;
    candidates.push({clip,media,track,exposure,active,distance:active?0:from-time});
  }
  candidates.sort((a,b)=>Number(b.active)-Number(a.active)||a.distance-b.distance||project.tracks.indexOf(a.track)-project.tracks.indexOf(b.track));
  return {media:candidates.slice(0,limit),overflow:candidates.filter(c=>c.active).length>limit};
}
export function maskAlpha(mask:Mask,x:number,y:number,width:number,height:number):number{
  if(mask.type==='none')return 1;
  const dx=(x-mask.x)*width,dy=(y-mask.y)*height,hx=Math.max(.0001,mask.width*width/2),hy=Math.max(.0001,mask.height*height/2);
  const qx=Math.abs(dx)-hx,qy=Math.abs(dy)-hy;
  const distance=mask.type==='ellipse'?(Math.hypot(dx/hx,dy/hy)-1)*Math.min(hx,hy):Math.hypot(Math.max(qx,0),Math.max(qy,0))+Math.min(Math.max(qx,qy),0);
  const feather=mask.feather*Math.min(width,height),a=feather?clamp(.5-distance/feather):(distance<=0?1:0);
  return mask.invert?1-a:a;
}
