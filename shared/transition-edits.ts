import type {Clip,Project,Transition} from './types';
import {clipSourceTime,clipSpeedAt,clipTimelineTime} from './speed';
import {compileTransitions,transitionProblems} from './transitions';

const EPS=1e-7;
function retainedPiece(original:Clip,candidate:Clip):boolean {
  if(original.mediaId!==candidate.mediaId||original.trackId!==candidate.trackId||candidate.text!==undefined)return false;
  const from=clipTimelineTime(original,candidate.in);
  if(from< -EPS||from+candidate.duration>original.duration+EPS)return false;
  // Rates are piecewise linear. Equality at every breakpoint in their union,
  // plus the initial source position, proves equality over the whole interval.
  const times=[0,candidate.duration,...(candidate.speedCurve||[]).map(p=>p.position*candidate.duration),...(original.speedCurve||[]).map(p=>p.position*original.duration-from).filter(t=>t>0&&t<candidate.duration)];
  if(Math.abs(candidate.in-clipSourceTime(original,from))>1e-6)return false;
  for(const dt of times)if(Math.abs(clipSpeedAt(candidate,dt)-clipSpeedAt(original,from+dt))>1e-8)return false;
  return true;
}
interface PieceBoundary {value:number;clip:Clip}
interface PieceIndex {from:PieceBoundary[];to:PieceBoundary[]}
const pieceKey=(clip:Clip)=>`${clip.trackId}\0${clip.mediaId}`;
function piecesNear(entries:PieceBoundary[],value:number):Clip[] {
  let lo=0,hi=entries.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(entries[mid].value<value-1e-6)lo=mid+1;else hi=mid;}
  const clips:Clip[]=[];for(let i=lo;i<entries.length&&entries[i].value<=value+1e-6;i++)clips.push(entries[i].clip);
  return clips;
}
/** A split retains the original ID on one piece and gives the other a new ID.
 * Retarget only a demonstrable retained source interval, never a replacement. */
function endpointPieces(original:Clip|undefined,newClips:Map<string,Clip>,pieces:Map<string,PieceIndex>,side:'from'|'to'):Clip[] {
  if(!original)return [];const retained=newClips.get(original.id);if(!retained)return [];
  const boundary=side==='from'?clipSourceTime(original,original.duration):original.in,index=pieces.get(pieceKey(original));
  const candidates=[retained,...(index?piecesNear(index[side],boundary):[])];
  return candidates.filter(c=>retainedPiece(original,c)&&Math.abs((side==='from'?clipSourceTime(c,c.duration):c.in)-boundary)<1e-6);
}
export function reconcileTransitions(previous:Project,next:Project):{project:Project;detached:string[]} {
  if(!next.transitions?.length)return {project:next,detached:[]};
  const old=new Map((previous.transitions||[]).map(t=>[t.id,t])),oldClips=new Map(previous.clips.map(c=>[c.id,c])),newClips=new Map(next.clips.map(c=>[c.id,c])),pieces=new Map<string,PieceIndex>();
  for(const c of newClips.values())if(!oldClips.has(c.id)&&c.text===undefined){const key=pieceKey(c),index=pieces.get(key)||{from:[],to:[]};index.from.push({value:clipSourceTime(c,c.duration),clip:c});index.to.push({value:c.in,clip:c});pieces.set(key,index);}
  for(const index of pieces.values()){index.from.sort((a,b)=>a.value-b.value);index.to.sort((a,b)=>a.value-b.value);}
  const transitions=next.transitions.map(value=>{
    const before=old.get(value.id);let t=value;
    if(before&&previous.fps!==next.fps&&before.durationFrames===value.durationFrames)t={...t,durationFrames:Math.max(1,Math.round(before.durationFrames/previous.fps*next.fps))};
    const a=newClips.get(t.fromClipId),b=newClips.get(t.toClipId);
    if(before&&a&&b&&pieces.size&&(a.trackId!==b.trackId||Math.abs(a.start+a.duration-b.start)>EPS)){
      const left=endpointPieces(oldClips.get(before.fromClipId),newClips,pieces,'from'),right=endpointPieces(oldClips.get(before.toClipId),newClips,pieces,'to');
      const pairs=left.flatMap(from=>right.filter(to=>from.trackId===to.trackId&&Math.abs(from.start+from.duration-to.start)<EPS).map(to=>({from,to})));
      if(pairs.length===1)t={...t,fromClipId:pairs[0].from.id,toClipId:pairs[0].to.id};
    }
    return t;
  });
  const candidate={...next,version:10 as const,transitions};
  try{compileTransitions(candidate);return {project:candidate,detached:[]};}catch{}
  const problems=transitionProblems(candidate);for(const [id,reason] of problems)if(!old.has(id))throw new Error(reason);
  const kept=transitions.filter(t=>!problems.has(t.id)),project={...candidate,transitions:kept.length?kept:undefined};compileTransitions(project);
  return {project,detached:[...problems.keys()]};
}
export function copyTransitions(transitions:readonly Transition[]|undefined,clipIds:ReadonlyMap<string,string>,createId:()=>string,fromFps=1,toFps=fromFps):Transition[] {
  return (transitions||[]).filter(t=>clipIds.has(t.fromClipId)&&clipIds.has(t.toClipId)).map(t=>({...t,id:createId(),fromClipId:clipIds.get(t.fromClipId)!,toClipId:clipIds.get(t.toClipId)!,durationFrames:Math.max(1,Math.round(t.durationFrames/fromFps*toFps))}));
}
