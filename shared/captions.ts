import type {CaptionStyle,CaptionWord,Clip,Project} from './types';
import {remapTextRuns} from './text-runs';

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
/** Changing characters invalidates recognition alignment in the same undo operation;
 * per-character styles stay with their characters. */
export function editCaptionText(clip:Clip,text:string):Clip {
  if(text===clip.text)return clip;
  return {...clip,text,name:text.replace(/\n/g,' ').slice(0,36)||'자막',captionWords:undefined,textRuns:remapTextRuns(clip.text??'',text,clip.textRuns)};
}
/** Explicit opt-in uniform estimates; never run automatically for imported SRT. */
export function estimateCaptionWords(clip:Clip):CaptionWord[] {
  const text=clip.text??'',parts=[...new Intl.Segmenter('und',{granularity:'word'}).segment(text)].filter(s=>s.isWordLike);
  if(!parts.length)return [];
  if(parts.length>MAX_CAPTION_WORDS)throw new Error('한 자막에는 최대 2,048개 단어를 지정할 수 있습니다.');
  return parts.map((part,index)=>({from:part.index,to:part.index+part.segment.length,start:Math.min(clip.duration,clip.duration*index/parts.length),end:index===parts.length-1?clip.duration:Math.min(clip.duration,clip.duration*(index+1)/parts.length),timing:'estimated'}));
}
/** The word being spoken at a local time (-1 in pauses). Half-open intervals: one boundary belongs
 * to one word. Estimated (evenly placed) times count only when asked for. */
export function activeCaptionWord(clip:Clip,localTime:number,includeEstimated=false):number {
  // Arithmetic such as .3-.2 must land on the same .1 boundary after a trim.
  // One nanosecond absorbs IEEE754 roundoff even near the 24-hour limit.
  const sample=localTime+1e-9,words=clip.captionWords||[];let lo=0,hi=words.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(words[mid].start<=sample)lo=mid+1;else hi=mid;}
  const index=lo-1,word=words[index];
  return word&&sample<word.end&&(word.timing!=='estimated'||includeEstimated)?index:-1;
}
export const CAPTION_FONT_WEIGHTS:Record<CaptionStyle['font'],readonly CaptionStyle['weight'][]>={
  'noto-sans-kr':[400,500,600,700,800],
  'gmarket-sans':[500,700],
  reatic:[400,700],
};
export function assertCaptionStyle(value:unknown):asserts value is CaptionStyle {
  const s=value as CaptionStyle;
  if(!object(s)||!['noto-sans-kr','gmarket-sans','reatic'].includes(s.font)||!CAPTION_FONT_WEIGHTS[s.font].includes(s.weight)||!finite(s.lineHeight,.8,3)||!finite(s.letterSpacing,-5,40)||!finite(s.outlineWidth,0,30)||!color(s.outlineColor)||!finite(s.shadowBlur,0,60)||!color(s.shadowColor)||!['none','box','line'].includes(s.background)||!finite(s.paddingX,0,160)||!finite(s.paddingY,0,160)||!finite(s.radius,0,160)||!finite(s.maxWidth,.1,1)||typeof s.highlight!=='boolean'||!color(s.activeColor)||(s.highlightEstimated!==undefined&&typeof s.highlightEstimated!=='boolean')||(s.shadowDistance!==undefined&&!finite(s.shadowDistance,0,100))||(s.shadowAngle!==undefined&&!finite(s.shadowAngle,-360,360))||(s.shadowOpacity!==undefined&&!finite(s.shadowOpacity,0,1)))throw new Error('잘못된 자막 스타일입니다.');
}
export const defaultCaptionStyle=():CaptionStyle=>({font:'noto-sans-kr',weight:700,lineHeight:1.25,letterSpacing:0,outlineWidth:3,outlineColor:'#101219',shadowBlur:0,shadowColor:'#101219',background:'none',paddingX:14,paddingY:8,radius:10,maxWidth:.86,highlight:false,activeColor:'#f4d35e'});
export function textCaptionStyle(kind:Clip['textStyle']):CaptionStyle {
  const style={...defaultCaptionStyle(),highlight:false,outlineWidth:0};
  if(kind==='bold'||kind==='title')Object.assign(style,{font:'gmarket-sans',weight:700,outlineWidth:kind==='bold'?3:1});
  if(kind==='minimal')Object.assign(style,{weight:500,shadowBlur:2});
  if(kind==='box')Object.assign(style,{background:'box'});
  if(kind==='neon')Object.assign(style,{outlineWidth:1,shadowBlur:8,shadowColor:'#76fbe0'});
  return style;
}
/** The style an older plain text clip gets, close to how it used to be drawn. */
export function legacyTextCaptionStyle(clip:Clip):CaptionStyle {
  const style=textCaptionStyle(clip.textStyle);
  if(clip.textStyle==='minimal')Object.assign(style,{shadowBlur:0,shadowColor:'#080910',shadowDistance:2,shadowAngle:90,shadowOpacity:1});
  if(clip.textStyle==='bold')Object.assign(style,{shadowColor:'#080910',shadowDistance:3,shadowAngle:45,shadowOpacity:1});
  if(clip.textStyle==='title')style.letterSpacing=1.5;
  if(clip.textStyle==='neon')style.shadowColor=clip.color;
  return style;
}
/** Text and captions are one kind of clip: every text clip carries a caption style, so all of them
 * get the same controls and export path. Older files also hold an entry/exit animation
 * (`animation`, `captionAnimation`) on clips; it is dropped. */
export function unifiedText(clip:Clip):Clip {
  const legacy=clip as Clip&{animation?:unknown;captionAnimation?:unknown};
  if(!('animation' in legacy)&&!('captionAnimation' in legacy)&&(clip.text===undefined||clip.captionStyle))return clip;
  const next={...legacy};delete next.animation;delete next.captionAnimation;
  return clip.text===undefined?next:{...next,captionStyle:clip.captionStyle??legacyTextCaptionStyle(clip)};
}
/** `unifiedText` for a clip and, when it is a combined clip, for the clips kept inside it. */
function unifiedDeep(clip:Clip):Clip {
  const own=unifiedText(clip),inner=own.compound?.clips;if(!inner)return own;
  const clips=inner.map(unifiedDeep);return clips.every((c,i)=>c===inner[i])?own:{...own,compound:{...own.compound!,clips}};
}
export function unifyTextClips(project:Project):Project {
  const clips=project.clips.map(unifiedDeep);
  return clips.every((clip,i)=>clip===project.clips[i])?project:{...project,clips};
}
export function resizeCaptionStyle(style:CaptionStyle|undefined,factor:number):CaptionStyle|undefined {
  if(!style)return undefined;
  const bounded=(v:number,max:number,min=0)=>Math.max(min,Math.min(max,v*factor));
  return {...style,letterSpacing:bounded(style.letterSpacing,40,-5),outlineWidth:bounded(style.outlineWidth,30),shadowBlur:bounded(style.shadowBlur,60),...(style.shadowDistance!==undefined?{shadowDistance:bounded(style.shadowDistance,100)}:{}),paddingX:bounded(style.paddingX,160),paddingY:bounded(style.paddingY,160),radius:bounded(style.radius,160)};
}

/** Drop-shadow offset in px (zero when the style has none). */
export function captionShadowOffset(style:CaptionStyle){const d=style.shadowDistance??0,a=(style.shadowAngle??45)*Math.PI/180;return d>0?{x:Math.cos(a)*d,y:Math.sin(a)*d}:{x:0,y:0};}
/** How far a caption's ink can reach past its glyphs: outline, glow and drop shadow. */
export function captionEffectPad(style:CaptionStyle){const d=style.shadowDistance??0;return Math.max(style.outlineWidth,style.shadowBlur*3,d>0?style.outlineWidth+d+style.shadowBlur*1.5:0);}

