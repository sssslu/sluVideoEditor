import type {Clip,Project} from '../../shared/types';
import {activeCaptionWord} from '../../shared/captions';
import {captionLayout,captionLayoutSignature} from '../captions/layout';
import {clipState} from './math';
export {ensureCaptionFonts,captionFontsReady} from '../captions/font';
export interface TextFrame {canvas:HTMLCanvasElement;width:number;height:number;padding:number;signature:string;version?:number}
export function textSignature(clip:Clip,project:Project,ratio:number,localTime=0){return clip.captionStyle?JSON.stringify([captionLayoutSignature(clip,project),clip.color,clip.textBackground,ratio,activeCaptionWord(clip,localTime)]):JSON.stringify([clip.text,clip.fontFamily,clip.fontSize,clip.color,clip.textBackground,clip.textStyle,clip.align,project.width,ratio]);}
export function rasterText(clip:Clip,project:Project,ratio:number):TextFrame{
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d')!;
  const bold=clip.textStyle==='minimal'?'400':'700';
  context.font=`${bold} ${clip.fontSize}px "${clip.fontFamily}",sans-serif`;
  context.letterSpacing=clip.textStyle==='title'?'1.5px':'0px';
  const maximum=project.width*.9,lines:string[]=[];
  for(const paragraph of (clip.text||'').split(/\r?\n/)){
    if(!paragraph){lines.push('');continue;}
    let line='';
    for(const token of paragraph.split(/(\s+)/)){
      if(context.measureText(line+token).width<=maximum){line+=token;continue;}
      if(line.trim()){lines.push(line.trimEnd());line='';}
      for(const character of token){if(context.measureText(line+character).width>maximum&&line){lines.push(line);line='';}line+=character;}
    }
    lines.push(line.trimEnd());
  }
  const contentWidth=Math.max(1,...lines.map(line=>context.measureText(line).width)),lineHeight=clip.fontSize*1.2,padding=clip.textStyle==='neon'?22:clip.textStyle==='box'?12:8;
  const width=contentWidth+padding*2,height=Math.max(lineHeight,lines.length*lineHeight)+padding*2;
  const boundedRatio=Math.min(ratio,4096/width,4096/height);
  canvas.width=Math.max(2,Math.ceil(width*boundedRatio));canvas.height=Math.max(2,Math.ceil(height*boundedRatio));
  context.scale(boundedRatio,boundedRatio);context.font=`${bold} ${clip.fontSize}px "${clip.fontFamily}",sans-serif`;
  context.letterSpacing=clip.textStyle==='title'?'1.5px':'0px';context.textAlign=clip.align;context.textBaseline='middle';context.lineJoin='round';
  if(clip.textStyle==='box'){context.fillStyle=clip.textBackground;context.fillRect(0,0,width,height);}
  const x=clip.align==='left'?padding:clip.align==='right'?width-padding:width/2;
  lines.forEach((line,index)=>{const y=padding+lineHeight*(index+.5);
    if(clip.textStyle==='neon'){context.save();context.strokeStyle=clip.color;context.lineWidth=2*Math.min(3,clip.fontSize*.035);context.shadowBlur=clip.fontSize*.12*boundedRatio;context.shadowColor=clip.color;context.strokeText(line,x,y);context.restore();}
    else if(clip.textStyle==='bold'||clip.textStyle==='title'){context.strokeStyle='#080910';context.lineWidth=clip.textStyle==='bold'?5:2;context.strokeText(line,x,y);}
    context.fillStyle=clip.color;
    if(clip.textStyle==='minimal'||clip.textStyle==='bold'){context.shadowColor='#080910';context.shadowOffsetX=clip.textStyle==='bold'?2*boundedRatio:0;context.shadowOffsetY=2*boundedRatio;}
    context.fillText(line,x,y);context.shadowColor='transparent';
  });
  return {canvas,width,height,padding,signature:textSignature(clip,project,ratio)};
}

const richFrames=new Map<string,TextFrame>();let richBytes=0,frameVersion=0;
const MAX_FRAME_BYTES=48*1024*1024,MAX_FRAME_STATES=32,MAX_RASTER_PIXELS=4*1024*1024;
/** Full-line glyphs are shaped exactly once; highlighting recolors their alpha mask. */
export function rasterCaption(clip:Clip,project:Project,ratio:number,localTime=0):TextFrame{
  if(!clip.captionStyle)return rasterText(clip,project,ratio);
  const signature=textSignature(clip,project,ratio,localTime),cached=richFrames.get(signature);if(cached){richFrames.delete(signature);richFrames.set(signature,cached);return cached;}
  const layout=captionLayout(clip,project),{width,height,style}=layout;
  const boundedRatio=Math.max(.000001,Math.min(ratio,4096/width,4096/height,Math.sqrt(MAX_RASTER_PIXELS/(width*height))));
  const canvas=document.createElement('canvas');canvas.width=Math.max(2,Math.ceil(width*boundedRatio));canvas.height=Math.max(2,Math.ceil(height*boundedRatio));
  const context=canvas.getContext('2d')!,fill=document.createElement('canvas');fill.width=canvas.width;fill.height=canvas.height;const ink=fill.getContext('2d')!;
  for(const ctx of [context,ink]){ctx.scale(boundedRatio,boundedRatio);ctx.font=layout.font;ctx.fontKerning='normal';ctx.letterSpacing=layout.letterSpacing;ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.lineJoin='round';}
  context.fillStyle=clip.textBackground;
  const box=(x:number,y:number,w:number,h:number)=>{context.beginPath();context.roundRect(x,y,w,h,Math.min(style.radius,w/2,h/2));context.fill();};
  if(style.background==='box')box(layout.inkPad,layout.inkPad,width-layout.inkPad*2,height-layout.inkPad*2);
  if(style.background==='line')for(const line of layout.lines)if(line.text.trim())box(line.x-style.paddingX,line.top-style.paddingY,line.width+style.paddingX*2,line.height+style.paddingY*2);
  context.strokeStyle=style.outlineColor;context.lineWidth=style.outlineWidth*2;context.shadowColor=style.shadowColor;context.shadowBlur=style.shadowBlur*boundedRatio;
  const active=activeCaptionWord(clip,localTime),activeRects=active>=0?layout.wordRects[active]||[]:[];let highlight:HTMLCanvasElement|undefined;
  for(const line of layout.lines){
    if(style.outlineWidth)context.strokeText(line.text,line.x,line.baseline);else if(style.shadowBlur){context.fillStyle=clip.color;context.fillText(line.text,line.x,line.baseline);}
    const rects=activeRects.filter(rect=>rect.y===line.top);
    if(!rects.length){ink.fillStyle=clip.color;ink.fillText(line.text,line.x,line.baseline);continue;}
    // Isolate this complete line so a tall glyph/overlapping line never recolors
    // another line, and changing color never reshapes or doubles glyph alpha.
    highlight??=document.createElement('canvas');highlight.width=canvas.width;highlight.height=canvas.height;const tint=highlight.getContext('2d')!;
    tint.scale(boundedRatio,boundedRatio);tint.font=layout.font;tint.fontKerning='normal';tint.letterSpacing=layout.letterSpacing;tint.textBaseline='alphabetic';tint.fillStyle=clip.color;tint.fillText(line.text,line.x,line.baseline);
    tint.globalCompositeOperation='source-atop';tint.fillStyle=style.activeColor;for(const rect of rects)tint.fillRect(rect.x,0,rect.width,height);
    ink.save();ink.setTransform(1,0,0,1,0,0);ink.drawImage(highlight,0,0);ink.restore();
  }
  if(highlight){highlight.width=0;highlight.height=0;}
  context.setTransform(1,0,0,1,0,0);context.shadowColor='transparent';context.shadowBlur=0;context.drawImage(fill,0,0);fill.width=0;fill.height=0;
  const frame:TextFrame={canvas,width,height,padding:layout.padding,signature,version:++frameVersion};richFrames.set(signature,frame);richBytes+=canvas.width*canvas.height*4;
  while(richFrames.size>MAX_FRAME_STATES||richBytes>MAX_FRAME_BYTES){const [key,old]=richFrames.entries().next().value!;richFrames.delete(key);richBytes-=old.canvas.width*old.canvas.height*4;}
  return frame;
}
/** Caller owns output/project scaling; geometry and local animation time are shared. */
export function drawCaption(context:CanvasRenderingContext2D,clip:Clip,project:Project,localTime:number,ratio=1){
  const frame=rasterCaption(clip,project,ratio,localTime),state=clipState(clip,clip.start+localTime),anchor=clip.align==='left'?project.width*.05:clip.align==='right'?project.width*.95:project.width/2,offset=(frame.width/2-frame.padding)*(clip.align==='left'?1:clip.align==='right'?-1:0);
  context.save();context.translate(anchor+state.x,project.height/2+state.y);context.rotate(state.rotation*Math.PI/180);context.scale(state.scale,state.scale);context.globalAlpha*=state.opacity;context.drawImage(frame.canvas,offset-frame.width/2,-frame.height/2,frame.width,frame.height);context.restore();return frame;
}
export function captionRasterCacheStats(){return {entries:richFrames.size,bytes:richBytes};}
export function clearCaptionRasters(){richFrames.clear();richBytes=0;}
