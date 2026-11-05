import type { Clip, Easing, Keyframe, Project, Track } from './types';

export function ease(t:number,mode:Easing='linear'):number {
  t=Math.max(0,Math.min(1,t));
  if(mode==='hold')return t>=1?1:0;
  if(mode==='ease-in')return t*t;
  if(mode==='ease-out')return 1-(1-t)*(1-t);
  if(mode==='ease-in-out')return t<.5?2*t*t:1-2*(1-t)*(1-t);
  return t;
}
/** The interval on the original curve is retained after a split/trim. */
export function keyframeProgress(key:Keyframe,t:number):number {
  const start=key.easingStart??0,end=key.easingEnd??1;
  const a=ease(start,key.easing),b=ease(end,key.easing);
  if(Math.abs(b-a)<1e-12)return 0;
  return (ease(start+(end-start)*Math.max(0,Math.min(1,t)),key.easing)-a)/(b-a);
}
export function visualTrackEnabled(project:Project,track:Track|undefined):boolean {
  return !!track&&track.type!=='audio'&&!track.hidden&&(!project.tracks.some(t=>t.type!=='audio'&&t.solo)||!!track.solo);
}
export function audioTrackEnabled(project:Project,track:Track|undefined):boolean {
  return !!track&&track.type!=='text'&&!track.muted&&(!project.tracks.some(t=>t.type!=='text'&&t.solo)||!!track.solo);
}
export function clipCrop(clip:Clip){return clip.crop??{left:0,top:0,right:0,bottom:0};}
