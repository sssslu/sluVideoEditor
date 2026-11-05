import type {MediaAsset} from '../shared/types';
import type {TrackingStill} from '../shared/tracking';
import {CancelledError,runProcess,type EngineContext} from './media';
import {requireSourceRevision} from './source-revision';
import {localFilePath} from './file-policy';
import {mediaTimingFromProbe} from './media-timing';
import {probeVideoRange} from './video-range';
import {presentedFrameTimes} from './video-frame';
import {freezeColorFilter} from './freeze-frame';
import {videoDecoderArgs,videoHasAlpha} from './video-input';
import type {VideoColorInfo} from './video-color';
import {decodeTrackingFrames,type TrackingDecodePlan} from './tracking-decode';

interface Stream extends VideoColorInfo {index:number;codec_type:string;disposition?:{attached_pic?:number}}
/** Metadata and native decode plan shared by tracking and selected cutouts. */
export async function prepareTrackingInput(media:MediaAsset,maxDimension:number,ctx:EngineContext,signal?:AbortSignal){
  if(signal?.aborted)throw new CancelledError();
  if(media.kind!=='video'||!localFilePath(media.path))throw new Error('객체 추적에는 로컬 영상 클립이 필요합니다.');
  if(!Number.isInteger(maxDimension)||maxDimension<64||maxDimension>4096)throw new Error('추적 분석 해상도가 올바르지 않습니다.');
  const revision=await requireSourceRevision(media.path,media.sourceRevision);
  const info=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',media.path],{signal,timeoutMs:60000})).stdout.toString()),video=info.streams?.find((s:Stream)=>s.codec_type==='video'&&!s.disposition?.attached_pic) as Stream|undefined;
  if(!video||video.width<1||video.height<1||video.width>16384||video.height>16384||video.width*video.height>64_000_000)throw new Error('원본 영상의 크기가 객체 추적 지원 범위를 벗어났습니다.');
  const clock=mediaTimingFromProbe(info);
  let filter:string;try{filter=freezeColorFilter(video);}catch(error){throw new Error((error instanceof Error?error.message:String(error)).replaceAll('정지 프레임','객체 추적'));}
  if(videoHasAlpha(video))filter+=',format=gbrap,premultiply=inplace=1,format=rgba';
  const plan:TrackingDecodePlan={file:media.path,stream:video.index,origin:clock.timing.origin,filter,decoder:videoDecoderArgs(video),maxDimension};
  await requireSourceRevision(media.path,revision);if(signal?.aborted)throw new CancelledError();return {plan,probe:info,revision,hasAlpha:videoHasAlpha(video)};
}
/** Tracking/still callers continue to receive the full measured video range. */
export async function prepareTrackingSource(media:MediaAsset,maxDimension:number,ctx:EngineContext,signal?:AbortSignal){
  const input=await prepareTrackingInput(media,maxDimension,ctx,signal);
  const range=await probeVideoRange(media.path,ctx,signal,{probe:input.probe});
  if(!range)throw new Error('원본 영상의 정확한 표시 구간을 확인하지 못했습니다.');
  await requireSourceRevision(media.path,input.revision);
  if(signal?.aborted)throw new CancelledError();
  return {...input,range};
}
/** One owned raw frame; the SAME decoder/clock/color/geometry as inference.
 * No disk image, proxy, browser seek heuristic, model or GPU session is created. */
export async function trackingStill(media:MediaAsset,time:number,maxDimension:number,ctx:EngineContext,signal?:AbortSignal):Promise<TrackingStill>{
  if(!Number.isFinite(time)||time<0||time>864000)throw new Error('추적 프레임 시각이 올바르지 않습니다.');
  const {plan,range,revision}=await prepareTrackingSource(media,maxDimension,ctx,signal),wanted=Math.max(range.videoStart,Math.min(range.videoEnd-.000001,time));
  const times=await presentedFrameTimes(media.path,plan.stream,plan.origin,wanted,ctx,signal);let result:TrackingStill|undefined;
  for await(const frame of decodeTrackingFrames(plan,times.time,times.time+1,ctx,signal)){
    result={time:frame.pts/1e6-plan.origin,previousTime:times.previous===undefined?undefined:times.previous/1e6-plan.origin,nextTime:times.next===undefined?undefined:times.next/1e6-plan.origin,width:frame.width,height:frame.height,sourceWidth:frame.sourceWidth,sourceHeight:frame.sourceHeight,bgr:Uint8Array.from(frame.data),sourceRevision:revision,...range};break;
  }
  if(signal?.aborted)throw new CancelledError();await requireSourceRevision(media.path,revision);if(!result)throw new Error('추적 기준 프레임을 표시하지 못했습니다.');return result;
}
/** Latest-request-wins, with teardown BEFORE another decoder starts. Tokenized
 * cancellation cannot cancel a later dialog's request. */
export class TrackingStillService {
  private active?:{id:string;controller:AbortController};private tail:Promise<unknown>=Promise.resolve();private closed=false;
  constructor(private ctx:EngineContext,private decode=trackingStill){}
  request(id:string,media:MediaAsset,time:number,maximum=1280){
    if(this.closed)throw new Error('프레임 표시를 종료했습니다.');if(typeof id!=='string'||!id||id.length>128)throw new Error('추적 프레임 요청 ID가 올바르지 않습니다.');
    if(!Number.isFinite(time)||time<0||time>864000)throw new Error('추적 프레임 시각이 올바르지 않습니다.');if(!Number.isInteger(maximum)||maximum<64||maximum>4096)throw new Error('추적 분석 해상도가 올바르지 않습니다.');
    this.active?.controller.abort();const task={id,controller:new AbortController()};this.active=task;
    const result=this.tail.then(()=>{if(task.controller.signal.aborted)throw new CancelledError();return this.decode(media,time,maximum,this.ctx,task.controller.signal);});
    this.tail=result.then(()=>{},()=>{}).finally(()=>{if(this.active===task)this.active=undefined;});return result;
  }
  cancel(id:string){if(this.active?.id===id)this.active.controller.abort();}
  async close(){this.closed=true;this.active?.controller.abort();await this.tail;}
}
