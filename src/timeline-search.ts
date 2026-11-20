import type {Clip,Track} from '../shared/types';
import {formatProgramTimecode} from './preview/program-timecode';

export interface TimelineSearchMatch {clip:Clip;track:Track;trackIndex:number}
const normalized=(text:string)=>text.normalize('NFC').toLowerCase();
/** Search the project, not the currently mounted/visible timeline clips. */
export function findTimelineClips(clips:readonly Clip[],tracks:readonly Track[],query:string,fps=30):TimelineSearchMatch[]{
  const needle=normalized(query.trim());if(!needle)return [];
  const trackNumber=/^트랙 ([1-9]\d*)$/.exec(needle);
  const requestedTrack=trackNumber?Number(trackNumber[1]):undefined;
  const timeQuery=/^\d{2}:\d{2}:\d{2}:\d{2,3}$/.test(needle),secondsQuery=/^\d+(?:\.\d+)?초$/.test(needle);
  const byTrack=new Map(tracks.map((track,trackIndex)=>[track.id,{track,trackIndex,nameMatches:normalized(track.name).includes(needle)}]));
  const matches:TimelineSearchMatch[]=[];
  for(const clip of clips){
    const row=byTrack.get(clip.trackId);if(!row)continue;
    let matched=requestedTrack!==undefined?row.trackIndex+1===requestedTrack:row.nameMatches||normalized(clip.name).includes(needle)||(clip.text!==undefined&&normalized(clip.text).includes(needle));
    if(requestedTrack===undefined&&!matched&&timeQuery)matched=formatProgramTimecode(clip.start,fps)===needle;
    if(requestedTrack===undefined&&!matched&&secondsQuery)matched=`${Number(clip.start.toFixed(3))}초`===needle;
    if(matched)matches.push({clip,track:row.track,trackIndex:row.trackIndex});
  }
  return matches.sort((a,b)=>a.clip.start-b.clip.start||a.trackIndex-b.trackIndex);
}

/** Scroll coordinates include the sticky ruler and track label. */
export function revealTimelineClip(start:number,zoom:number,row:{top:number;height:number},viewport:{width:number;height:number},labelWidth:number,rulerHeight:number):{left:number;top:number}{
  return {left:Math.max(0,start*zoom-Math.max(0,viewport.width-labelWidth)*.35),top:Math.max(0,row.top-rulerHeight-Math.max(0,viewport.height-rulerHeight-row.height)/2)};
}

/** Preserve the requested clip even when overview binning caps a crowded lane. */
export function includeTimelineSearchTarget(visible:Clip[],clips:readonly Clip[],id:string|null,left:number,right:number,zoom:number):Clip[]{
  if(!id||visible.some(clip=>clip.id===id))return visible;
  const clip=clips.find(value=>value.id===id);
  return clip&&(clip.start+clip.duration)*zoom>=left&&clip.start*zoom<=right?[...visible,clip]:visible;
}

export function selectTimelineSearchResult(clips:readonly Clip[],selected:readonly string[],id:string,additive:boolean):string[]{
  const valid=new Set(clips.map(clip=>clip.id));if(!valid.has(id))return [...new Set(selected.filter(value=>valid.has(value)))];
  return additive?[...new Set([...selected.filter(value=>valid.has(value)),id])]:[id];
}
