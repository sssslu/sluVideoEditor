import type {CaptionStyle,Clip,TextRun} from './types';

/** Per-character styling of one text clip ("부분 스타일"). Runs are sorted, never overlap, start and
 * end on grapheme boundaries, and only carry properties that differ from the clip's own style. */
export const MAX_TEXT_RUNS=2000;
export type RunStyle=Omit<TextRun,'from'|'to'>;
export interface ResolvedRunStyle {font:CaptionStyle['font'];weight:CaptionStyle['weight'];size:number;color:string}
const KEYS=['font','weight','size','color'] as const;
const FONTS=['noto-sans-kr','gmarket-sans','reatic'],WEIGHTS=[400,500,600,700,800];
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
function boundaries(text:string):Set<number>{const set=new Set([0,text.length]);for(const part of segmenter.segment(text))set.add(part.index);return set;}
const props=(run:RunStyle):RunStyle=>{const out:RunStyle={};for(const key of KEYS)if(run[key]!==undefined)(out as Record<string,unknown>)[key]=run[key];return out;};
const same=(a:RunStyle,b:RunStyle)=>KEYS.every(key=>a[key]===b[key]);
const empty=(run:RunStyle)=>KEYS.every(key=>run[key]===undefined);

/** Style index per UTF-16 unit (-1: the clip's own style). */
function indexArray(length:number,runs:readonly TextRun[]|undefined){const at=new Int32Array(length).fill(-1);(runs||[]).forEach((run,i)=>{for(let k=Math.max(0,run.from);k<Math.min(length,run.to);k++)at[k]=i;});return at;}
function fromIndexArray(at:Int32Array,styles:readonly RunStyle[],text:string):TextRun[]|undefined{
  const runs:TextRun[]=[];
  for(let k=0;k<at.length;){const i=at[k];let end=k+1;while(end<at.length&&at[end]===i)end++;if(i>=0&&!empty(styles[i]))runs.push({from:k,to:end,...props(styles[i])});k=end;}
  return normalizeTextRuns(text,runs);
}
/** Sorts, snaps to graphemes, drops empty runs and joins neighbours with the same style. */
export function normalizeTextRuns(text:string,runs:readonly TextRun[]|undefined):TextRun[]|undefined{
  if(!runs?.length||!text.length)return undefined;
  const edges=[...boundaries(text)].sort((a,b)=>a-b),floor=(v:number)=>{let r=0;for(const e of edges){if(e<=v)r=e;else break;}return r;},ceil=(v:number)=>edges.find(e=>e>=v)??text.length;
  const sorted=[...runs].map(run=>({from:floor(Math.max(0,Math.min(text.length,run.from))),to:ceil(Math.max(0,Math.min(text.length,run.to))),...props(run)})).filter(run=>run.to>run.from&&!empty(run)).sort((a,b)=>a.from-b.from);
  const out:TextRun[]=[];
  for(const run of sorted){const last=out.at(-1);const from=last?Math.max(run.from,last.to):run.from;if(run.to<=from)continue;
    if(last&&last.to===from&&same(last,run))last.to=run.to;else out.push({...run,from});}
  return out.length?out:undefined;
}
export function textRunAt(runs:readonly TextRun[]|undefined,index:number):RunStyle{const run=runs?.find(r=>r.from<=index&&index<r.to);return run?props(run):{};}
export function baseRunStyle(clip:Pick<Clip,'fontSize'|'color'|'captionStyle'>):ResolvedRunStyle{return {font:clip.captionStyle?.font??'noto-sans-kr',weight:clip.captionStyle?.weight??700,size:clip.fontSize,color:clip.color};}
export function resolveRunStyle(clip:Pick<Clip,'fontSize'|'color'|'captionStyle'>,run:RunStyle):ResolvedRunStyle{const base=baseRunStyle(clip);return {font:run.font??base.font,weight:run.weight??base.weight,size:run.size??base.size,color:run.color??base.color};}
/** Sets (a value) or clears (undefined) style properties for the characters in [from,to). */
export function setTextRunStyle(text:string,runs:readonly TextRun[]|undefined,from:number,to:number,patch:Partial<RunStyle>):TextRun[]|undefined{
  const start=Math.max(0,Math.min(text.length,from)),end=Math.max(start,Math.min(text.length,to));if(end<=start)return normalizeTextRuns(text,runs);
  const at=indexArray(text.length,runs),styles:RunStyle[]=(runs||[]).map(props),cache=new Map<number,number>();
  for(let k=start;k<end;k++){const i=at[k];let next=cache.get(i);if(next===undefined){const style={...(i>=0?styles[i]:{})} as Record<string,unknown>;for(const [key,value] of Object.entries(patch)){if(value===undefined)delete style[key];else style[key]=value;}next=styles.push(style as RunStyle)-1;cache.set(i,next);}at[k]=next;}
  return fromIndexArray(at,styles,text);
}
/** Drops the given properties from every run, e.g. when the whole text gets one color. */
export function clearTextRunProperties(text:string,runs:readonly TextRun[]|undefined,keys:readonly (keyof RunStyle)[]):TextRun[]|undefined{
  if(!runs?.length)return undefined;return normalizeTextRuns(text,runs.map(run=>{const next={...run} as Record<string,unknown>;for(const key of keys)delete next[key];return next as unknown as TextRun;}));
}
/** Keeps styles attached to their characters across an edit. Typed characters take the style of
 * the character before them (or after them at the very start). */
export function remapTextRuns(before:string,after:string,runs:readonly TextRun[]|undefined):TextRun[]|undefined{
  if(!runs?.length||!after.length)return undefined;if(before===after)return normalizeTextRuns(after,runs);
  let prefix=0;const max=Math.min(before.length,after.length);while(prefix<max&&before.charCodeAt(prefix)===after.charCodeAt(prefix))prefix++;
  let suffix=0;while(suffix<max-prefix&&before.charCodeAt(before.length-1-suffix)===after.charCodeAt(after.length-1-suffix))suffix++;
  const old=indexArray(before.length,runs),at=new Int32Array(after.length);
  at.set(old.subarray(0,prefix),0);at.set(old.subarray(before.length-suffix),after.length-suffix);
  const inherit=prefix>0?old[prefix-1]:before.length-suffix<before.length?old[before.length-suffix]:before.length?old[0]:-1;
  at.fill(inherit,prefix,after.length-suffix);
  return fromIndexArray(at,runs.map(props),after);
}
/** The runs of text.slice(from,to), re-based to start at zero. */
export function sliceTextRuns(runs:readonly TextRun[]|undefined,from:number,to:number,text?:string):TextRun[]|undefined{
  if(!runs?.length)return undefined;
  const sliced=runs.flatMap(run=>{const a=Math.max(from,run.from),b=Math.min(to,run.to);return b>a?[{...run,from:a-from,to:b-from}]:[];});
  return text===undefined?(sliced.length?sliced:undefined):normalizeTextRuns(text,sliced);
}
/** Runs of a + separator + b, where b's runs are shifted past a and the separator. */
export function joinTextRuns(a:readonly TextRun[]|undefined,b:readonly TextRun[]|undefined,offset:number,text:string):TextRun[]|undefined{
  return normalizeTextRuns(text,[...(a||[]),...(b||[]).map(run=>({...run,from:run.from+offset,to:run.to+offset}))]);
}
export function textRunFonts(clip:Pick<Clip,'captionStyle'|'textRuns'>):Array<{font:CaptionStyle['font'];weight:CaptionStyle['weight']}>{
  const base=clip.captionStyle;if(!base)return [];const seen=new Map<string,{font:CaptionStyle['font'];weight:CaptionStyle['weight']}>();
  for(const run of [{},...(clip.textRuns||[])] as RunStyle[]){const font=run.font??base.font,weight=run.weight??base.weight;seen.set(font+':'+weight,{font,weight});}
  return [...seen.values()];
}
const object=(value:unknown)=>typeof value==='object'&&value!==null&&!Array.isArray(value);
export function assertTextRuns(text:string,runs:unknown):asserts runs is TextRun[]{
  if(!Array.isArray(runs)||!runs.length||runs.length>MAX_TEXT_RUNS)throw new Error('부분 글자 스타일 정보가 올바르지 않습니다.');
  const edges=boundaries(text);let last=0;
  for(const raw of runs){const run=raw as TextRun;
    if(!object(run)||!Number.isInteger(run.from)||!Number.isInteger(run.to)||run.from<last||run.to<=run.from||run.to>text.length||!edges.has(run.from)||!edges.has(run.to)||empty(run)
      ||(run.font!==undefined&&!FONTS.includes(run.font))||(run.weight!==undefined&&!WEIGHTS.includes(run.weight))||(run.size!==undefined&&!(typeof run.size==='number'&&Number.isFinite(run.size)&&run.size>=4&&run.size<=1000))||(run.color!==undefined&&!(typeof run.color==='string'&&/^#[\da-f]{6}$/i.test(run.color))))
      throw new Error('부분 글자 스타일의 범위나 값이 올바르지 않습니다.');
    last=run.to;}
}
