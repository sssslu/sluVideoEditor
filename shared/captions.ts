import type {CaptionAnimation,CaptionStyle,CaptionWord,Clip} from './types';
import {ease} from './effects';

export const MAX_CAPTION_WORDS=2048;
export const MAX_PROJECT_CAPTION_WORDS=200000;
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
export function captionGraphemes(text:string){return [...segmenter.segment(text)].map(item=>({text:item.segment,from:item.index,to:item.index+item.segment.length}));}
const finite=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const color=(value:unknown)=>typeof value==='string'&&/^#[\da-f]{6}$/i.test(value);
const object=(value:unknown)=>typeof value==='object'&&value!==null&&!Array.isArray(value);

/** Validate untrusted saved/IPC metadata before it enters the edit history. */
export function assertCaptionWords(text:string,words:unknown,start:number,end:number):asserts words is CaptionWord[]{
  if(!Array.isArray(words)||words.length>MAX_CAPTION_WORDS)throw new Error('자막 단어 정보가 유효하지 않습니다.');
  const boundaries=new Set([0,text.length,...captionGraphemes(text).map(g=>g.from)]);
  let lastIndex=0,lastEnd=start;
  for(const raw of words){const w=raw as CaptionWord;
    if(!object(w)||!Number.isInteger(w.from)||!Number.isInteger(w.to)||w.from<lastIndex||w.to<=w.from||w.to>text.length||!boundaries.has(w.from)||!boundaries.has(w.to)||!text.slice(w.from,w.to).trim()||!finite(w.start,start,end)||!finite(w.end,start,end)||w.end<=w.start||w.start<lastEnd-1e-9||!['measured','manual','estimated'].includes(w.timing))throw new Error('자막 단어의 글자 범위 또는 시간이 유효하지 않습니다.');
    lastIndex=w.to;lastEnd=w.end;
  }
}
/** Crop local intervals without changing the displayed sentence or text indices. */
export function trimCaptionWords(words:readonly CaptionWord[]|undefined,from:number,to:number):CaptionWord[]|undefined {
  if(words===undefined)return undefined;
  return words.flatMap(word=>{const start=Math.max(from,word.start),end=Math.min(to,word.end);return end>start?[{...word,start:start-from,end:end-from}]:[];});
}
/** Changing characters invalidates recognition alignment in the same undo operation. */
export function editCaptionText(clip:Clip,text:string):Clip {
  if(text===clip.text)return clip;
  return {...clip,text,name:text.replace(/\n/g,' ').slice(0,36)||'자막',captionWords:undefined};
}
/** Explicit opt-in uniform estimates; never run automatically for imported SRT. */
export function estimateCaptionWords(clip:Clip):CaptionWord[] {
  const text=clip.text??'',parts=[...new Intl.Segmenter('und',{granularity:'word'}).segment(text)].filter(s=>s.isWordLike);
  if(!parts.length)return [];
  if(parts.length>MAX_CAPTION_WORDS)throw new Error('한 자막에는 최대 2,048개 단어를 지정할 수 있습니다.');
  return parts.map((part,index)=>({from:part.index,to:part.index+part.segment.length,start:Math.min(clip.duration,clip.duration*index/parts.length),end:index===parts.length-1?clip.duration:Math.min(clip.duration,clip.duration*(index+1)/parts.length),timing:'estimated'}));
}
/** Half-open intervals: pauses show base color and one boundary activates only one word. */
export function activeCaptionWord(clip:Clip,localTime:number):number {
  if(!clip.captionStyle?.highlight)return -1;
  // Arithmetic such as .3-.2 must land on the same .1 boundary after a trim.
  // One nanosecond absorbs IEEE754 roundoff even near the 24-hour limit.
  const sample=localTime+1e-9,words=clip.captionWords||[];let lo=0,hi=words.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(words[mid].start<=sample)lo=mid+1;else hi=mid;}
  const index=lo-1,word=words[index];
  return word&&sample<word.end&&(word.timing!=='estimated'||clip.captionStyle.highlightEstimated)?index:-1;
}
export function assertCaptionStyle(value:unknown):asserts value is CaptionStyle {
  const s=value as CaptionStyle;
  if(!object(s)||!['noto-sans-kr','gmarket-sans'].includes(s.font)||(s.font==='gmarket-sans'&&![500,700].includes(s.weight))||![400,500,600,700,800].includes(s.weight)||!finite(s.lineHeight,.8,3)||!finite(s.letterSpacing,-5,40)||!finite(s.outlineWidth,0,30)||!color(s.outlineColor)||!finite(s.shadowBlur,0,60)||!color(s.shadowColor)||!['none','box','line'].includes(s.background)||!finite(s.paddingX,0,160)||!finite(s.paddingY,0,160)||!finite(s.radius,0,160)||!finite(s.maxWidth,.1,1)||typeof s.highlight!=='boolean'||!color(s.activeColor)||(s.highlightEstimated!==undefined&&typeof s.highlightEstimated!=='boolean'))throw new Error('잘못된 자막 스타일입니다.');
}
export function assertCaptionAnimation(value:unknown):asserts value is CaptionAnimation {
  const a=value as CaptionAnimation,kinds=['none','fade','pop','slide'];
  if(!object(a)||!kinds.includes(a.entry)||!kinds.includes(a.exit)||!finite(a.entrySeconds,0,86400)||!finite(a.exitSeconds,0,86400)||!['linear','ease-in','ease-out','ease-in-out','hold'].includes(a.easing))throw new Error('잘못된 자막 애니메이션입니다.');
}
export const defaultCaptionStyle=():CaptionStyle=>({font:'noto-sans-kr',weight:700,lineHeight:1.25,letterSpacing:0,outlineWidth:3,outlineColor:'#101219',shadowBlur:0,shadowColor:'#101219',background:'none',paddingX:14,paddingY:8,radius:10,maxWidth:.86,highlight:true,activeColor:'#f4d35e'});
export const defaultCaptionAnimation=():CaptionAnimation=>({entry:'fade',exit:'fade',entrySeconds:.18,exitSeconds:.14,easing:'ease-out'});
export function textCaptionStyle(kind:Clip['textStyle']):CaptionStyle {
  const style={...defaultCaptionStyle(),highlight:false,outlineWidth:0};
  if(kind==='bold'||kind==='title')Object.assign(style,{font:'gmarket-sans',weight:700,outlineWidth:kind==='bold'?3:1});
  if(kind==='minimal')Object.assign(style,{weight:500,shadowBlur:2});
  if(kind==='box')Object.assign(style,{background:'box'});
  if(kind==='neon')Object.assign(style,{outlineWidth:1,shadowBlur:8,shadowColor:'#76fbe0'});
  return style;
}
export function resizeCaptionStyle(style:CaptionStyle|undefined,factor:number):CaptionStyle|undefined {
  if(!style)return undefined;
  const bounded=(v:number,max:number,min=0)=>Math.max(min,Math.min(max,v*factor));
  return {...style,letterSpacing:bounded(style.letterSpacing,40,-5),outlineWidth:bounded(style.outlineWidth,30),shadowBlur:bounded(style.shadowBlur,60),paddingX:bounded(style.paddingX,160),paddingY:bounded(style.paddingY,160),radius:bounded(style.radius,160)};
}

/** Shared text animation clock. Rich effects preserve phase across trimming/splitting. */
export function captionAnimationState(clip:Clip,localTime:number){
  if(clip.text===undefined)return {opacity:1,scale:1,y:0};
  const time=localTime+(clip.sourceClipOffset??0),duration=clip.sourceClipDuration??clip.duration;
  const a=clip.captionAnimation;
  if(!a){const entry=Math.max(0,Math.min(1,time/.25)),exit=Math.max(0,Math.min(1,(duration-time)/.2));return {opacity:clip.animation!=='none'?Math.min(entry,exit):1,scale:clip.animation==='pop'?.8+.2*(1-(1-entry)**3):1,y:clip.animation==='slide'?(1-entry)*40:0};}
  const entry=a.entrySeconds?ease(time/a.entrySeconds,a.easing):1,exit=a.exitSeconds?ease((duration-time)/a.exitSeconds,a.easing):1;
  return {opacity:Math.min(a.entry==='none'?1:entry,a.exit==='none'?1:exit),scale:(a.entry==='pop'?.8+.2*entry:1)*(a.exit==='pop'?.8+.2*exit:1),y:(a.entry==='slide'?(1-entry)*40:0)+(a.exit==='slide'?-(1-exit)*40:0)};
}
