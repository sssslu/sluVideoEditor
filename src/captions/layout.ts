import type {CaptionStyle,Clip,Project} from '../../shared/types';
import {captionGraphemes} from '../../shared/captions';
import {resolveRunStyle,textRunAt} from '../../shared/text-runs';
import {captionFontStack,CAPTION_FONT_HASH,CAPTION_DISPLAY_HASH,requireCaptionFonts} from './font';
import {assertCaptionGlyphs} from './glyphs';

/** One stretch of a line in a single font, size and color ("부분 스타일"). `color` is only set when
 * the run overrides the clip's color, so a cached layout stays valid when the clip color changes. */
export interface CaptionPiece {text:string;from:number;to:number;x:number;width:number;font:string;color?:string}
export interface CaptionLine {text:string;from:number;to:number;width:number;x:number;baseline:number;top:number;height:number;pieces?:CaptionPiece[]}
export interface CaptionLayout {width:number;height:number;padding:number;lines:CaptionLine[];signature:string;font:string;letterSpacing:string;style:CaptionStyle;inkPad:number;lineHeight:number;textLength:number}
const layouts=new Map<string,CaptionLayout>();let cachedChars=0;
const MAX_LAYOUTS=96,MAX_CHARACTERS=200000;
let measureCanvas:HTMLCanvasElement|undefined;
export function captionLayoutSignature(clip:Clip,project:Project){return JSON.stringify([CAPTION_FONT_HASH,clip.captionStyle?.font==='gmarket-sans'||clip.textRuns?.some(r=>r.font==='gmarket-sans')?CAPTION_DISPLAY_HASH:undefined,clip.text,clip.fontSize,clip.align,clip.captionStyle,project.width,clip.textRuns?.length?clip.textRuns:undefined]);}
function measureContext(font:string,spacing:string){measureCanvas??=document.createElement('canvas');const ctx=measureCanvas.getContext('2d')!;ctx.font=font;ctx.letterSpacing=spacing;ctx.fontKerning='normal';ctx.textAlign='left';ctx.textBaseline='alphabetic';return ctx;}
/** Greedy line breaking on grapheme boundaries, preferring the last space that fits.
 * `widthOf` measures text[from,to) in absolute offsets. */
function wrapText(text:string,maximum:number,negativeSpacing:boolean,widthOf:(from:number,to:number)=>number):Array<{text:string;from:number;to:number;width:number}>{
  const result:Array<{text:string;from:number;to:number;width:number}>=[];
  let paragraphFrom=0;
  for(const paragraph of text.split('\n')){
    const visible=paragraph.endsWith('\r')?paragraph.slice(0,-1):paragraph,segments=captionGraphemes(visible),base=paragraphFrom;
    if(!segments.length)result.push({text:'',from:paragraphFrom,to:paragraphFrom,width:0});
    let first=0;
    while(first<segments.length){
      let low=first+1,high=segments.length,best=first+1;
      if(negativeSpacing){for(let next=first+1;next<=segments.length;next++){if(widthOf(base+segments[first].from,base+segments[next-1].to)>maximum&&next>first+1)break;best=next;}}
      else while(low<=high){const mid=(low+high)>>>1;if(widthOf(base+segments[first].from,base+segments[mid-1].to)<=maximum){best=mid;low=mid+1;}else high=mid-1;}
      if(best<segments.length){for(let index=best-1;index>first;index--)if(/^\s+$/u.test(segments[index].text)){best=index+1;break;}}
      const from=segments[first].from,to=segments[best-1].to;
      result.push({text:visible.slice(from,to),from:base+from,to:base+to,width:widthOf(base+from,base+to)});first=best;
    }
    paragraphFrom+=paragraph.length+1;
  }
  return result;
}
export function captionLayout(clip:Clip,project:Project):CaptionLayout{
  const style=clip.captionStyle!;if(!style)throw new Error('자막 스타일이 없습니다.');
  requireCaptionFonts(style.font,style.weight);assertCaptionGlyphs(clip.text||'');
  if(clip.textRuns?.length)for(const run of clip.textRuns)if(run.font||run.weight)requireCaptionFonts(run.font??style.font,run.weight??style.weight);
  const signature=captionLayoutSignature(clip,project),cached=layouts.get(signature);if(cached){layouts.delete(signature);layouts.set(signature,cached);return cached;}
  // Runs that only change color keep the plain geometry exactly; other runs need mixed-size lines.
  const runs=clip.textRuns||[],sameFont=runs.every(r=>(r.font??style.font)===style.font&&(r.weight??style.weight)===style.weight&&(r.size??clip.fontSize)===clip.fontSize);
  const layout=!runs.length?plainLayout(clip,project,style,signature):sameFont?colorLayout(clip,plainLayout(clip,project,style,signature)):richLayout(clip,project,style,signature);
  layouts.set(signature,layout);cachedChars+=layout.textLength;
  while(layouts.size>MAX_LAYOUTS||cachedChars>MAX_CHARACTERS){const [key,value]=layouts.entries().next().value!;layouts.delete(key);cachedChars-=value.textLength;}
  return layout;
}
function plainLayout(clip:Clip,project:Project,style:CaptionStyle,signature:string):CaptionLayout{
  const text=clip.text||'',font=`${style.weight} ${clip.fontSize}px ${captionFontStack(style.font)}`,letterSpacing=`${style.letterSpacing}px`,ctx=measureContext(font,letterSpacing),lineHeight=clip.fontSize*style.lineHeight;
  const widthOf=(from:number,to:number)=>{const m=ctx.measureText(text.slice(from,to));return Math.max(Math.abs(m.width),m.actualBoundingBoxLeft+m.actualBoundingBoxRight,0);};
  const effectPad=Math.max(style.outlineWidth,style.shadowBlur*3),raw=wrapText(text,Math.max(1,project.width*style.maxWidth-2*(style.paddingX+effectPad+2)),style.letterSpacing<0,widthOf);
  const metrics=[ctx.measureText('한글Ag'),...raw.map(line=>ctx.measureText(line.text))],ascent=Math.max(clip.fontSize*.8,...metrics.map(m=>m.actualBoundingBoxAscent)),descent=Math.max(clip.fontSize*.2,...metrics.map(m=>m.actualBoundingBoxDescent)),overhang=Math.max(0,...metrics.map(m=>Math.max(m.actualBoundingBoxLeft,m.actualBoundingBoxRight-Math.max(0,m.width))));
  const inkPad=Math.ceil(effectPad+Math.max(overhang,(ascent+descent-lineHeight)/2,0)+2),padding=inkPad+style.paddingX,contentWidth=Math.max(1,...raw.map(l=>l.width)),width=contentWidth+padding*2,height=Math.max(1,raw.length)*lineHeight+2*(inkPad+style.paddingY);
  const lines:CaptionLine[]=raw.map((line,index)=>({...line,x:padding+(clip.align==='center'?(contentWidth-line.width)/2:clip.align==='right'?contentWidth-line.width:0),top:inkPad+style.paddingY+index*lineHeight,height:lineHeight,baseline:inkPad+style.paddingY+index*lineHeight+(lineHeight+ascent-descent)/2}));
  return {width,height,padding,lines,signature,font,letterSpacing,style,inkPad,lineHeight,textLength:text.length};
}
/** The plain layout with each line cut into pieces where the color changes. */
function colorLayout(clip:Clip,layout:CaptionLayout):CaptionLayout{
  const text=clip.text||'',ctx=measureContext(layout.font,layout.letterSpacing),runs=clip.textRuns||[];
  const lines=layout.lines.map(line=>{
    const cuts=[...new Set([line.from,line.to,...runs.flatMap(r=>[r.from,r.to]).filter(v=>v>line.from&&v<line.to)])].sort((a,b)=>a-b);
    const pieces:CaptionPiece[]=cuts.slice(0,-1).map((from,i)=>{const to=cuts[i+1],run=textRunAt(runs,from),x=line.x+(from>line.from?ctx.measureText(text.slice(line.from,from)).width:0);return {text:text.slice(from,to),from,to,x,width:ctx.measureText(text.slice(from,to)).width,font:layout.font,...(run.color?{color:run.color}:{})};});
    return {...line,pieces};
  });
  return {...layout,lines};
}
/** Mixed fonts, sizes and colors: each line is a row of pieces sharing one baseline, and each line
 * is as tall as its largest text. */
function richLayout(clip:Clip,project:Project,style:CaptionStyle,signature:string):CaptionLayout{
  const text=clip.text||'',letterSpacing=`${style.letterSpacing}px`,baseFont=`${style.weight} ${clip.fontSize}px ${captionFontStack(style.font)}`,ctx=measureContext(baseFont,letterSpacing);
  // Style spans covering the whole text: runs, and the clip's own style between them.
  const cuts=[...new Set([0,text.length,...clip.textRuns!.flatMap(r=>[r.from,r.to])])].filter(v=>v>=0&&v<=text.length).sort((a,b)=>a-b);
  const spans=cuts.slice(0,-1).map((from,i)=>{const run=textRunAt(clip.textRuns,from),resolved=resolveRunStyle(clip,run);return {from,to:cuts[i+1],size:resolved.size,font:`${resolved.weight} ${resolved.size}px ${captionFontStack(resolved.font)}`,color:run.color};}).filter(s=>s.to>s.from);
  const measure=(font:string,value:string)=>{if(ctx.font!==font)ctx.font=font;return ctx.measureText(value);};
  const advance=(m:TextMetrics)=>Math.max(Math.abs(m.width),0);
  const piecesOf=(from:number,to:number)=>spans.flatMap(span=>{const a=Math.max(from,span.from),b=Math.min(to,span.to);return b>a?[{span,from:a,to:b,text:text.slice(a,b)}]:[];});
  const widthOf=(from:number,to:number)=>{const parts=piecesOf(from,to);let total=0;parts.forEach((part,i)=>{const m=measure(part.span.font,part.text);total+=i===parts.length-1?Math.max(advance(m),m.actualBoundingBoxLeft+m.actualBoundingBoxRight):advance(m);});return total;};
  const maxSize=Math.max(clip.fontSize,...spans.map(s=>s.size)),effectPad=Math.max(style.outlineWidth,style.shadowBlur*3);
  const raw=wrapText(text,Math.max(1,project.width*style.maxWidth-2*(style.paddingX+effectPad+2)),style.letterSpacing<0,widthOf);
  let overhang=0,extra=0;
  const rows=raw.map(line=>{
    const parts=piecesOf(line.from,line.to),sizes=parts.length?parts.map(p=>p.span.size):[spans.find(s=>s.from<=line.from&&line.from<=s.to)?.size??clip.fontSize];
    let ascent=0,descent=0,x=0;
    const pieces:CaptionPiece[]=parts.map(part=>{const m=measure(part.span.font,part.text),probe=measure(part.span.font,'한글Ag');ascent=Math.max(ascent,part.span.size*.8,probe.actualBoundingBoxAscent,m.actualBoundingBoxAscent);descent=Math.max(descent,part.span.size*.2,probe.actualBoundingBoxDescent,m.actualBoundingBoxDescent);overhang=Math.max(overhang,m.actualBoundingBoxLeft,m.actualBoundingBoxRight-Math.max(0,m.width));const piece={text:part.text,from:part.from,to:part.to,x,width:advance(m),font:part.span.font,...(part.span.color?{color:part.span.color}:{})};x+=piece.width;return piece;});
    const size=Math.max(...sizes);if(!parts.length){ascent=size*.8;descent=size*.2;}
    const height=size*style.lineHeight;extra=Math.max(extra,(ascent+descent-height)/2);
    return {line,pieces,ascent,descent,height};
  });
  const inkPad=Math.ceil(effectPad+Math.max(overhang,extra,0)+2),padding=inkPad+style.paddingX,contentWidth=Math.max(1,...raw.map(l=>l.width));
  let top=inkPad+style.paddingY;
  const lines:CaptionLine[]=rows.map(row=>{const x=padding+(clip.align==='center'?(contentWidth-row.line.width)/2:clip.align==='right'?contentWidth-row.line.width:0),line:CaptionLine={...row.line,x,top,height:row.height,baseline:top+(row.height+row.ascent-row.descent)/2,pieces:row.pieces.map(p=>({...p,x:x+p.x}))};top+=row.height;return line;});
  const width=contentWidth+padding*2,height=Math.max(top-(inkPad+style.paddingY),maxSize*style.lineHeight*(lines.length?0:1))+2*(inkPad+style.paddingY);
  return {width,height,padding,lines,signature,font:baseFont,letterSpacing,style,inkPad,lineHeight:clip.fontSize*style.lineHeight,textLength:text.length};
}
export function captionLayoutCacheStats(){return {entries:layouts.size,characters:cachedChars};}
export function clearCaptionLayouts(){layouts.clear();cachedChars=0;}
