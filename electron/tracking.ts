import {prepareTrackingSource} from './tracking-source';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {MediaAsset} from '../shared/types';
import {validMotionBox,type TrackingOptions,type TrackingAnchor,type MotionAnalysis,type MotionSample} from '../shared/tracking';
import {CancelledError,type EngineContext,type ProgressCallback} from './media';
import {requireSourceRevision} from './source-revision';
import {localFilePath,insideDirectory,assertOutputNotSource} from './file-policy';
import {presentedFrameTime} from './video-frame';
import {decodeTrackingFrames,type DecodedTrackingFrame} from './tracking-decode';
import {MotionSampleWriter,assembleMotionFile,MotionFileReader} from './tracking-file';
import {BackwardTrackingBuffer} from './tracking-buffer';
import type {TrackingBox,TrackingFrame,TrackingObservation} from './tracking-math';

export interface TrackingSession {
  readonly backend:'cpu'|'dml';
  anchor(frame:TrackingFrame,box:TrackingBox):Promise<TrackingObservation>|TrackingObservation;
  update(frame:TrackingFrame):Promise<TrackingObservation>;
  close():Promise<void>;
}
export interface TrackingContext extends EngineContext {
  derivedDir?:string;backwardBufferBytes?:number;backwardSpoolBytes?:number;
  createTracker:(backend:'auto'|'cpu'|'dml',signal?:AbortSignal)=>Promise<TrackingSession>;
}

export function normalizeTrackingOptions(options:TrackingOptions):Required<TrackingOptions>{
  if(!options||typeof options!=='object'||!Number.isFinite(options.start)||options.start<0||options.start>864000||!Number.isFinite(options.duration)||options.duration<.000001||options.duration>86400||options.start+options.duration>864000||!Array.isArray(options.anchors)||options.anchors.length<1||options.anchors.length>64)throw new Error('추적 구간 또는 기준점이 올바르지 않습니다.');
  const maxDimension=options.maxDimension??1280,device=options.device??'auto';
  if(!Number.isInteger(maxDimension)||maxDimension<64||maxDimension>4096||!['auto','cpu','gpu'].includes(device))throw new Error('추적 분석 설정이 올바르지 않습니다.');
  const anchors=options.anchors.map(anchor=>{if(!anchor||!Number.isFinite(anchor.time)||anchor.time<options.start||anchor.time>=options.start+options.duration||!validMotionBox(anchor.box))throw new Error('추적 기준점이 선택 구간 또는 영상 범위를 벗어났습니다.');return {time:anchor.time,box:{...anchor.box}};}).sort((a,b)=>a.time-b.time);
  if(anchors.some((a,i)=>i>0&&a.time<=anchors[i-1].time))throw new Error('같은 시각에 추적 기준점이 여러 개 있습니다.');
  return {start:options.start,duration:options.duration,anchors,maxDimension,device};
}
const pixelBox=(anchor:TrackingAnchor,width:number,height:number):TrackingBox=>{
  const x=Math.min(width-1,Math.floor(anchor.box.x*width+1e-7)),y=Math.min(height-1,Math.floor(anchor.box.y*height+1e-7)),right=Math.min(width,Math.ceil((anchor.box.x+anchor.box.width)*width-1e-7)),bottom=Math.min(height,Math.ceil((anchor.box.y+anchor.box.height)*height-1e-7));
  if(right-x<4||bottom-y<4)throw new Error('분석 영상에서 추적 대상이 너무 작습니다. 영역이나 분석 해상도를 늘려 주세요.');
  return [x,y,right-x,bottom-y];
};

/** Analyze the whole selected interval, including frames BEFORE the first
 * anchor. Reverse windows use bounded RAM or a bounded reusable disk spool;
 * no full-video frame array or full-video raw spool is needed. */
export async function trackMedia(media:MediaAsset,options:TrackingOptions,ctx:TrackingContext,progress?:ProgressCallback,signal?:AbortSignal):Promise<MotionAnalysis>{
  const abort=()=>{if(signal?.aborted)throw new CancelledError();};abort();const settings=normalizeTrackingOptions(options);
  let lastProgress=0;
  const diagnostic=(event:Record<string,unknown>)=>{try{ctx.diagnostics?.(event);}catch{}},notify=(p:number,message:string)=>{lastProgress=Math.max(lastProgress,Math.max(0,Math.min(1,p)));try{progress?.(lastProgress,message);}catch{}};
  notify(0,'영상 시각 확인 중');
  const {plan,range,revision}=await prepareTrackingSource(media,settings.maxDimension,ctx,signal),unchanged=async()=>{abort();await requireSourceRevision(media.path,revision);};
  const start=Math.max(settings.start,range.videoStart),end=Math.min(settings.start+settings.duration,range.videoEnd);
  if(start>=end||settings.anchors.some(a=>a.time<start||a.time>=end))throw new Error('추적 기준점을 영상이 표시되는 구간 안에 지정하세요.');
  const firstPts=await presentedFrameTime(media.path,plan.stream,plan.origin,start,ctx,signal),endPts=Math.round((plan.origin+end)*1e6),anchors:Array<TrackingAnchor&{pts:number}>=[];
  for(const anchor of settings.anchors){abort();const pts=anchor.time===start?firstPts:await presentedFrameTime(media.path,plan.stream,plan.origin,anchor.time,ctx,signal);if(anchors.length&&pts<=anchors[anchors.length-1].pts)throw new Error('같은 영상 프레임에 기준점이 여러 개 있습니다. 한 개만 남겨 주세요.');anchors.push({...anchor,pts});}
  const directory=path.resolve(ctx.derivedDir||path.join(ctx.cacheDir,'derived'));if(!localFilePath(directory))throw new Error('추적 경로 저장 폴더가 올바르지 않습니다.');await fs.mkdir(directory,{recursive:true});
  const work=await fs.mkdtemp(path.join(directory,'.tracking-')),id=randomUUID(),target=path.join(directory,`tracking-${id}.slutrack`);let published=false,complete=false;
  let failedBackend:'cpu'|'dml'|undefined;
  const attempt=async(backend:'auto'|'cpu'|'dml',number:number):Promise<MotionAnalysis>=>{
    const forward=path.join(work,`forward-${number}.bin`),backward=path.join(work,`backward-${number}.bin`),temporary=path.join(work,`result-${number}.slutrack`);
    let fw:MotionSampleWriter|undefined,bw:MotionSampleWriter|undefined,tracker:TrackingSession|undefined,buffer:BackwardTrackingBuffer|undefined;
    try{
      fw=await MotionSampleWriter.open(forward,1);bw=await MotionSampleWriter.open(backward,-1);tracker=await ctx.createTracker(backend,signal);await unchanged();
      const used=new Set<string>(),resolved:TrackingAnchor[]=[],intervals:number[]=[];let firstAnchorFrame:DecodedTrackingFrame|undefined,anchorIndex=0,total=0,previousPts:number|undefined,intervalIndex=0;
      const sample=(frame:DecodedTrackingFrame,observation:TrackingObservation,anchor=false):MotionSample=>{
        const [x,y,width,height]=observation.box;used.add(tracker!.backend);if(++total>20_000_000)throw new Error('추적 경로가 2,000만 프레임 한도를 초과했습니다.');
        return {time:Math.max(start,frame.pts/1e6-plan.origin),box:{x:x/frame.width,y:y/frame.height,width:width/frame.width,height:height/frame.height},score:observation.score,status:observation.status,anchor};
      };
      notify(.08,'앞 방향 추적 중');
      for await(const frame of decodeTrackingFrames(plan,anchors[0].pts,endPts,ctx,signal)){
        if(previousPts!==undefined)intervals[intervalIndex++%128]=(frame.pts-previousPts)/1e6;previousPts=frame.pts;
        abort();let result:TrackingObservation,anchored=false;const anchor=anchors[anchorIndex];
        if(anchor&&Math.abs(frame.pts-anchor.pts)<=1){result=await tracker.anchor(frame,pixelBox(anchor,frame.width,frame.height));anchored=true;resolved.push({time:Math.max(start,frame.pts/1e6-plan.origin),box:anchor.box});anchorIndex++;if(!firstAnchorFrame)firstAnchorFrame={...frame,data:Buffer.from(frame.data)};}
        else{if(anchor&&frame.pts>anchor.pts)throw new Error('추적 기준 프레임이 디코딩에서 누락되었습니다.');result=await tracker.update(frame);}
        await fw.append(sample(frame,result,anchored));notify(.08+.84*Math.max(0,(frame.pts-anchors[0].pts)/1e6)/(end-start),'앞 방향 추적 중');
      }
      if(!firstAnchorFrame||anchorIndex!==anchors.length)throw new Error('추적 기준 프레임을 모두 처리하지 못했습니다.');await unchanged();
      // Retain the first anchor's template for the backward pass; later manual
      // anchors must not replace it when following the object into the past.
      let hi=anchors[0].pts;const frameBytes=firstAnchorFrame.data.byteLength,budget=ctx.backwardBufferBytes??32*1024*1024;
      if(!Number.isInteger(budget)||budget<1||budget>128*1024*1024)throw new Error('추적 프레임 버퍼 설정이 올바르지 않습니다.');
      const memoryCapacity=Math.max(1,Math.min(512,Math.floor(budget/frameBytes))),spoolBytes=ctx.backwardSpoolBytes??(hi>firstPts&&frameBytes>=1024*1024&&memoryCapacity<32?256*1024*1024:0);
      buffer=await BackwardTrackingBuffer.open(frameBytes,budget,spoolBytes,path.join(work,`reverse-${number}.frames`));
      diagnostic({event:'tracking-buffer',mode:buffer.mode,frameBytes,capacity:buffer.capacity,payloadBytes:buffer.payloadBytes,budgetBytes:budget,diskBytes:buffer.diskBytes,diskBudgetBytes:spoolBytes});
      // Observed intervals only choose how much work to request, never the
      // frame clock or frame count. A density change may wrap the bounded ring;
      // its oldest retained PTS then drives the next window without omissions.
      intervals.sort((a,b)=>a-b);const typical=intervals.length?intervals[Math.floor(intervals.length/2)]:1/Math.max(1,media.fps||30);
      let windowSeconds=buffer.mode==='disk'?Math.min(8,buffer.capacity*typical*.9):1;
      if(hi>firstPts){await tracker.anchor(firstAnchorFrame,pixelBox(anchors[0],firstAnchorFrame.width,firstAnchorFrame.height));}
      while(hi>firstPts){
        await unchanged();const wanted=Math.max(start,hi/1e6-plan.origin-windowSeconds),lo=wanted===start?firstPts:await presentedFrameTime(media.path,plan.stream,plan.origin,wanted,ctx,signal);let count=0;buffer.reset();
        for await(const frame of decodeTrackingFrames(plan,Math.max(firstPts,lo),hi,ctx,signal)){
          abort();if(frame.width!==firstAnchorFrame.width||frame.height!==firstAnchorFrame.height||frame.sourceWidth!==firstAnchorFrame.sourceWidth||frame.sourceHeight!==firstAnchorFrame.sourceHeight)throw new Error('추적 영상의 프레임 크기가 변경되었습니다.');
          await buffer.push(frame,signal);count++;
        }
        if(!count)throw new Error('역방향 추적 프레임을 찾지 못했습니다.');
        let oldest=hi;
        for await(const frame of buffer.reverse(signal)){if(frame.pts>=oldest)throw new Error('역방향 추적 프레임 순서가 올바르지 않습니다.');oldest=frame.pts;
          const result=await tracker.update(frame);await bw.append(sample(frame,result));notify(.08+.84*((end-anchors[0].pts/1e6+plan.origin)+(anchors[0].pts-frame.pts)/1e6)/(end-start),'뒤 방향 추적 중');}
        if(oldest>=hi)throw new Error('역방향 추적이 진행되지 않았습니다.');diagnostic({event:'tracking-reverse-window',mode:buffer.mode,from:oldest,to:hi,decoded:count,retained:buffer.length});
        if(buffer.mode==='disk')windowSeconds=Math.min(8,Math.max(.000001,(hi-oldest)/1e6*buffer.capacity/buffer.length*.9));hi=oldest;
      }
      await unchanged();await buffer.close();buffer=undefined;await fw.close();fw=undefined;await bw.close();bw=undefined;await tracker.close();tracker=undefined;
      const metadata:Omit<MotionAnalysis,'path'>={version:1,id,mediaId:media.id,sourceRevision:revision,sourceWidth:firstAnchorFrame.sourceWidth,sourceHeight:firstAnchorFrame.sourceHeight,analysisWidth:firstAnchorFrame.width,analysisHeight:firstAnchorFrame.height,start,end,firstFrameTime:firstPts/1e6-plan.origin,frames:total,anchors:resolved,backend:used.size>1?'mixed':used.has('dml')?'dml':'cpu'};
      notify(.94,'추적 경로 저장 중');await assembleMotionFile(temporary,metadata,backward,forward,signal);await unchanged();
      const reader=await MotionFileReader.open(temporary);try{const first=await reader.sample(0),last=await reader.sample(total-1);if(Math.abs(first.time-start)>.000002||last.time>=end)throw new Error('추적 경로의 시작 또는 끝이 선택 구간과 다릅니다.');}finally{await reader.close();}
      await assertOutputNotSource(target,[media.path]);await fs.link(temporary,target);published=true;await unchanged();complete=true;notify(1,'객체 추적 완료');return {...metadata,path:target};
    }catch(error){failedBackend=tracker?.backend;throw error;}finally{await Promise.allSettled([fw?.close(),bw?.close(),tracker?.close(),buffer?.close()]);}
  };
  try{
    const backend=settings.device==='gpu'?'dml':settings.device;
    try{return await attempt(backend,0);}catch(error){
      await unchanged();if(backend!=='auto'||failedBackend==='cpu'||published||!(error instanceof Error)||error.name!=='TrackingProcessError')throw error;
      diagnostic({event:'tracking-process-fallback',error:error.message});notify(.05,'GPU 추적 작업을 다시 시작하는 중');return await attempt('cpu',1);
    }
  }finally{
    if(published&&!complete)await fs.rm(target,{force:true}).catch(()=>{});
    const actualWork=await fs.realpath(work).catch(()=>undefined),actualDirectory=await fs.realpath(directory).catch(()=>undefined);if(actualWork&&actualDirectory&&insideDirectory(actualWork,actualDirectory))await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
  }
}
