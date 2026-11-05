import type {Clip,Project} from './types';
import type {MotionBinding,MotionSource,MotionSourceLink} from './tracking';

export const MAX_MOTION_SOURCES=10000,MAX_PROJECT_MOTION_SOURCES=50000;
export const motionLinks=(b:MotionBinding):MotionSourceLink[]=>[{sourceClipId:b.sourceClipId,source:b.source},...(b.segments||[])];
export interface ResolvedMotionSource extends MotionSourceLink {index:number}
export function resolveMotionSources(project:Project,b:MotionBinding,clips:ReadonlyMap<string,Clip>=new Map(project.clips.map(c=>[c.id,c]))):ResolvedMotionSource[]{
  return motionLinks(b).map((link,index)=>{const live=link.sourceClipId?clips.get(link.sourceClipId):undefined;return live&&live.mediaId===link.source.mediaId&&!live.motionBinding?{index,sourceClipId:link.sourceClipId,source:live as MotionSource}:{index,source:link.source};});
}
/** Latest start wins overlaps (later split order wins equal starts). Gaps hold
 * the most recently ended piece; before all pieces, hold the earliest one.
 * Compile O(n log n) once per project edit, query O(log n), never per-frame
 * scanning of every clip/segment. Lazy heap removal bounds storage to n. */
export class MotionSourceTimeline {
  readonly sources:readonly ResolvedMotionSource[];
  private changes:{time:number;value:ResolvedMotionSource}[]=[];
  private first:ResolvedMotionSource;
  constructor(sources:readonly ResolvedMotionSource[]){
    if(!sources.length||sources.length>MAX_MOTION_SOURCES)throw new Error('추적 원본 조각 수가 지원 범위를 벗어났습니다.');this.sources=sources;
    const starts=[...sources].sort((a,b)=>a.source.start-b.source.start||a.index-b.index),events=[...new Set(sources.flatMap(s=>[s.source.start,s.source.start+s.source.duration]))].sort((a,b)=>a-b);
    const ends=[...sources].sort((a,b)=>a.source.start+a.source.duration-b.source.start-b.source.duration||a.source.start-b.source.start||a.index-b.index),heap:ResolvedMotionSource[]=[];
    const higher=(a:ResolvedMotionSource,b:ResolvedMotionSource)=>a.source.start>b.source.start||(a.source.start===b.source.start&&a.index>b.index);
    const push=(s:ResolvedMotionSource)=>{let at=heap.length;heap.push(s);while(at>0){const parent=(at-1)>>1;if(!higher(s,heap[parent]))break;heap[at]=heap[parent];at=parent;}heap[at]=s;};
    const pop=()=>{const last=heap.pop();if(!heap.length||!last)return;let at=0;while(at*2+1<heap.length){let child=at*2+1;if(child+1<heap.length&&higher(heap[child+1],heap[child]))child++;if(!higher(heap[child],last))break;heap[at]=heap[child];at=child;}heap[at]=last;};
    this.first=starts[0];let si=0,ei=0,held:ResolvedMotionSource|undefined,previous:ResolvedMotionSource|undefined;
    for(const time of events){while(si<starts.length&&starts[si].source.start<=time)push(starts[si++]);while(ei<ends.length&&ends[ei].source.start+ends[ei].source.duration<=time)held=ends[ei++];while(heap.length&&heap[0].source.start+heap[0].source.duration<=time)pop();const value=heap[0]||held||this.first;if(value!==previous){this.changes.push({time,value});previous=value;}}
  }
  private index(time:number){let lo=0,hi=this.changes.length;while(lo<hi){const mid=(lo+hi)>>>1;if(this.changes[mid].time<=time)lo=mid+1;else hi=mid;}return lo-1;}
  at(time:number):ResolvedMotionSource{return this.changes[this.index(time)]?.value||this.first;}
  ranges(from:number,to:number){const result:{from:number;to:number;value:ResolvedMotionSource}[]=[];let at=from,value=this.at(from);for(let i=this.index(from)+1;i<this.changes.length&&this.changes[i].time<to;i++){const change=this.changes[i];if(change.time>at)result.push({from:at,to:change.time,value});at=change.time;value=change.value;}if(to>at)result.push({from:at,to,value});return result;}
}
