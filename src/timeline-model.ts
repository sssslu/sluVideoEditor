import type {Clip,Project,Track} from '../shared/types';
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
const occupied=(clips:readonly Clip[],trackId:string,start:number,end:number,except:ReadonlySet<string>)=>clips.some(c=>c.trackId===trackId&&!except.has(c.id)&&c.start<end-1e-6&&c.start+c.duration>start+1e-6);
const kindName=(type:Track['type'])=>type==='audio'?'오디오':type==='text'?'텍스트':'영상';
/** A new empty track named after its kind, e.g. "영상 2". */
export function createTrack(tracks:readonly Track[],type:Track['type']):Track {
  const names=new Set(tracks.map(t=>t.name));let n=tracks.filter(t=>t.type===type).length+1;
  while(names.has(`${kindName(type)} ${n}`))n++;
  return {id:uid(),type,name:`${kindName(type)} ${n}`,muted:false,hidden:false,locked:false};
}
/** Like CapCut, a track holds one clip per spot. Clips in `ids` that overlap another clip on
 * their track move together to another track of the same kind (for audio, further down):
 * - 'stack' (new clips): the next free track up, else a new one at the top of that run of
 *   tracks, so repeated drops on one spot stack with the newest on top;
 * - 'adjacent' (a dragged clip): the track right above if it is free, else a new track right
 *   above the one it was dropped on.
 * New tracks never go above a track of another kind, so text above pictures stays above. */
export function settleOverlaps(p:Project,ids:Iterable<string>,mode:'stack'|'adjacent'='stack'):Project {
  const wanted=new Set(ids);let tracks=[...p.tracks],clips=p.clips;
  const groups=new Map<string,Clip[]>();for(const c of clips)if(wanted.has(c.id))groups.set(c.trackId,[...(groups.get(c.trackId)||[]),c]);
  for(const [trackId,group] of groups){
    const members=new Set(group.map(c=>c.id)),fits=(id:string)=>!group.some(c=>occupied(clips,id,c.start,c.start+c.duration,members));
    if(fits(trackId))continue;
    const from=tracks.findIndex(t=>t.id===trackId),type=tracks[from].type;let i=from+1,target:string|undefined;
    while(i<tracks.length&&tracks[i].type===type){if(!tracks[i].locked&&fits(tracks[i].id)){target=tracks[i].id;break;}if(mode==='adjacent')break;i++;}
    if(!target){
      if(tracks.length>=100)throw new Error('트랙이 100개라 겹친 클립을 새 트랙에 놓을 수 없습니다.');
      const track=createTrack(tracks,type);tracks=[...tracks.slice(0,i),track,...tracks.slice(i)];target=track.id;
    }
    clips=clips.map(c=>members.has(c.id)?{...c,trackId:target!}:c);
  }
  return clips===p.clips?p:{...p,tracks,clips};
}
/** CapCut drops a track once its last clip leaves it. Tracks that were already empty stay
 * (a track added from the menu, say), and one picture track always remains. */
export function pruneEmptiedTracks(before:Project,after:Project):Project {
  const had=new Set(before.clips.map(c=>c.trackId)),has=new Set(after.clips.map(c=>c.trackId));
  const emptied=(t:Track)=>had.has(t.id)&&!has.has(t.id)&&!t.locked;
  let tracks=after.tracks.filter(t=>!emptied(t));
  if(tracks.length===after.tracks.length)return after;
  if(!tracks.some(t=>t.type==='video')){const keep=after.tracks.find(t=>t.type==='video');if(keep)tracks=after.tracks.filter(t=>t===keep||!emptied(t));}
  return {...after,tracks};
}
/** End of a timeline drag: clips dropped above or below every track get a new track there,
 * overlaps move up, and tracks the drag emptied go away. */
export function finishClipMove(before:Project,after:Project,ids:readonly string[],zone:'top'|'bottom'|null):Project {
  let p=after;const moved=p.clips.filter(c=>ids.includes(c.id));
  if(zone&&moved.length){
    const type=p.tracks.find(t=>t.id===moved[0].trackId)?.type||'video',track=createTrack(p.tracks,type),firstAudio=p.tracks.findIndex(t=>t.type==='audio');
    if(p.tracks.length>=100)throw new Error('프로젝트당 최대 100개 트랙을 지원합니다.');
    // Pictures and text: the top of the timeline is the top layer (end of the list). Audio is listed in order.
    const tracks=type==='audio'?(zone==='top'&&firstAudio>=0?[...p.tracks.slice(0,firstAudio),track,...p.tracks.slice(firstAudio)]:[...p.tracks,track]):zone==='top'?[...p.tracks,track]:[track,...p.tracks];
    const same=new Set(moved.filter(c=>p.tracks.find(t=>t.id===c.trackId)?.type===type).map(c=>c.id));
    p={...p,tracks,clips:p.clips.map(c=>same.has(c.id)?{...c,trackId:track.id}:c)};
  }
  return pruneEmptiedTracks(before,settleOverlaps(p,ids,'adjacent'));
}
/** The empty span under `time` on a track, from what ends before it to the next clip. */
export function gapAt(clips:readonly Clip[],trackId:string,time:number):{start:number;end:number}|null {
  const own=clips.filter(c=>c.trackId===trackId);
  if(own.some(c=>c.start<=time&&c.start+c.duration>time))return null;
  const next=Math.min(...own.filter(c=>c.start>=time).map(c=>c.start));
  if(!Number.isFinite(next))return null;
  const start=Math.max(0,...own.filter(c=>c.start+c.duration<=time).map(c=>c.start+c.duration));
  return next-start>1e-6?{start,end:next}:null;
}
/** Close one gap: the clips on its track from its end onwards move left by its length. */
export function closeGap(p:Project,trackId:string,gap:{start:number;end:number}):Project {
  const shift=gap.end-gap.start;
  return {...p,clips:p.clips.map(c=>c.trackId===trackId&&c.start>=gap.end-1e-6?{...c,start:Math.max(0,c.start-shift)}:c)};
}
/** New starts that remove every gap on a track, the one before its first clip included. Overlaps stay. */
function packedStarts(clips:readonly Clip[],trackId:string):{moved:Map<string,number>;gaps:number} {
  const own=clips.filter(c=>c.trackId===trackId).sort((a,b)=>a.start-b.start),moved=new Map<string,number>();
  let cursor=0,shift=0,gaps=0;
  for(const c of own){let start=c.start-shift;if(start>cursor+1e-6){gaps++;shift+=start-cursor;start=cursor;}moved.set(c.id,start);cursor=Math.max(cursor,start+c.duration);}
  return {moved,gaps};
}
export const trackGapCount=(clips:readonly Clip[],trackId:string)=>packedStarts(clips,trackId).gaps;
export function closeAllGaps(p:Project,trackId:string):Project {
  const {moved}=packedStarts(p.clips,trackId);
  return {...p,clips:p.clips.map(c=>{const start=moved.get(c.id);return start!==undefined&&Math.abs(start-c.start)>1e-9?{...c,start}:c;})};
}
export function tickSpacing(zoom:number):number {const ideal=80/zoom,power=10**Math.floor(Math.log10(ideal));return [1,2,5,10].map(n=>n*power).find(n=>n>=ideal)||power*10;}
/** At overview scale collapse sub-pixel clips into four-pixel bins; full project data stays selectable. */
export function visibleTimelineClips(clips:Clip[],left:number,right:number,zoom:number,selected:Set<string>):Clip[] {
  const visible:Clip[]=[],tiny=new Map<number,Clip>();
  for(const c of clips){if((c.start+c.duration)*zoom<left||c.start*zoom>right)continue;if(c.duration*zoom>=4)visible.push(c);else{const bin=Math.floor(c.start*zoom/4),old=tiny.get(bin);if(!old||selected.has(c.id)||!selected.has(old.id))tiny.set(bin,c);}}
  const limit=Math.max(500,Math.ceil((right-left)*2));return [...visible,...tiny.values()].sort((a,b)=>a.start-b.start).slice(-limit);
}
