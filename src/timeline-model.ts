import type {Clip,Project} from '../shared/types';
import {trimClip,uid} from '../shared/project';
import {minClipDuration} from './editor';
export const frameTime=(time:number,fps:number)=>Math.round(time*fps)/fps;
/** A group nudge moves by whole frames without changing any clip's fractional-frame phase. */
export function boundedNudgeDelta(clips:readonly {start:number;duration:number}[],frames:number,fps:number):number {
  if(!clips.length)return 0;
  let lower=-Infinity,upper=Infinity;
  for(const clip of clips){lower=Math.max(lower,-clip.start);upper=Math.min(upper,86400-(clip.start+clip.duration));}
  const firstFrame=Math.ceil(lower*fps),lastFrame=Math.floor(upper*fps);
  if(firstFrame>lastFrame)return 0;
  return Math.max(firstFrame,Math.min(lastFrame,Math.trunc(frames)))/fps||0;
}
/** Nearest absolute frame that leaves the entire clip inside the project. */
export function boundedFrameStart(time:number,duration:number,fps:number):number {
  return Math.max(0,Math.min(Math.round(time*fps),Math.floor((86400-duration)*fps)))/fps;
}
export function moveDelta(clips:Clip[],selected:string[],delta:number,points:number[],tolerance:number,fps:number,snap=true):{delta:number;guide:number|null} {
  const ids=new Set(selected),chosen=clips.filter(c=>ids.has(c.id));if(!chosen.length)return {delta:0,guide:null};
  let result=frameTime(delta,fps),guide:number|null=null,best=tolerance;
  if(snap){const sorted=[...points].sort((a,b)=>a-b);for(const clip of chosen)for(const edge of [clip.start,clip.start+clip.duration]){const target=edge+result;let low=0,high=sorted.length;while(low<high){const mid=(low+high)>>>1;if(sorted[mid]<target)low=mid+1;else high=mid;}for(const index of [low-1,low]){if(index<0||index>=sorted.length)continue;const point=sorted[index],distance=Math.abs(target-point);if(distance<best){best=distance;delta=point-edge;guide=point;}}}}
  if(guide!==null)result=frameTime(delta,fps);
  result=Math.max(-Math.min(...chosen.map(c=>c.start)),Math.min(result,86400-Math.max(...chosen.map(c=>c.start+c.duration))));
  return {delta:result,guide};
}
/** Insert/overwrite a source interval without changing other tracks or losing source trims. */
export function insertClip(project:Project,incoming:Clip,mode:'insert'|'overwrite'|'append'):Clip[] {
  const from=incoming.start,to=from+incoming.duration,minimum=minClipDuration(project.fps);
  const clips=project.clips.flatMap(c=>{
    if(c.trackId!==incoming.trackId||mode==='append')return [c];
    const end=c.start+c.duration;
    if(mode==='insert'){
      if(c.start>=from)return [{...c,start:c.start+incoming.duration}];
      if(end>from){const offset=from-c.start;return [trimClip(c,0,offset),{...trimClip(c,offset,c.duration),id:uid(),start:from+incoming.duration}].filter(piece=>piece.duration>=minimum);}
      return [c];
    }
    if(end<=from||c.start>=to)return [c];
    const pieces:Clip[]=[];if(c.start<from)pieces.push(trimClip(c,0,from-c.start));
    if(end>to)pieces.push({...trimClip(c,to-c.start,c.duration),id:pieces.length?uid():c.id});
    return pieces.filter(piece=>piece.duration>=minimum);
  });
  return [...clips,incoming];
}
export function tickSpacing(zoom:number):number {const ideal=80/zoom,power=10**Math.floor(Math.log10(ideal));return [1,2,5,10].map(n=>n*power).find(n=>n>=ideal)||power*10;}
/** At overview scale collapse sub-pixel clips into four-pixel bins; full project data stays selectable. */
export function visibleTimelineClips(clips:Clip[],left:number,right:number,zoom:number,selected:Set<string>):Clip[] {
  const visible:Clip[]=[],tiny=new Map<number,Clip>();
  for(const c of clips){if((c.start+c.duration)*zoom<left||c.start*zoom>right)continue;if(c.duration*zoom>=4)visible.push(c);else{const bin=Math.floor(c.start*zoom/4),old=tiny.get(bin);if(!old||selected.has(c.id)||!selected.has(old.id))tiny.set(bin,c);}}
  const limit=Math.max(500,Math.ceil((right-left)*2));return [...visible,...tiny.values()].sort((a,b)=>a.start-b.start).slice(-limit);
}
