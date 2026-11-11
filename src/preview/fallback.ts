import type {Clip,Project} from '../../shared/types';
import {clipState,EMPTY_CROP,fittedSize,hexRgb,maskAlpha,previewSize} from './math';
import {rasterCaption,textSignature,type TextFrame} from './text';
import type {Compositor,Geometry,HitRegion,VisualFrame,VisualRenderNode,TransitionVisualFrame} from './renderer';
import {layered,transitionHitRegions} from './renderer';
import {hasColorGrade,applyColorPixels} from '../../shared/color';

/** Low-resolution Canvas fallback retains effects. It is deliberately identified as CPU. */
export class CPUCompositor implements Compositor {
  readonly mode='CPU' as const;hitRegions:HitRegion[]=[];
  private context:CanvasRenderingContext2D;private pairInputs=[document.createElement('canvas'),document.createElement('canvas')];private pairOutput=document.createElement('canvas');private scratch=document.createElement('canvas');private filtered=document.createElement('canvas');private texts=new Map<string,TextFrame>();
  constructor(public canvas:HTMLCanvasElement){const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('미리보기 화면을 만들지 못했습니다.');this.context=context;}
  resize(project:Project,quality:number){const size=previewSize(project.width,project.height,Math.min(360,quality));if(size.width===this.canvas.width&&size.height===this.canvas.height)return;for(const canvas of [this.canvas,this.scratch,this.filtered,...this.pairInputs,this.pairOutput]){canvas.width=size.width;canvas.height=size.height;}this.texts.clear();}
  private layer(project:Project,time:number,{clip,frame}:VisualFrame,ctx:CanvasRenderingContext2D){const ratio=this.canvas.height/project.height;const state=clipState(clip,time),crop=clip.crop||EMPTY_CROP,fit=fittedSize(frame.width,frame.height,project,clip.fit,crop);if(state.opacity<.0001)return;const raw=this.scratch.getContext('2d',{willReadFrequently:true})!,filtered=this.filtered.getContext('2d',{willReadFrequently:true})!;raw.setTransform(1,0,0,1,0,0);raw.clearRect(0,0,this.scratch.width,this.scratch.height);raw.drawImage(frame.source as CanvasImageSource,crop.left*frame.width,crop.top*frame.height,(1-crop.left-crop.right)*frame.width,(1-crop.top-crop.bottom)*frame.height,(project.width-fit.width)*ratio/2,(project.height-fit.height)*ratio/2,fit.width*ratio,fit.height*ratio);
      if(clip.chromaKey?.enabled){const image=raw.getImageData(0,0,this.scratch.width,this.scratch.height),key=hexRgb(clip.chromaKey.color),data=image.data;for(let i=0;i<data.length;i+=4){const distance=Math.hypot(data[i]/255-key[0],data[i+1]/255-key[1],data[i+2]/255-key[2])/Math.sqrt(3);data[i+3]*=Math.max(0,Math.min(1,(distance-clip.chromaKey.similarity)/clip.chromaKey.smoothness));}raw.putImageData(image,0,0);}
      const presets={none:'',cinematic:'contrast(1.15) saturate(.8)',warm:'sepia(.18) saturate(1.15)',cool:'hue-rotate(12deg) saturate(.9)',mono:'saturate(0)',vivid:'saturate(1.4) contrast(1.1)'};
      filtered.clearRect(0,0,this.filtered.width,this.filtered.height);filtered.filter=`brightness(${1+clip.brightness}) contrast(${clip.contrast}) saturate(${clip.saturation}) blur(${clip.blur*ratio}px) ${presets[clip.preset]}`;filtered.drawImage(this.scratch,0,0);filtered.filter='none';
      if(hasColorGrade(clip.colorGrade)){const image=filtered.getImageData(0,0,this.filtered.width,this.filtered.height);applyColorPixels(image.data,clip.colorGrade!,project.colorLuts?.find(lut=>lut.id===clip.colorGrade?.lutId));filtered.putImageData(image,0,0);}
      if(clip.mask&&clip.mask.type!=='none'){const image=filtered.getImageData(0,0,this.filtered.width,this.filtered.height),data=image.data;for(let y=0;y<image.height;y++)for(let x=0;x<image.width;x++)data[(y*image.width+x)*4+3]*=maskAlpha(clip.mask,(x+.5)/image.width,(y+.5)/image.height,project.width,project.height);filtered.putImageData(image,0,0);}
      const geometry:Geometry={size:clip.fit==='cover'?[project.width,project.height]:[fit.width,fit.height],offset:[0,0],center:[project.width/2+state.x,project.height/2+state.y],scale:[state.scale*(clip.flipH?-1:1),state.scale*(clip.flipV?-1:1)],rotation:state.rotation*Math.PI/180,uv:fit.uv};this.hitRegions.push({clip,geometry});ctx.save();ctx.translate(geometry.center[0]*ratio,geometry.center[1]*ratio);ctx.rotate(geometry.rotation);ctx.scale(...geometry.scale);ctx.globalAlpha=state.opacity;ctx.drawImage(this.filtered,-this.canvas.width/2,-this.canvas.height/2);ctx.restore();
    
  }
  private pair(project:Project,time:number,node:TransitionVisualFrame){const width=this.canvas.width,height=this.canvas.height,regions:HitRegion[][]=[];
    for(const [index,frame]of [node.from,node.to].entries()){const ctx=this.pairInputs[index].getContext('2d')!;ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.clearRect(0,0,width,height);const start=this.hitRegions.length;if(frame)this.layer(project,time,frame,ctx);regions.push(this.hitRegions.splice(start));}
    this.hitRegions.push(...transitionHitRegions(project,node.transition,node.progress,regions[0],regions[1]));
    const ctx=this.pairOutput.getContext('2d')!,p=Math.max(0,Math.min(1,node.progress)),[a,b]=this.pairInputs;ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.clearRect(0,0,width,height);
    if(p<=0)ctx.drawImage(a,0,0);else if(p>=1)ctx.drawImage(b,0,0);
    else if(node.transition.kind==='wipe'){
      ctx.drawImage(a,0,0);ctx.save();ctx.beginPath();const direction=node.transition.direction||'left';
      const edge=(fraction:number,size:number)=>Math.max(0,Math.min(size,Math.ceil(fraction*size-.5)));
      if(direction==='left'){const x=edge(1-p,width);ctx.rect(x,0,width-x,height);}else if(direction==='right')ctx.rect(0,0,edge(p,width),height);else if(direction==='up'){const y=edge(1-p,height);ctx.rect(0,y,width,height-y);}else ctx.rect(0,0,width,edge(p,height));
      ctx.clip();ctx.clearRect(0,0,width,height);ctx.drawImage(b,0,0);ctx.restore();
    }else if(node.transition.kind==='slide'){
      const [dx,dy]={left:[-1,0],right:[1,0],up:[0,-1],down:[0,1]}[node.transition.direction||'left'];ctx.globalCompositeOperation='lighter';ctx.drawImage(a,p*dx*width,p*dy*height);ctx.drawImage(b,-(1-p)*dx*width,-(1-p)*dy*height);
    }else {
      ctx.globalCompositeOperation='lighter';const fromScale=node.transition.kind==='zoom'?1+.25*p:1,toScale=node.transition.kind==='zoom'?.75+.25*p:1;
      ctx.globalAlpha=1-p;ctx.drawImage(a,(1-fromScale)*width/2,(1-fromScale)*height/2,fromScale*width,fromScale*height);
      ctx.globalAlpha=p;ctx.drawImage(b,(1-toScale)*width/2,(1-toScale)*height/2,toScale*width,toScale*height);
    }
    ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';this.context.save();this.context.setTransform(1,0,0,1,0,0);this.context.globalAlpha=1;this.context.drawImage(this.pairOutput,0,0);this.context.restore();
  }
  draw(project:Project,time:number,visuals:VisualRenderNode[],texts:Clip[]){const ctx=this.context,ratio=this.canvas.height/project.height;ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.fillStyle=project.background;ctx.fillRect(0,0,this.canvas.width,this.canvas.height);this.hitRegions=[];
    const drawText=(clip:Clip)=>{let text=clip.captionStyle?undefined:this.texts.get(clip.id);const signature=textSignature(clip,project,ratio,time-clip.start);if(!text||text.signature!==signature){text=rasterCaption(clip,project,ratio,time-clip.start);if(!clip.captionStyle)this.texts.set(clip.id,text);}const state=clipState(clip,time),anchor=clip.align==='left'?project.width*.05:clip.align==='right'?project.width*.95:project.width/2,offset=(text.width/2-text.padding)*(clip.align==='left'?1:clip.align==='right'?-1:0);const geometry:Geometry={size:[text.width,text.height],offset:[offset,0],center:[anchor+state.x,project.height/2+state.y],scale:[state.scale,state.scale],rotation:state.rotation*Math.PI/180,uv:[0,0,1,1]};this.hitRegions.push({clip,geometry});ctx.save();ctx.translate(geometry.center[0]*ratio,geometry.center[1]*ratio);ctx.rotate(geometry.rotation);ctx.scale(state.scale,state.scale);ctx.globalAlpha=state.opacity;ctx.drawImage(text.canvas,(offset-text.width/2)*ratio,-text.height/2*ratio,text.width*ratio,text.height*ratio);ctx.restore();};
    for(const item of layered(project,visuals,texts)){if('text' in item)drawText(item.text);else if(item.visual.type==='transition')this.pair(project,time,item.visual);else this.layer(project,time,item.visual,this.context);}
  }
  release(keys:Set<string>){for(const key of this.texts.keys())if(!keys.has(`text:${key}`))this.texts.delete(key);}
  dispose(){this.texts.clear();this.canvas.width=0;this.scratch.width=0;this.filtered.width=0;for(const canvas of [...this.pairInputs,this.pairOutput])canvas.width=0;}
}
