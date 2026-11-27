import type {CaptionWord,Clip,Project,SpeechWord} from './types';
import {audioTrackEnabled} from './effects';
import {trimClip,uid} from './project';
import {assertCaptionWords,captionGraphemes} from './captions';
import {joinTextRuns,sliceTextRuns} from './text-runs';

/* Caption timing tools for the 자막 tab:
 *  - 싱크 맞추기: align caption text to recognized speech (Whisper words on the timeline) and move
 *    each caption onto the speech it transcribes.
 *  - 짧게 나누기 / 길게 합치기: re-break captions into shorter or longer units at natural phrase
 *    boundaries, timing each piece from measured word times when the caption has them. */

const frame=(time:number,fps:number)=>Math.round(time*fps)/fps;
const isUnit=(char:string)=>/[\p{L}\p{N}]/u.test(char);
interface Unit {char:string;owner:number;index:number}
/** Letters and digits only, lower-cased and compatibility-normalized; punctuation and spaces don't count. */
function units(text:string,owner:number):Unit[]{
  const out:Unit[]=[];
  for(const g of captionGraphemes(text)){const normalized=g.text.normalize('NFKC').toLowerCase();for(const char of normalized)if(isUnit(char))out.push({char,owner,index:g.from});}
  return out;
}

export interface SyncResult {start:number;duration:number;captionWords?:CaptionWord[]}
export interface SyncReport {updates:Map<string,SyncResult>;matched:number;unmatched:number}
const MATCH=3,MISMATCH=-2,SKIP_CAPTION=-2,SKIP_SPEECH=-1,NONE=-1e9;
/** Semi-global alignment of caption characters (all must be placed) against recognized characters
 * (free to skip at both ends). Returns, for each caption unit, the speech unit it lines up with (-1
 * if none) and whether the characters are equal. A band around the captions' current timing keeps
 * long projects tractable. */
function align(a:Unit[],b:Unit[],hint:(i:number)=>number):{pair:Int32Array;exact:Uint8Array}{
  const n=a.length,m=b.length,pair=new Int32Array(n).fill(-1),exact=new Uint8Array(n);
  if(!n||!m)return {pair,exact};
  // Traceback costs one byte per cell: the band narrows on very long projects to stay near 120 MB.
  const full=n*m<=40_000_000,half=full?m:Math.max(200,Math.min(Math.max(1500,Math.ceil(m*.05)),Math.floor((120_000_000/n-1)/2)));
  const lo=new Int32Array(n+1),hi=new Int32Array(n+1);
  for(let i=0,center=0;i<=n;i++){center=Math.max(center,full?0:hint(Math.max(0,i-1)));lo[i]=full?0:Math.max(0,Math.min(m,center-half));hi[i]=full?m:Math.min(m,center+half);if(i&&lo[i]<lo[i-1])lo[i]=lo[i-1];if(i&&hi[i]<hi[i-1])hi[i]=hi[i-1];}
  lo[0]=0;hi[0]=m;
  const offsets=new Float64Array(n+2);for(let i=0;i<=n;i++)offsets[i+1]=offsets[i]+(hi[i]-lo[i]+1);
  const dir=new Uint8Array(offsets[n+1]);
  let prev=new Float64Array(m+1),cur=new Float64Array(m+1);prev.fill(0);// Leading speech is free to skip.
  for(let i=1;i<=n;i++){
    cur.fill(NONE);const from=lo[i],to=hi[i],base=offsets[i]-from;
    for(let j=from;j<=to;j++){
      let best=NONE,d=0;
      if(j>0&&j-1>=lo[i-1]&&j-1<=hi[i-1]){const v=prev[j-1]+(a[i-1].char===b[j-1].char?MATCH:MISMATCH);if(v>best){best=v;d=1;}}
      if(j>=lo[i-1]&&j<=hi[i-1]){const v=prev[j]+SKIP_CAPTION;if(v>best){best=v;d=2;}}
      if(j>from){const v=cur[j-1]+SKIP_SPEECH;if(v>best){best=v;d=3;}}
      cur[j]=best;dir[base+j]=d;
    }
    [prev,cur]=[cur,prev];
  }
  let j=lo[n],best=NONE;for(let k=lo[n];k<=hi[n];k++)if(prev[k]>best){best=prev[k];j=k;}// Trailing speech is free.
  for(let i=n;i>0;){const d=dir[offsets[i]-lo[i]+j];if(d===1){pair[i-1]=j-1;exact[i-1]=a[i-1].char===b[j-1].char?1:0;i--;j--;}else if(d===2)i--;else if(d===3)j--;else break;}
  return {pair,exact};
}
/** New timings for captions on one track, from recognized words on the timeline. Captions with too
 * little recognized text keep their length and sit between their synced neighbours. */
export function syncCaptionTimes(captions:readonly Clip[],words:readonly SpeechWord[],fps:number,options:{lead?:number;tail?:number;closeGap?:number;minDuration?:number}={}):SyncReport{
  const lead=options.lead??.05,tail=options.tail??.25,closeGap=options.closeGap??.3,minDuration=Math.max(1/fps,options.minDuration??.4);
  const sorted=[...captions].sort((x,y)=>x.start-y.start),speech=[...words].filter(w=>w.text.trim()&&w.end>w.start).sort((x,y)=>x.start-y.start);
  const a:Unit[]=sorted.flatMap((clip,owner)=>units(clip.text||'',owner));
  const b:Unit[]=[],times:Array<[number,number]>=[];
  speech.forEach((word,owner)=>{const list=units(word.text,owner);list.forEach((unit,k)=>{b.push(unit);times.push([word.start+(word.end-word.start)*k/list.length,word.start+(word.end-word.start)*(k+1)/list.length]);});});
  // Band centre: where each caption unit's current time falls among the recognized units.
  const unitTime=(i:number)=>{const unit=a[i],clip=sorted[unit.owner],count=Math.max(1,(clip.text||'').length);return clip.start+clip.duration*unit.index/count;};
  const hint=(i:number)=>{const t=unitTime(i);let low=0,high=times.length;while(low<high){const mid=(low+high)>>>1;if(times[mid][0]<t)low=mid+1;else high=mid;}return low;};
  const {pair,exact}=align(a,b,hint);
  const spans=sorted.map(()=>({first:-1,last:-1,exact:0,total:0}));
  a.forEach((unit,i)=>{const s=spans[unit.owner];s.total++;if(pair[i]<0)return;if(s.first<0)s.first=i;s.last=i;s.exact+=exact[i];});
  const placed=sorted.map((clip,k)=>{const s=spans[k];if(s.first<0||s.exact<Math.max(1,Math.ceil(s.total*.3)))return null;return {start:times[pair[s.first]][0],end:times[pair[s.last]][1]};});
  // Unplaced captions keep their duration, fitted between placed neighbours.
  const result:Array<{start:number;end:number}>=sorted.map((clip,k)=>{const p=placed[k];if(p)return {...p};return {start:clip.start,end:clip.start+clip.duration};});
  for(let k=0;k<sorted.length;k++){if(placed[k])continue;const before=result.slice(0,k).reverse().find((_,i)=>placed[k-1-i])?.end??0;const nextIndex=placed.findIndex((p,i)=>i>k&&p),after=nextIndex>=0?result[nextIndex].start:Infinity;const length=sorted[k].duration;let start=Math.max(before,Math.min(result[k].start,after-length));result[k]={start,end:Math.min(after,start+length)};}
  // Pad onto the speech, keep order, close flicker-sized gaps and land on frames.
  for(let k=0;k<result.length;k++){const r=result[k];r.start=Math.max(0,r.start-(placed[k]?lead:0));r.end=r.end+(placed[k]?tail:0);}
  for(let k=0;k<result.length;k++){
    const r=result[k],next=result[k+1];
    if(k>0)r.start=Math.max(r.start,result[k-1].end);
    r.end=Math.max(r.end,r.start+minDuration);
    if(next){if(r.end>next.start)r.end=Math.max(next.start,r.start+1/fps);else if(next.start-r.end<closeGap)r.end=next.start;}
  }
  const ranges=sorted.map(()=>[Infinity,-Infinity]);a.forEach((unit,i)=>{ranges[unit.owner][0]=Math.min(ranges[unit.owner][0],i);ranges[unit.owner][1]=i+1;});
  const updates=new Map<string,SyncResult>();let matched=0,previousEnd=0;
  for(let k=0;k<sorted.length;k++){
    const clip=sorted[k],r=result[k],start=Math.max(frame(r.start,fps),previousEnd),end=Math.max(frame(r.end,fps),start+1/fps),duration=end-start;previousEnd=end;
    if(placed[k])matched++;
    updates.set(clip.id,{start,duration,captionWords:placed[k]?wordsFor(clip,a.slice(ranges[k][0],ranges[k][1]),pair.subarray(ranges[k][0],Math.max(ranges[k][0],ranges[k][1])),times,start,duration):undefined});
  }
  return {updates,matched,unmatched:sorted.length-matched};
}
/** Measured times for each space-separated word of a synced caption, local to its new start. */
function wordsFor(clip:Clip,own:Unit[],pair:Int32Array,times:Array<[number,number]>,start:number,duration:number):CaptionWord[]|undefined{
  const text=clip.text||'',tokens=[...text.matchAll(/\S+/g)].map(m=>({from:m.index!,to:m.index!+m[0].length}));
  const out:CaptionWord[]=[];let last=0;
  for(const token of tokens){
    let first=Infinity,end=-Infinity;
    own.forEach((unit,i)=>{if(unit.index<token.from||unit.index>=token.to||pair[i]<0)return;first=Math.min(first,times[pair[i]][0]);end=Math.max(end,times[pair[i]][1]);});
    if(!Number.isFinite(first))continue;
    const s=Math.max(last,Math.min(duration,first-start)),e=Math.min(duration,end-start);if(e-s<1e-4)continue;
    out.push({from:token.from,to:token.to,start:s,end:e,timing:'measured'});last=e;
  }
  try{if(!out.length)return undefined;assertCaptionWords(text,out,0,duration);return out;}catch{return undefined;}
}

/** Loudness samples per second used to tighten recognized word times. */
export const SPEECH_ENVELOPE_RATE=100;
/** Whisper's word times often start at the end of the previous speech, swallowing the pause before
 * the word. Each word is trimmed to the loud part of its own span (dBFS envelope). A word placed
 * wholly in silence moves to the next onset of speech within 3 s (otherwise it keeps its times).
 * The threshold sits between the noise floor and the loud peaks. */
export function refineWordTimes(words:readonly SpeechWord[],envelope:Float32Array,offset=0,rate=SPEECH_ENVELOPE_RATE):SpeechWord[]{
  if(!envelope.length)return [...words];
  const sorted=Float32Array.from(envelope).sort(),floor=Math.max(-100,sorted[Math.floor(sorted.length*.1)]),peak=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.98))];
  if(!(peak-floor>12))return [...words];// No usable contrast (constant noise or silence).
  const threshold=Math.max(-55,floor+(peak-floor)*.35),loud=(i:number)=>i>=0&&i<envelope.length&&envelope[i]>threshold;
  return words.map(word=>{
    const a=Math.max(0,Math.floor((word.start-offset)*rate)),b=Math.min(envelope.length,Math.ceil((word.end-offset)*rate));
    let first=-1,last=-1;for(let i=a;i<b;i++)if(loud(i)){if(first<0)first=i;last=i;}
    if(first<0){for(let i=b;i<Math.min(envelope.length,b+3*rate);i++)if(loud(i)){const at=Math.max(word.start,offset+i/rate-.04);return {...word,start:at,end:at+.05};}return word;}
    const start=Math.max(word.start,offset+first/rate-.04),end=Math.min(word.end,offset+(last+1)/rate+.04);
    return end-start>=.05?{...word,start,end}:word;
  });
}

/* ---- Re-breaking captions ---- */
const SENTENCE=/[.?!。？！…]["'”’」』)\]]*$/u,CLAUSE=/[,，、;:]["'”’」』)\]]*$/u;
const CONNECTIVE=/(?:고|며|면서|서|면|는데|은데|던데|지만|니까|으니까|어서|아서|해서|여서|도록|려고|으려고|다가|거나|든지|자마자|듯이|더니|었는데|았는데|는데요|고요|구요|죠|요|다|네|군요|까)$/u;
const PARTICLE=/(?:은|는|이|가|을|를|에|에서|에게|한테|께|로|으로|와|과|랑|이랑|하고|도|만|의|부터|까지|처럼|보다)$/u;
const length=(text:string)=>captionGraphemes(text.trim()).length;
interface Token {from:number;to:number;text:string}
/** Where a caption's text can be broken, and how natural each break is (lower is better). */
function breakCost(text:string,token:Token,next:Token,gap:number|undefined){
  if(/\n/.test(text.slice(token.to,next.from)))return 0;
  if(SENTENCE.test(token.text))return 0;
  if(gap!==undefined&&gap>=.35)return .5;
  if(CLAUSE.test(token.text))return 1;
  if(gap!==undefined&&gap>=.15)return 2;
  const word=token.text.replace(/[^\p{L}\p{N}]+$/u,'');
  if(CONNECTIVE.test(word))return 3;
  if(PARTICLE.test(word))return 4.5;
  return 7;
}
/** Character ranges of the pieces a caption breaks into, each at most `maxChars` long when possible. */
export function captionBreaks(text:string,maxChars:number,words?:readonly CaptionWord[]):Array<[number,number]>{
  const tokens:Token[]=[...text.matchAll(/\S+/g)].map(m=>({from:m.index!,to:m.index!+m[0].length,text:m[0]}));
  if(!tokens.length)return [[0,text.length]];
  if(length(text)<=maxChars&&!/\n/.test(text.trim()))return [[tokens[0].from,tokens.at(-1)!.to]];
  // A single unbroken token longer than the limit is cut between graphemes.
  const pieces:Token[]=tokens.flatMap(token=>{if(length(token.text)<=maxChars)return [token];const g=captionGraphemes(token.text),out:Token[]=[];for(let i=0;i<g.length;i+=maxChars){const from=token.from+g[i].from,to=token.from+g[Math.min(g.length,i+maxChars)-1].to;out.push({from,to,text:text.slice(from,to)});}return out;});
  const timeAt=(index:number,edge:'start'|'end')=>{const w=words?.find(word=>word.from<=index&&index<word.to);return w?w[edge]:undefined;};
  const n=pieces.length,total=length(text),count=Math.max(1,Math.ceil(total/maxChars)),target=Math.min(maxChars,total/count);
  const best=new Float64Array(n+1).fill(Infinity),from=new Int32Array(n+1).fill(-1);best[0]=0;
  for(let end=1;end<=n;end++)for(let start=end-1;start>=0;start--){
    const len=length(text.slice(pieces[start].from,pieces[end-1].to));if(len>maxChars&&end-start>1)break;
    const last=end===n,cost=last?0:breakCost(text,pieces[end-1],pieces[end],(()=>{const a=timeAt(pieces[end-1].to-1,'end'),b=timeAt(pieces[end].from,'start');return a!==undefined&&b!==undefined?b-a:undefined;})());
    const balance=((len-target)/Math.max(1,target))**2*4,short=len<4&&n>1?6:0,value=best[start]+cost+balance+short+8;
    if(value<best[end]){best[end]=value;from[end]=start;}
  }
  const ranges:Array<[number,number]>=[];for(let end=n;end>0;end=from[end])ranges.unshift([pieces[from[end]].from,pieces[end-1].to]);
  return ranges;
}
/** One caption split into shorter captions at natural breaks. Each piece starts where its first
 * word is spoken (measured word times) or in proportion to its characters. */
export function splitCaption(clip:Clip,maxChars:number,fps:number):Clip[]{
  const text=clip.text??'';if(clip.text===undefined)return [clip];
  const ranges=captionBreaks(text,maxChars,clip.captionWords);if(ranges.length<2)return [clip];
  const minimum=Math.max(1/fps,.2),total=ranges.reduce((n,[a,b])=>n+length(text.slice(a,b)),0);
  const starts:number[]=[0];let acc=0;
  for(let k=1;k<ranges.length;k++){
    acc+=length(text.slice(...ranges[k-1]));
    const measured=clip.captionWords?.find(w=>w.timing!=='estimated'&&w.from>=ranges[k][0]&&w.from<ranges[k][1]);
    starts.push(measured?measured.start:clip.duration*acc/total);
  }
  // Frame grid, increasing, and every piece at least `minimum` long.
  const edges=[...starts.map(t=>frame(clip.start+t,fps)-clip.start),clip.duration];
  for(let k=1;k<edges.length-1;k++)edges[k]=Math.max(edges[k],edges[k-1]+minimum);
  for(let k=edges.length-2;k>0;k--)edges[k]=Math.min(edges[k],edges[k+1]-minimum);
  if(edges.some((t,k)=>k>0&&t-edges[k-1]<minimum-1e-9)||edges[1]<=0)return [clip];
  return ranges.map(([from,to],k)=>{
    const piece=trimClip(clip,edges[k],edges[k+1]),pieceText=text.slice(from,to),offset=edges[k];
    const words=clip.captionWords?.flatMap(w=>w.from>=from&&w.to<=to?[{...w,from:w.from-from,to:w.to-from,start:Math.max(0,w.start-offset),end:Math.min(piece.duration,w.end-offset)}]:[]).filter(w=>w.end>w.start);
    let captionWords:CaptionWord[]|undefined=words?.length?words:undefined;
    try{if(captionWords)assertCaptionWords(pieceText,captionWords,0,piece.duration);}catch{captionWords=undefined;}
    return {...piece,id:k?uid():clip.id,text:pieceText,name:pieceText.replace(/\n/g,' ').slice(0,36)||'자막',textRuns:sliceTextRuns(clip.textRuns,from,to,pieceText),captionWords,sourceClipOffset:undefined,sourceClipDuration:undefined};
  });
}
const lookKey=(c:Clip)=>JSON.stringify([c.trackId,c.fontSize,c.fontFamily,c.color,c.textBackground,c.textStyle,c.align,c.captionStyle,c.x,c.y,c.scale,c.rotation,c.opacity,c.keyframes.length,c.motionBinding?1:0]);
/** Neighbouring captions on one track joined into longer ones: only captions that look the same,
 * follow each other within `maxGap` seconds and fit `maxChars` and `maxDuration` together. A caption
 * ending a sentence only takes a short follower. */
export function mergeCaptions(clips:readonly Clip[],options:{maxChars:number;maxGap:number;maxDuration:number;eligible?:(clip:Clip)=>boolean}):{clips:Clip[];removed:string[]}{
  const sorted=[...clips].sort((a,b)=>a.start-b.start),out:Clip[]=[],removed:string[]=[],eligible=options.eligible??(()=>true);
  for(const clip of sorted){
    const last=out.at(-1);
    if(last&&last.text!==undefined&&clip.text!==undefined&&eligible(last)&&eligible(clip)&&!last.keyframes.length&&!clip.keyframes.length&&lookKey(last)===lookKey(clip)){
      const gap=clip.start-(last.start+last.duration),joined=last.text.trimEnd()+' '+clip.text.trimStart(),span=clip.start+clip.duration-last.start;
      const sentence=SENTENCE.test(last.text.trim())&&length(clip.text)>Math.max(6,options.maxChars/3);
      if(gap>=-1e-6&&gap<=options.maxGap&&length(joined)<=options.maxChars&&span<=options.maxDuration&&!sentence&&!/\n/.test(last.text+clip.text)){
        const kept=last.text.trimEnd().length,offset=kept+1,shift=clip.start-last.start,lead=clip.text.length-clip.text.trimStart().length;
        const runs=joinTextRuns(sliceTextRuns(last.textRuns,0,kept),sliceTextRuns(clip.textRuns,lead,clip.text.length),offset,joined);
        const words=[...(last.captionWords||[]).filter(w=>w.to<=kept),...(clip.captionWords||[]).filter(w=>w.from>=lead).map(w=>({...w,from:w.from-lead+offset,to:w.to-lead+offset,start:w.start+shift,end:w.end+shift}))];
        let captionWords:CaptionWord[]|undefined=words.length?words:undefined;
        try{if(captionWords)assertCaptionWords(joined,captionWords,0,span);}catch{captionWords=undefined;}
        out[out.length-1]={...last,text:joined,name:joined.replace(/\n/g,' ').slice(0,36)||'자막',duration:span,textRuns:runs,captionWords,fadeOut:clip.fadeOut,sourceClipOffset:undefined,sourceClipDuration:undefined};
        removed.push(clip.id);continue;
      }
    }
    out.push(clip);
  }
  return {clips:out,removed};
}

/* ---- Whole-project operations (one undo step each) ---- */
const unlockedTexts=(p:Project)=>{const locked=new Set(p.tracks.filter(t=>t.locked).map(t=>t.id));return p.clips.filter(c=>c.text!==undefined&&!locked.has(c.trackId));};
/** The captions a 자막 정리 action works on: the selected ones, or every caption on unlocked tracks. */
export function captionTargets(p:Project,selected:readonly string[]):Clip[]{const texts=unlockedTexts(p),chosen=texts.filter(c=>selected.includes(c.id));return chosen.length?chosen:texts;}
/** Moves captions whose text is unchanged since the sync started onto the recognized words. A
 * caption that would land on another clip of its track keeps its place. */
export function applyCaptionSync(p:Project,texts:Readonly<Record<string,string>>,words:readonly SpeechWord[]):{project:Project;matched:number;total:number;blocked:number}{
  const targets=unlockedTexts(p).filter(c=>Object.hasOwn(texts,c.id)&&texts[c.id]===c.text),ids=new Set(targets.map(c=>c.id)),byTrack=new Map<string,Clip[]>();
  for(const c of targets)byTrack.set(c.trackId,[...(byTrack.get(c.trackId)||[]),c]);
  const updates=new Map<string,Clip>();let matched=0,blocked=0;
  for(const [trackId,clips] of byTrack){
    const report=syncCaptionTimes(clips,words,p.fps);matched+=report.matched;
    const others=p.clips.filter(o=>o.trackId===trackId&&!ids.has(o.id));
    for(const clip of clips){const r=report.updates.get(clip.id)!;
      if(others.some(o=>o.start<r.start+r.duration-1e-9&&o.start+o.duration>r.start+1e-9)){blocked++;continue;}
      if(Math.abs(r.start-clip.start)<1e-9&&Math.abs(r.duration-clip.duration)<1e-9&&JSON.stringify(r.captionWords)===JSON.stringify(clip.captionWords))continue;
      updates.set(clip.id,{...clip,start:r.start,duration:r.duration,captionWords:r.captionWords,keyframes:clip.keyframes.filter(k=>k.time<=r.duration+1e-9),sourceClipOffset:undefined,sourceClipDuration:undefined});
    }
  }
  return {project:updates.size?{...p,clips:p.clips.map(c=>updates.get(c.id)??c)}:p,matched,total:targets.length,blocked};
}
export function splitProjectCaptions(p:Project,ids:readonly string[],maxChars:number):{project:Project;before:number;after:number}{
  const wanted=new Set(ids),locked=new Set(p.tracks.filter(t=>t.locked).map(t=>t.id));let before=0,after=0;
  const clips=p.clips.flatMap(c=>{if(!wanted.has(c.id)||c.text===undefined||locked.has(c.trackId))return [c];const pieces=splitCaption(c,maxChars,p.fps);before++;after+=pieces.length;return pieces;});
  return {project:after>before?{...p,clips}:p,before,after};
}
export function mergeProjectCaptions(p:Project,ids:readonly string[],maxChars:number,options:{maxGap?:number;maxDuration?:number}={}):{project:Project;before:number;after:number}{
  const wanted=new Set(ids),locked=new Set(p.tracks.filter(t=>t.locked).map(t=>t.id)),removed=new Set<string>(),updated=new Map<string,Clip>();
  for(const track of p.tracks){if(locked.has(track.id))continue;const result=mergeCaptions(p.clips.filter(c=>c.trackId===track.id),{maxChars,maxGap:options.maxGap??.6,maxDuration:options.maxDuration??8,eligible:c=>wanted.has(c.id)});for(const id of result.removed)removed.add(id);for(const c of result.clips)updated.set(c.id,c);}
  const before=p.clips.filter(c=>wanted.has(c.id)&&c.text!==undefined).length;
  return {project:removed.size?{...p,clips:p.clips.filter(c=>!removed.has(c.id)).map(c=>updated.get(c.id)??c)}:p,before,after:before-removed.size};
}

/** The project's audible clips between start and end, moved to start at zero: the audio a caption
 * sync listens to. Visual-only and text clips, transitions and markers are left out. */
export function speechAudioProject(p:Project,start:number,end:number):Project{
  const tracks=new Map(p.tracks.map(t=>[t.id,t])),media=new Map(p.media.map(m=>[m.id,m]));
  const clips=p.clips.filter(c=>{const m=media.get(c.mediaId||'');return c.text===undefined&&!!m&&(m.kind==='audio'||!!m.hasAudio)&&c.volume>0&&audioTrackEnabled(p,tracks.get(c.trackId))&&c.start<end-1e-9&&c.start+c.duration>start+1e-9;})
    .map(c=>{const a=Math.max(start,c.start)-c.start,b=Math.min(end,c.start+c.duration)-c.start,t=a>1e-9||b<c.duration-1e-9?trimClip(c,a,b):c;return {...t,start:Math.max(0,t.start-start),motionBinding:undefined,keyframes:[]};});
  return {...p,tracks:p.tracks.map(t=>({...t,locked:false})),clips,transitions:[],markers:undefined};
}
