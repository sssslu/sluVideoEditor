import type {Clip} from './types';
/** Coordinates in the displayed source image, before timeline crop/transform. */
export interface MotionBox {x:number;y:number;width:number;height:number}
export interface TrackingAnchor {time:number;box:MotionBox}
export interface TrackingOptions {start:number;duration:number;anchors:TrackingAnchor[];maxDimension?:number;device?:'auto'|'cpu'|'gpu'}
export interface MotionSample {time:number;box:MotionBox;score:number;status:'tracked'|'review'|'lost';anchor:boolean}
export interface TrackingStill {time:number;previousTime?:number;nextTime?:number;width:number;height:number;sourceWidth:number;sourceHeight:number;bgr:Uint8Array;sourceRevision:string;videoStart:number;videoEnd:number}
export interface MotionAnalysis {
  version:1;id:string;mediaId:string;sourceRevision:string;path:string;
  sourceWidth:number;sourceHeight:number;analysisWidth:number;analysisHeight:number;
  start:number;end:number;firstFrameTime:number;frames:number;anchors:TrackingAnchor[];
  backend:'cpu'|'dml'|'mixed';
}
/** A non-recursive source snapshot keeps the motion when its source clip is
 * removed. While sourceClipId exists, edits to that clip are followed live. */
export type MotionSource=Pick<Clip,'start'|'duration'|'in'|'speed'|'speedCurve'|'x'|'y'|'scale'|'rotation'|'keyframes'|'fit'|'flipH'|'flipV'|'crop'>&{mediaId:string};
export interface MotionSourceLink {sourceClipId?:string;source:MotionSource}
export interface MotionBinding extends MotionSourceLink {
  analysisId:string;
  /** Additional pieces produced by source splits; the primary link is first.
   * All pieces share one immutable analysis and one attachment reference. */
  segments?:MotionSourceLink[];
  reference:{x:number;y:number;size:number;fit:'contain'|'cover';width:number;height:number};followScale:boolean;
}
export const MOTION_RECORD_BYTES=32;
export function validMotionBox(value:unknown):value is MotionBox {
  if(!value||typeof value!=='object')return false;const b=value as MotionBox;
  return [b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.x>=0&&b.y>=0&&b.width>0&&b.height>0&&b.x+b.width<=1.000001&&b.y+b.height<=1.000001;
}
export function assertMotionAnalysis(value:unknown,{allowAnyExtension=false}:{allowAnyExtension?:boolean}={}):asserts value is MotionAnalysis {
  const m=value as MotionAnalysis,id=(v:unknown,max=128)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!v.includes('\0');
  if(!m||typeof m!=='object'||m.version!==1||!id(m.id)||!id(m.mediaId)||!id(m.path,8192)||(!allowAnyExtension&&!m.path.toLowerCase().endsWith('.slutrack'))||typeof m.sourceRevision!=='string'||!/^[a-f0-9]{64}$/.test(m.sourceRevision)||!Number.isInteger(m.frames)||m.frames<1||m.frames>20_000_000||![m.start,m.end,m.firstFrameTime].every(Number.isFinite)||m.start<0||m.end<=m.start||m.end>864000||m.firstFrameTime<0||m.firstFrameTime>m.start+1e-6||![m.sourceWidth,m.sourceHeight].every(v=>Number.isInteger(v)&&v>0&&v<=32768)||![m.analysisWidth,m.analysisHeight].every(v=>Number.isInteger(v)&&v>0&&v<=4096)||!Array.isArray(m.anchors)||m.anchors.length<1||m.anchors.length>64||m.anchors.some((a,i)=>!a||!Number.isFinite(a.time)||a.time<m.start||a.time>=m.end||!validMotionBox(a.box)||(i>0&&a.time<=m.anchors[i-1].time))||!['cpu','dml','mixed'].includes(m.backend))throw new Error('추적 경로 정보가 올바르지 않습니다.');
}
export function writeMotionSample(view:DataView,offset:number,sample:MotionSample){
  if(!Number.isFinite(sample.time)||sample.time<0||!validMotionBox(sample.box)||!Number.isFinite(sample.score)||sample.score<0||sample.score>1.001||!['tracked','review','lost'].includes(sample.status))throw new Error('추적 경로 데이터가 올바르지 않습니다.');
  view.setFloat64(offset,sample.time,true);let at=offset+8;for(const value of [sample.box.x,sample.box.y,sample.box.width,sample.box.height,sample.score]){view.setFloat32(at,value,true);at+=4;}
  view.setUint32(offset+28,(['tracked','review','lost'].indexOf(sample.status))|(sample.anchor?4:0),true);
}
export function readMotionSample(view:DataView,offset:number):MotionSample {
  const flags=view.getUint32(offset+28,true),sample:MotionSample={time:view.getFloat64(offset,true),box:{x:view.getFloat32(offset+8,true),y:view.getFloat32(offset+12,true),width:view.getFloat32(offset+16,true),height:view.getFloat32(offset+20,true)},score:view.getFloat32(offset+24,true),status:(['tracked','review','lost'] as const)[flags&3],anchor:!!(flags&4)};
  if(flags>7||!sample.status||!Number.isFinite(sample.time)||sample.time<0||!validMotionBox(sample.box)||!Number.isFinite(sample.score)||sample.score<0||sample.score>1.001)throw new Error('추적 경로 파일이 손상되었습니다.');
  return sample;
}
