import type {Clip,Easing,MediaAsset,Project,Transition} from './types';
import {ease,visualTrackEnabled} from './effects';
import {clipTimelineTime} from './speed';

const EPS=1e-7;
export interface CompiledTransition {transition:Transition;from:Clip;to:Clip;trackId:string;cut:number;start:number;end:number;pre:number;post:number}
/** Bounds are seconds on the ORIGINAL clip clock, including negative pre-roll. */
export interface ClipExposure {clip:Clip;visualFrom:number;visualTo:number;audioFrom:number;audioTo:number;transitions:CompiledTransition[]}
export interface TransitionPlan {project:Project;transitions:CompiledTransition[];byClip:Map<string,ClipExposure>}
export interface TransitionBounds {maxFrames:number;reason?:string;pendingMediaIds:string[]}
export type TransitionVisualNode={type:'clip';clip:Clip}|{type:'transition';transition:Transition;from:Clip;to:Clip;progress:number;start:number;end:number;trackId:string};
interface TrackIndex {starts:Clip[];ends:Clip[];prefixEnd:number[]}
interface ProjectIndex {project:Project;clips:Map<string,Clip>;assets:Map<string,MediaAsset>;tracks:Map<string,TrackIndex>}

const lower=(items:Clip[],time:number,key:(clip:Clip)=>number)=>{let a=0,b=items.length;while(a<b){const m=(a+b)>>>1;if(key(items[m])<time)a=m+1;else b=m;}return a;};
function indexProject(project:Project):ProjectIndex {
  const grouped=new Map<string,Clip[]>();for(const clip of project.clips){const list=grouped.get(clip.trackId)||[];list.push(clip);grouped.set(clip.trackId,list);}
  const tracks=new Map<string,TrackIndex>();for(const [id,clips] of grouped){const starts=clips.slice().sort((a,b)=>a.start-b.start),ends=clips.slice().sort((a,b)=>a.start+a.duration-b.start-b.duration);let max=-Infinity;tracks.set(id,{starts,ends,prefixEnd:starts.map(c=>max=Math.max(max,c.start+c.duration))});}
  return {project,clips:new Map(project.clips.map(c=>[c.id,c])),assets:new Map(project.media.map(m=>[m.id,m])),tracks};
}
function pair(index:ProjectIndex,fromId:string,toId:string):{from:Clip;to:Clip}|undefined {
  const from=index.clips.get(fromId),to=index.clips.get(toId);
  if(!from||!to||from===to||from.trackId!==to.trackId||from.text!==undefined||to.text!==undefined||index.project.tracks.find(t=>t.id===from.trackId)?.type!=='video')return;
  if(!['video','image'].includes(index.assets.get(from.mediaId||'')?.kind||'')||!['video','image'].includes(index.assets.get(to.mediaId||'')?.kind||''))return;
  if(Math.abs(from.start+from.duration-to.start)>EPS)return;
  return {from,to};
}
export function transitionInterval(transition:Transition,from:Clip,to:Clip,fps:number):CompiledTransition {
  const pre=Math.floor(transition.durationFrames/2)/fps,post=Math.ceil(transition.durationFrames/2)/fps,cut=to.start;
  return {transition,from,to,trackId:from.trackId,cut,start:cut-pre,end:cut+post,pre,post};
}
function sourceBounds(index:ProjectIndex,clip:Clip):{from:number;to:number;pending?:string} {
  const asset=index.assets.get(clip.mediaId!)!;
  if(asset.kind==='image')return {from:-Infinity,to:Infinity};
  if(asset.videoStart===undefined||asset.videoEnd===undefined)return {from:0,to:0,pending:asset.id};
  return {from:clipTimelineTime(clip,asset.videoStart),to:clipTimelineTime(clip,asset.videoEnd)};
}
function bounds(index:ProjectIndex,from:Clip,to:Clip,others:CompiledTransition[],excludeId?:string):TransitionBounds {
  const pendingMediaIds:string[]=[];const a=sourceBounds(index,from),b=sourceBounds(index,to);
  for(const item of [a,b])if(item.pending&&!pendingMediaIds.includes(item.pending))pendingMediaIds.push(item.pending);
  if(pendingMediaIds.length)return {maxFrames:0,pendingMediaIds,reason:'원본 영상의 실제 프레임 범위를 분석해야 합니다.'};
  if(a.from>from.duration+EPS||a.to<from.duration-EPS||b.from>EPS||b.to< -EPS)return {maxFrames:0,pendingMediaIds,reason:'컷 위치가 실제 영상 프레임 범위를 벗어납니다.'};
  let before=Math.min(from.duration,from.duration-a.from,-b.from),after=Math.min(to.duration,a.to-from.duration,b.to);
  const cut=to.start,track=index.tracks.get(from.trackId)!;
  const excluded=(clip:Clip)=>clip.id===from.id||clip.id===to.id;
  // Find a third clip across the cut, and the nearest occupied interval on each
  // side. Sorted endpoint indexes avoid O(clips * transitions) on long edits.
  for(let i=lower(track.starts,cut-EPS,c=>c.start)-1;i>=0&&track.prefixEnd[i]>cut+EPS;i--){const c=track.starts[i];if(!excluded(c)&&c.start+c.duration>cut+EPS)return {maxFrames:0,pendingMediaIds,reason:'컷에 다른 클립이 겹쳐 있습니다.'};}
  for(let i=lower(track.ends,cut+EPS,c=>c.start+c.duration)-1;i>=0;i--){const c=track.ends[i];if(!excluded(c)){before=Math.min(before,cut-c.start-c.duration);break;}}
  for(let i=lower(track.starts,cut-EPS,c=>c.start);i<track.starts.length;i++){const c=track.starts[i];if(!excluded(c)){after=Math.min(after,c.start-cut);break;}}
  for(const other of others){if(other.trackId!==from.trackId||other.transition.id===excludeId)continue;
    if(other.end<=cut+EPS)before=Math.min(before,cut-other.end);
    else if(other.start>=cut-EPS)after=Math.min(after,other.start-cut);
    else return {maxFrames:0,pendingMediaIds,reason:'다른 전환 구간과 겹칩니다.'};
  }
  const p=Math.max(0,Math.floor(before*index.project.fps+1e-8)),q=Math.max(0,Math.floor(after*index.project.fps+1e-8));
  const maxFrames=Math.max(0,Math.min(2*p+1,2*q));
  return {maxFrames,pendingMediaIds,...(maxFrames?{}:{reason:'전환에 필요한 원본 여유 구간이 부족합니다.'})};
}
export function transitionBounds(project:Project,fromClipId:string,toClipId:string,excludeId?:string):TransitionBounds {
  const index=indexProject(project),selected=pair(index,fromClipId,toClipId);
  if(!selected)return {maxFrames:0,pendingMediaIds:[],reason:'같은 영상 트랙에서 맞닿은 두 클립을 선택하세요.'};
  const others=(project.transitions||[]).flatMap(t=>{const p=pair(index,t.fromClipId,t.toClipId);return p?[transitionInterval(t,p.from,p.to,project.fps)]:[];});
  return bounds(index,selected.from,selected.to,others,excludeId);
}
export const maxTransitionFrames=(project:Project,fromClipId:string,toClipId:string,excludeId?:string)=>transitionBounds(project,fromClipId,toClipId,excludeId).maxFrames;

function assertDefinition(value:Transition,fps:number) {
  const id=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&v.length<=128&&!v.includes('\0');
  if(!value||typeof value!=='object'||Array.isArray(value)||!id(value.id)||!id(value.fromClipId)||!id(value.toClipId)||!['dissolve','wipe','slide','zoom'].includes(value.kind)||!Number.isInteger(value.durationFrames)||value.durationFrames<1||value.durationFrames>Math.ceil(86400*fps)||
    (value.easing!==undefined&&!['linear','ease-in','ease-out','ease-in-out','hold'].includes(value.easing))||(value.direction!==undefined&&!['left','right','up','down'].includes(value.direction))||(value.audio!==undefined&&!['linear','equal-power','none'].includes(value.audio)))throw new Error('잘못된 전환 설정입니다.');
}
export function compileTransitions(project:Project):TransitionPlan {
  const byClip=new Map(project.clips.map(clip=>[clip.id,{clip,visualFrom:0,visualTo:clip.duration,audioFrom:0,audioTo:clip.duration,transitions:[] as CompiledTransition[]}]));
  if(project.transitions===undefined)return {project,transitions:[],byClip};
  if(project.version<3||!Array.isArray(project.transitions)||project.transitions.length>10000)throw new Error('전환은 프로젝트 형식 3 이상이 필요합니다.');
  const index=indexProject(project),ids=new Set<string>(),outgoing=new Set<string>(),incoming=new Set<string>(),transitions:CompiledTransition[]=[];
  for(const transition of project.transitions){assertDefinition(transition,project.fps);
    if(ids.has(transition.id)||outgoing.has(transition.fromClipId)||incoming.has(transition.toClipId))throw new Error('같은 컷에 전환을 중복 적용할 수 없습니다.');
    const selected=pair(index,transition.fromClipId,transition.toClipId);if(!selected)throw new Error('전환이 참조하는 클립이 없거나 컷이 맞닿지 않습니다.');
    ids.add(transition.id);outgoing.add(transition.fromClipId);incoming.add(transition.toClipId);transitions.push(transitionInterval(transition,selected.from,selected.to,project.fps));
  }
  const sorted=transitions.slice().sort((a,b)=>a.trackId.localeCompare(b.trackId)||a.start-b.start);
  for(let i=1;i<sorted.length;i++)if(sorted[i].trackId===sorted[i-1].trackId&&sorted[i].start<sorted[i-1].end-EPS)throw new Error('전환 구간끼리 겹칠 수 없습니다.');
  for(const item of transitions){const limit=bounds(index,item.from,item.to,[],item.transition.id);
    if(item.transition.durationFrames>limit.maxFrames)throw new Error(limit.reason||`전환 길이는 최대 ${limit.maxFrames}프레임입니다. 원본 여유 구간과 주변 클립을 확인하세요.`);
    const a=byClip.get(item.from.id)!,b=byClip.get(item.to.id)!;a.visualTo=Math.max(a.visualTo,item.end-item.from.start);b.visualFrom=Math.min(b.visualFrom,item.start-item.to.start);
    if(item.transition.audio!=='none'){a.audioTo=Math.max(a.audioTo,item.end-item.from.start);b.audioFrom=Math.min(b.audioFrom,item.start-item.to.start);}
    a.transitions.push(item);b.transitions.push(item);
  }
  return {project,transitions,byClip};
}
export function assertTransitions(project:Project){compileTransitions(project);}
/** Editor repair after a clip edit. Shares the exact render validation rules;
 * returns invalid references without mutating clips or silently shortening cuts. */
export function transitionProblems(project:Project):Map<string,string> {
  const problems=new Map<string,string>(),index=indexProject(project),items:CompiledTransition[]=[],ids=new Set<string>(),fromIds=new Set<string>(),toIds=new Set<string>();
  for(const transition of project.transitions||[]){try{
    assertDefinition(transition,project.fps);const selected=pair(index,transition.fromClipId,transition.toClipId);if(!selected)throw new Error('전환의 컷 위치가 변경되었습니다.');
    if(ids.has(transition.id)||fromIds.has(transition.fromClipId)||toIds.has(transition.toClipId))throw new Error('같은 컷에 전환이 중복되었습니다.');
    const limit=bounds(index,selected.from,selected.to,[]);if(transition.durationFrames>limit.maxFrames)throw new Error(limit.reason||'전환에 필요한 원본 여유 구간이 부족합니다.');
    ids.add(transition.id);fromIds.add(transition.fromClipId);toIds.add(transition.toClipId);items.push(transitionInterval(transition,selected.from,selected.to,project.fps));
  }catch(error){problems.set(transition.id,error instanceof Error?error.message:String(error));}}
  items.sort((a,b)=>a.trackId.localeCompare(b.trackId)||a.start-b.start);let previous:CompiledTransition|undefined;
  for(const item of items){if(previous&&previous.trackId===item.trackId&&item.start<previous.end-EPS)problems.set(item.transition.id,'전환 구간이 겹칩니다.');else previous=item;}
  return problems;
}
export function transitionProgress(item:CompiledTransition,time:number):number {return ease((time-item.start)/(item.end-item.start),item.transition.easing);}
export function transitionAudioWeight(item:CompiledTransition,side:'from'|'to',time:number):number {
  if(item.transition.audio==='none')return side==='from'?Number(time<item.cut):Number(time>=item.cut);
  const p=transitionProgress(item,time);return item.transition.audio==='equal-power'?(side==='from'?Math.cos(p*Math.PI/2):Math.sin(p*Math.PI/2)):(side==='from'?1-p:p);
}
export function transitionGain(plan:TransitionPlan,clipId:string,time:number):number {
  return (plan.byClip.get(clipId)?.transitions||[]).reduce((gain,item)=>gain*transitionAudioWeight(item,item.from.id===clipId?'from':'to',time),1);
}
export function exposureForClip(input:Project|TransitionPlan,clip:Clip):ClipExposure {
  const plan='byClip' in input?input:compileTransitions(input);return plan.byClip.get(clip.id)||{clip,visualFrom:0,visualTo:clip.duration,audioFrom:0,audioTo:clip.duration,transitions:[]};
}
export function visualNodesAt(plan:TransitionPlan,time:number):TransitionVisualNode[] {
  const {project}=plan,tracks=new Map(project.tracks.map((track,index)=>[track.id,{track,index}])),assets=new Map(project.media.map(m=>[m.id,m]));
  const active=plan.transitions.filter(item=>time>=item.start&&time<item.end&&visualTrackEnabled(project,tracks.get(item.trackId)?.track)),suppressed=new Set(active.flatMap(t=>[t.from.id,t.to.id]));
  const nodes:TransitionVisualNode[]=project.clips.filter(c=>!suppressed.has(c.id)&&c.text===undefined&&assets.get(c.mediaId||'')?.kind!=='audio'&&time>=c.start&&time<c.start+c.duration&&visualTrackEnabled(project,tracks.get(c.trackId)?.track)).map(clip=>({type:'clip',clip}));
  for(const item of active)nodes.push({type:'transition',transition:item.transition,from:item.from,to:item.to,progress:transitionProgress(item,time),start:item.start,end:item.end,trackId:item.trackId});
  const clip=(node:TransitionVisualNode)=>node.type==='clip'?node.clip:node.from;
  return nodes.sort((a,b)=>(tracks.get(clip(a).trackId)?.index??0)-(tracks.get(clip(b).trackId)?.index??0)||clip(a).start-clip(b).start);
}
export const buildTransitionPlan=(project:Project,time:number)=>visualNodesAt(compileTransitions(project),time);
export function transitionDirection(direction:Transition['direction']='left'):[number,number] {return direction==='right'?[1,0]:direction==='up'?[0,-1]:direction==='down'?[0,1]:[-1,0];}
/** Reference sampler for premultiplied full-canvas RGBA. Coordinates are top-left
 * normalized; callers return transparent samples outside [0,1]. */
export function transitionPixel(kind:Transition['kind'],progress:number,direction:Transition['direction'],x:number,y:number,sampleA:(x:number,y:number)=>readonly number[],sampleB:(x:number,y:number)=>readonly number[]):number[] {
  const p=Math.max(0,Math.min(1,progress));if(p===0)return [...sampleA(x,y)];if(p===1)return [...sampleB(x,y)];
  const [dx,dy]=transitionDirection(direction),safe=(sample:typeof sampleA,u:number,v:number)=>u<0||u>=1||v<0||v>=1?[0,0,0,0]:sample(u,v);
  if(kind==='slide'){const a=safe(sampleA,x-p*dx,y-p*dy),b=safe(sampleB,x+(1-p)*dx,y+(1-p)*dy);return a.map((value,i)=>value+b[i]);}
  if(kind==='wipe'){const axis=dx?x:y,sign=dx||dy,reveal=sign<0?axis>=1-p:axis<p;return [...(reveal?sampleB(x,y):sampleA(x,y))];}
  const aScale=kind==='zoom'?1+.25*p:1,bScale=kind==='zoom'?.75+.25*p:1;
  const a=safe(sampleA,(x-.5)/aScale+.5,(y-.5)/aScale+.5),b=safe(sampleB,(x-.5)/bScale+.5,(y-.5)/bScale+.5);return a.map((value,i)=>value*(1-p)+b[i]*p);
}
