// Crop, Hann window and box decoding adapted from OpenCV's tracker_vit.cpp.
// Upstream author: Pengyu Liu. Apache-2.0; see resources/licenses/ViTTrack-*.
// SLU changes: bounded direct sampling (no potentially huge padded image),
// validation, reusable input buffers and explicit review/loss information.
export type TrackingBox = [x:number,y:number,width:number,height:number];
export interface TrackingFrame {width:number;height:number;data:Uint8Array}
export interface TrackingMaps {confidence:Float32Array;size:Float32Array;offset:Float32Array}
export interface TrackingObservation {box:TrackingBox;score:number;status:'tracked'|'review'|'lost'}
export interface TrackingInput {data:Float32Array;crop:number;x:number;y:number}
export const MAX_TRACKING_PIXELS=4096*4096;
const mean=[.485,.456,.406],std=[.229,.224,.225];
const hann=Float32Array.from({length:16},(_,i)=>.5*(1-Math.cos(Math.fround(2*Math.PI/17)*(i+1))));
const window=Float32Array.from({length:256},(_,i)=>hann[i%16]*hann[Math.floor(i/16)]);

export function assertTrackingFrame(frame:TrackingFrame):void {
  if(!frame||!Number.isInteger(frame.width)||!Number.isInteger(frame.height)||frame.width<1||frame.height<1||frame.width>16384||frame.height>16384||frame.width*frame.height>MAX_TRACKING_PIXELS||!(frame.data instanceof Uint8Array)||frame.data.byteLength!==frame.width*frame.height*3)throw new Error('추적 영상 프레임의 크기 또는 형식이 올바르지 않습니다.');
}
export function assertTrackingBox(box:TrackingBox,width:number,height:number):void {
  if(!Array.isArray(box)||box.length!==4||box.some(v=>!Number.isInteger(v))||box[0]<0||box[1]<0||box[2]<1||box[3]<1||box[0]+box[2]>width||box[1]+box[3]>height)throw new Error('추적 영역을 영상 안에 지정하세요.');
}

/** BGR24, matching the pinned OpenCV adapter (swapRB=false). Half-pixel linear
 * resize followed by 8-bit rounding; OpenCV's fixed-point resize can differ by
 * one input level. Zero padding is isolated from the original image. */
export function trackingInput(frame:TrackingFrame,box:TrackingBox,factor:2|4,size:128|256,data=new Float32Array(3*size*size)):TrackingInput {
  assertTrackingFrame(frame);assertTrackingBox(box,frame.width,frame.height);
  if((factor!==2&&factor!==4)||(size!==128&&size!==256)||data.length!==3*size*size)throw new Error('추적 모델 입력 크기가 올바르지 않습니다.');
  const [x,y,w,h]=box,crop=Math.ceil(Math.sqrt(w*h)*factor),x0=x+Math.trunc((w-crop)/2),y0=y+Math.trunc((h-crop)/2),ratio=crop/size,plane=size*size;
  const pixel=(xx:number,yy:number,c:number)=>xx<0||yy<0||xx>=frame.width||yy>=frame.height?0:frame.data[(yy*frame.width+xx)*3+c];
  for(let v=0;v<size;v++){
    const fy=Math.max(0,Math.min(crop-1,(v+.5)*ratio-.5)),iy=Math.floor(fy),dy=fy-iy;
    for(let u=0;u<size;u++){
      const fx=Math.max(0,Math.min(crop-1,(u+.5)*ratio-.5)),ix=Math.floor(fx),dx=fx-ix;
      for(let c=0;c<3;c++){
        const a=pixel(x0+ix,y0+iy,c),b=pixel(x0+Math.min(crop-1,ix+1),y0+iy,c),cc=pixel(x0+ix,y0+Math.min(crop-1,iy+1),c),d=pixel(x0+Math.min(crop-1,ix+1),y0+Math.min(crop-1,iy+1),c);
        const value=Math.round((a+(b-a)*dx)*(1-dy)+(cc+(d-cc)*dx)*dy);
        data[c*plane+v*size+u]=(value-mean[c]*255)/(std[c]*255);
      }
    }
  }
  return {data,crop,x:x0,y:y0};
}

export function trackingOutput(maps:TrackingMaps,input:Pick<TrackingInput,'crop'|'x'|'y'>,width:number,height:number,previous:TrackingBox):TrackingObservation {
  assertTrackingBox(previous,width,height);
  if(!Number.isFinite(input.crop)||input.crop<1||!Number.isFinite(input.x)||!Number.isFinite(input.y))throw new Error('추적 모델의 검색 영역이 올바르지 않습니다.');
  for(const [data,length] of [[maps.confidence,256],[maps.size,512],[maps.offset,512]] as const)if(!(data instanceof Float32Array)||data.length!==length||data.some(v=>!Number.isFinite(v)))throw new Error('추적 모델이 유효하지 않은 결과를 반환했습니다.');
  let index=0,score=-Infinity;
  for(let i=0;i<256;i++){const value=maps.confidence[i]*window[i];if(value>score){score=value;index=i;}}
  if(score<0||score>1.001)throw new Error('추적 모델의 신뢰도 값이 올바르지 않습니다.');
  if(score<.2)return {box:[...previous],score,status:'lost'};
  const cx=(index%16+maps.offset[index])/16,cy=(Math.floor(index/16)+maps.offset[index+256])/16;
  const w=Math.floor(maps.size[index]*input.crop),h=Math.floor(maps.size[index+256]*input.crop);
  if(w<1||h<1||Math.abs(cx)>16||Math.abs(cy)>16||w>input.crop*16||h>input.crop*16)return {box:[...previous],score,status:'lost'};
  const x=Math.floor((cx-maps.size[index]/2)*input.crop+input.x),y=Math.floor((cy-maps.size[index+256]/2)*input.crop+input.y),mx=Math.min(10,width),my=Math.min(10,height);
  const x1=Math.min(Math.max(0,x),width-mx),y1=Math.min(Math.max(0,y),height-my),x2=Math.min(Math.max(mx,x+w),width),y2=Math.min(Math.max(my,y+h),height);
  const box:TrackingBox=[x1,y1,Math.max(mx,x2-x1),Math.max(my,y2-y1)];
  const sizeChange=Math.max(box[2]/previous[2],previous[2]/box[2],box[3]/previous[3],previous[3]/box[3]);
  const move=Math.hypot(box[0]+box[2]/2-previous[0]-previous[2]/2,box[1]+box[3]/2-previous[1]-previous[3]/2);
  // These are review hints, NOT calibrated correctness probabilities. A model
  // can confidently track the wrong object; manual corrections remain needed.
  return {box,score,status:score<.5||sizeChange>1.5||move>Math.max(previous[2],previous[3])*.5?'review':'tracked'};
}
