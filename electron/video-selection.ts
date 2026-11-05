import {CancelledError,type EngineContext} from './media';
import {presentedFrameTimes} from './video-frame';
import {probeVideoRange,type VideoRange} from './video-range';
import {requireSourceRevision} from './source-revision';

interface SelectionSource {
  file:string;
  stream:number;
  origin:number;
  revision:string;
  probe?:unknown;
}

/** Prove only the requested half-open interval. A decoded frame at or after
 * its end proves coverage without needing the video's global end. Terminal
 * held frames still need the full range reader's real final-frame duration.
 * This result never enters the cache for a complete VideoRange. */
export async function verifyVideoSelection(
  source:SelectionSource,start:number,duration:number,ctx:EngineContext,signal?:AbortSignal,
):Promise<{firstPts:number;startPts:number;endPts:number}>{
  if(!Number.isFinite(start)||!Number.isFinite(duration)||start<0||duration<=0||start+duration>864000){
    throw new Error('선택한 영상 구간이 올바르지 않습니다.');
  }
  const abort=()=>{if(signal?.aborted)throw new CancelledError();};
  abort();await requireSourceRevision(source.file,source.revision);abort();
  const startPts=Math.round((source.origin+start)*1e6);
  const endPts=Math.round((source.origin+start+duration)*1e6);
  if(!Number.isSafeInteger(startPts)||!Number.isSafeInteger(endPts)||endPts<=startPts){
    throw new Error('선택한 영상 구간의 시각이 지원 범위를 벗어났습니다.');
  }
  const checkRange=(range:VideoRange|undefined)=>{
    if(!range)throw new Error('원본 영상의 정확한 표시 구간을 확인하지 못했습니다.');
    if(start<range.videoStart-.000001||start+duration>range.videoEnd+.000001){
      throw new Error('선택한 구간이 원본 영상의 표시 범위를 벗어났습니다.');
    }
  };
  let range=await probeVideoRange(source.file,ctx,signal,{probe:source.probe,allowScan:false});
  if(range)checkRange(range);
  const first=await presentedFrameTimes(source.file,source.stream,source.origin,start,ctx,signal,false,{strictErrors:true});
  let method='complete-range';
  if(!range){
    let covered=false;
    if(first.time<=startPts){
      const end=await presentedFrameTimes(source.file,source.stream,source.origin,start+duration,ctx,signal,false,{strictErrors:true});
      covered=end.time===endPts||(end.next!==undefined&&end.next>endPts);
    }
    if(covered){
      method='decoded-boundaries';
    }else{
      range=await probeVideoRange(source.file,ctx,signal,{probe:source.probe});
      checkRange(range);
      method='full-range-fallback';
    }
  }
  abort();await requireSourceRevision(source.file,source.revision);abort();
  try{ctx.diagnostics?.({event:'video-selection-verified',method,startPts,endPts,firstPts:first.time});}catch{}
  return {firstPts:first.time,startPts,endPts};
}
