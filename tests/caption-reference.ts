import {drawCaption} from '../src/preview/text';
import {ensureCaptionFonts} from '../src/captions/font';
import type {Project,ExportSettings,Clip} from '../shared/types';
await ensureCaptionFonts();
(window as unknown as {captionReference:(project:Project,settings:ExportSettings,clips:Clip[],frame:number)=>Uint8Array}).captionReference=(project,settings,clips,frame)=>{
  const canvas=document.createElement('canvas');canvas.width=settings.width;canvas.height=settings.height;
  const context=canvas.getContext('2d',{willReadFrequently:true})!;context.scale(settings.width/project.width,settings.height/project.height);
  for(const clip of clips)if(frame/settings.fps+1e-9>=clip.start&&frame/settings.fps+1e-9<clip.start+clip.duration)drawCaption(context,clip,project,frame/settings.fps-clip.start,Math.max(settings.width/project.width,settings.height/project.height));
  return new Uint8Array(context.getImageData(0,0,canvas.width,canvas.height).data.buffer);
};
