import type {Clip,ExportSettings,Project} from '../shared/types';
import {ensureCaptionFonts} from '../src/captions/font';
import {drawCaption,rasterCaption} from '../src/preview/text';
import type {CaptionRasterBounds,CaptionRasterRequest,CaptionRasterResponse} from './caption-raster-types';
import {clipState} from '../src/preview/math';
import {activeCaptionWord} from '../shared/captions';

let project:Project,settings:ExportSettings;
const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{willReadFrequently:true})!;
const groups=new Map<string,{clips:Clip[];bounds:CaptionRasterBounds}>();

/** Conservative union in output pixels. Rotation uses an enclosing radius;
 * ordinary horizontal captions retain a small lower-third rectangle. The
 * original project coordinate system and subpixel anchors remain unchanged. */
function boundsFor(clips:Clip[]):CaptionRasterBounds {
  const sx=settings.width/project.width,sy=settings.height/project.height,ratio=Math.max(sx,sy);
  let left=settings.width,top=settings.height,right=0,bottom=0;
  for(const clip of clips){
    const text=rasterCaption(clip,project,ratio,0),values=[clip,...clip.keyframes],scale=Math.max(...values.map(value=>value.scale));
    const anchor=clip.align==='left'?project.width*.05:clip.align==='right'?project.width*.95:project.width/2;
    const offset=(text.width/2-text.padding)*(clip.align==='left'?1:clip.align==='right'?-1:0);
    const minX=anchor+Math.min(...values.map(value=>value.x)),maxX=anchor+Math.max(...values.map(value=>value.x));
    const minY=project.height/2+Math.min(...values.map(value=>value.y))-40,maxY=project.height/2+Math.max(...values.map(value=>value.y))+40;
    let x0=(offset-text.width/2)*scale,x1=(offset+text.width/2)*scale,y0=-text.height/2*scale,y1=text.height/2*scale;
    if(values.some(value=>value.rotation!==0)){const radius=Math.hypot(Math.max(Math.abs(x0),Math.abs(x1)),Math.max(Math.abs(y0),Math.abs(y1)));x0=y0=-radius;x1=y1=radius;}
    left=Math.min(left,(minX+x0)*sx);right=Math.max(right,(maxX+x1)*sx);top=Math.min(top,(minY+y0)*sy);bottom=Math.max(bottom,(maxY+y1)*sy);
  }
  const x=Math.max(0,Math.min(settings.width-1,Math.floor(left)-2)),y=Math.max(0,Math.min(settings.height-1,Math.floor(top)-2));
  return {x,y,width:Math.max(1,Math.min(settings.width,Math.ceil(right)+2)-x),height:Math.max(1,Math.min(settings.height,Math.ceil(bottom)+2)-y)};
}
async function handle(message:CaptionRasterRequest):Promise<CaptionRasterResponse>{
  if(message.op==='init'){project=message.project;settings=message.settings;await ensureCaptionFonts();return {id:message.id};}
  if(message.op==='release'){groups.delete(message.group);return {id:message.id};}
  if(message.op==='prepare'){
    if(!project||message.clips.some(clip=>(!clip.captionStyle&&!clip.motionBinding)||clip.text===undefined))throw new Error('자막 렌더 요청이 올바르지 않습니다.');
    const bounds=boundsFor(message.clips);groups.set(message.group,{clips:message.clips,bounds});return {id:message.id,bounds};
  }
  const group=groups.get(message.group);if(!group||!Number.isInteger(message.globalFrame)||message.globalFrame<0)throw new Error('자막 프레임 요청이 올바르지 않습니다.');
  const {bounds}=group;
  const time=message.globalFrame/settings.fps,ratio=Math.max(settings.width/project.width,settings.height/project.height);
  const active=group.clips.filter(clip=>time+1e-9>=clip.start&&time+1e-9<clip.start+clip.duration);
  const signature=JSON.stringify(active.map(clip=>{const state=clipState(clip,time);return [clip.id,state.x,state.y,state.scale,state.opacity,state.rotation,activeCaptionWord(clip,time-clip.start)];}));
  if(message.reuse===signature)return {id:message.id,signature,reused:true};
  // Keep the same device-space origin as preview while drawing. Moving the
  // canvas origin to a crop can change a rotated Skia edge by one byte because
  // its raster matrices use float precision. Crop only the final readback.
  if(canvas.width!==settings.width||canvas.height!==settings.height){canvas.width=settings.width;canvas.height=settings.height;}
  context.setTransform(1,0,0,1,0,0);context.globalAlpha=1;context.globalCompositeOperation='source-over';context.clearRect(0,0,canvas.width,canvas.height);
  context.scale(settings.width/project.width,settings.height/project.height);
  for(const clip of active)drawCaption(context,clip,project,time-clip.start,ratio);
  const rgba=context.getImageData(bounds.x,bounds.y,bounds.width,bounds.height).data.buffer as ArrayBuffer;
  return {id:message.id,rgba,signature};
}
window.addEventListener('message',event=>{
  if(event.source!==window||event.data?.type!=='slu-caption:port'||event.ports.length!==1)return;
  const port=event.ports[0];
  port.onmessage=async event=>{
    const message=event.data as CaptionRasterRequest;
    // Electron MessagePortMain does not receive ArrayBuffer transfer-list
    // replies reliably. Clone one bounded frame and wait for the next request.
    try{const response=await handle(message);port.postMessage(response);}
    catch(error){port.postMessage({id:message.id,error:error instanceof Error?error.message:String(error)} satisfies CaptionRasterResponse);}
  };port.start();
},{once:true});
