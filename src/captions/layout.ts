import type {CaptionStyle,Clip,Project} from '../../shared/types';
import {captionGraphemes} from '../../shared/captions';
import {captionFontStack,CAPTION_FONT_HASH,CAPTION_DISPLAY_HASH,requireCaptionFonts} from './font';
import {assertCaptionGlyphs} from './glyphs';

export interface CaptionLine {text:string;from:number;to:number;width:number;x:number;baseline:number;top:number;height:number}
export interface WordRect {x:number;y:number;width:number;height:number}
export interface CaptionLayout {width:number;height:number;padding:number;lines:CaptionLine[];wordRects:WordRect[][];signature:string;font:string;letterSpacing:string;style:CaptionStyle;inkPad:number;lineHeight:number;textLength:number}
const layouts=new Map<string,CaptionLayout>();let cachedChars=0;
const MAX_LAYOUTS=96,MAX_CHARACTERS=200000;
let measureCanvas:HTMLCanvasElement|undefined;
export function captionLayoutSignature(clip:Clip,project:Project){return JSON.stringify([CAPTION_FONT_HASH,clip.captionStyle?.font==='gmarket-sans'?CAPTION_DISPLAY_HASH:undefined,clip.text,clip.fontSize,clip.align,clip.captionStyle,project.width,clip.captionWords?.map(w=>[w.from,w.to])]);}
function measureContext(font:string,spacing:string){measureCanvas??=document.createElement('canvas');const ctx=measureCanvas.getContext('2d')!;ctx.font=font;ctx.letterSpacing=spacing;ctx.fontKerning='normal';ctx.textAlign='left';ctx.textBaseline='alphabetic';return ctx;}
function wrap(text:string,maximum:number,ctx:CanvasRenderingContext2D):Array<{text:string;from:number;to:number;width:number}>{
  const result:Array<{text:string;from:number;to:number;width:number}>=[];
  const widthOf=(value:string)=>{const m=ctx.measureText(value);return Math.max(Math.abs(m.width),m.actualBoundingBoxLeft+m.actualBoundingBoxRight,0);};
  let paragraphFrom=0;
  for(const paragraph of text.split('\n')){
    const visible=paragraph.endsWith('\r')?paragraph.slice(0,-1):paragraph,segments=captionGraphemes(visible);
    if(!segments.length)result.push({text:'',from:paragraphFrom,to:paragraphFrom,width:0});
    let first=0;
    while(first<segments.length){
      let low=first+1,high=segments.length,best=first+1;
      if(parseFloat(ctx.letterSpacing)<0){for(let next=first+1;next<=segments.length;next++){if(widthOf(visible.slice(segments[first].from,segments[next-1].to))>maximum&&next>first+1)break;best=next;}}
      else while(low<=high){const mid=(low+high)>>>1,candidate=visible.slice(segments[first].from,segments[mid-1].to);if(widthOf(candidate)<=maximum){best=mid;low=mid+1;}else high=mid-1;}
      if(best<segments.length){for(let index=best-1;index>first;index--)if(/^\s+$/u.test(segments[index].text)){best=index+1;break;}}
      const from=segments[first].from,to=segments[best-1].to,line=visible.slice(from,to);
      result.push({text:line,from:paragraphFrom+from,to:paragraphFrom+to,width:widthOf(line)});first=best;
    }
    paragraphFrom+=paragraph.length+1;
  }
  return result;
}
/** Browser Range preserves complete-line shaping when locating highlight spans. */
function measureWordRects(clip:Clip,lines:CaptionLine[],font:string,spacing:string,lineHeight:number):WordRect[][]{
  const words=clip.captionWords||[],rects:WordRect[][]=words.map(()=>[]);if(!words.length)return rects;
  const host=document.createElement('div');host.style.cssText='position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:layout style paint;white-space:pre;direction:ltr;';host.style.font=font;host.style.letterSpacing=spacing;host.style.fontKerning='normal';host.style.lineHeight=`${lineHeight}px`;
  const elements=lines.map(line=>{const div=document.createElement('div');div.style.width='max-content';div.textContent=line.text||'\u200b';host.append(div);return div;});document.body.append(host);
  try{let firstWord=0;for(const [index,line]of lines.entries()){while(firstWord<words.length&&words[firstWord].to<=line.from)firstWord++;const div=elements[index],textNode=div.firstChild!;const bounds=div.getBoundingClientRect();
    for(let wi=firstWord;wi<words.length&&words[wi].from<line.to;wi++){const word=words[wi],from=Math.max(word.from,line.from)-line.from,to=Math.min(word.to,line.to)-line.from;if(to<=from)continue;const range=document.createRange();range.setStart(textNode,from);range.setEnd(textNode,to);for(const r of range.getClientRects())if(r.width>0)rects[wi].push({x:line.x+r.left-bounds.left,y:line.top,width:r.width,height:line.height});range.detach();}
  }}finally{host.remove();}return rects;
}
export function captionLayout(clip:Clip,project:Project):CaptionLayout{
  requireCaptionFonts();assertCaptionGlyphs(clip.text||'');const signature=captionLayoutSignature(clip,project),cached=layouts.get(signature);if(cached){layouts.delete(signature);layouts.set(signature,cached);return cached;}
  const style=clip.captionStyle!;if(!style)throw new Error('자막 스타일이 없습니다.');
  const font=`${style.weight} ${clip.fontSize}px ${captionFontStack(style.font)}`,letterSpacing=`${style.letterSpacing}px`,ctx=measureContext(font,letterSpacing),lineHeight=clip.fontSize*style.lineHeight;
  const effectPad=Math.max(style.outlineWidth,style.shadowBlur*3),raw=wrap(clip.text||'',Math.max(1,project.width*style.maxWidth-2*(style.paddingX+effectPad+2)),ctx);
  const metrics=[ctx.measureText('한글Ag'),...raw.map(line=>ctx.measureText(line.text))],ascent=Math.max(clip.fontSize*.8,...metrics.map(m=>m.actualBoundingBoxAscent)),descent=Math.max(clip.fontSize*.2,...metrics.map(m=>m.actualBoundingBoxDescent)),overhang=Math.max(0,...metrics.map(m=>Math.max(m.actualBoundingBoxLeft,m.actualBoundingBoxRight-Math.max(0,m.width))));
  const inkPad=Math.ceil(effectPad+Math.max(overhang,(ascent+descent-lineHeight)/2,0)+2),padding=inkPad+style.paddingX,contentWidth=Math.max(1,...raw.map(l=>l.width)),width=contentWidth+padding*2,height=Math.max(1,raw.length)*lineHeight+2*(inkPad+style.paddingY);
  const lines:CaptionLine[]=raw.map((line,index)=>({...line,x:padding+(clip.align==='center'?(contentWidth-line.width)/2:clip.align==='right'?contentWidth-line.width:0),top:inkPad+style.paddingY+index*lineHeight,height:lineHeight,baseline:inkPad+style.paddingY+index*lineHeight+(lineHeight+ascent-descent)/2}));
  const layout:CaptionLayout={width,height,padding,lines,wordRects:measureWordRects(clip,lines,font,letterSpacing,lineHeight),signature,font,letterSpacing,style,inkPad,lineHeight,textLength:(clip.text||'').length};
  layouts.set(signature,layout);cachedChars+=(clip.text||'').length;
  while(layouts.size>MAX_LAYOUTS||cachedChars>MAX_CHARACTERS){const [key,value]=layouts.entries().next().value!;layouts.delete(key);cachedChars-=value.textLength;}
  return layout;
}
export function captionLayoutCacheStats(){return {entries:layouts.size,characters:cachedChars};}
export function clearCaptionLayouts(){layouts.clear();cachedChars=0;}
