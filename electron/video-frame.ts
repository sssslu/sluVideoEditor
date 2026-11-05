import {CancelledError,runProcess,type EngineContext} from './media';
import {ffprobeIntervalFrom} from './probe-interval';

interface FrameProbeOptions {
  /** Range witnesses must not accept a decoder's recovered/error output. */
  strictErrors?:boolean;
}

class FrameProbeError extends Error {}

/** Find the held frame and its neighbors in decoded presentation order.
 * Stop after a following frame rather than a packet-time interval endpoint,
 * which can cut off reordered B-frames. Only two preceding timestamps remain
 * in memory, including when a sparse source needs a wider seek window. */
export async function presentedFrameTimes(
  file:string,index:number,origin:number,time:number,ctx:EngineContext,
  signal?:AbortSignal,requirePrevious=true,options:FrameProbeOptions={},
):Promise<{time:number;previous?:number;next?:number}>{
  if(!Number.isInteger(index)||index<0||!Number.isFinite(origin)||!Number.isFinite(time)||time<0){
    throw new Error('영상 프레임 시각이 올바르지 않습니다.');
  }
  const wanted=Math.round((origin+time)*1e6);
  if(!Number.isSafeInteger(wanted))throw new Error('영상 프레임 시각이 지원 범위를 벗어났습니다.');

  const scan=async(seek?:number)=>{
    let first:number|undefined,previous:number|undefined,before:number|undefined,next:number|undefined;
    let pending='',following=false,pid:number|undefined,outputBytes=0,outputHead='',probeError='';
    let records=0,parseError:Error|undefined;
    const stop=new AbortController();
    const combined=signal?AbortSignal.any([signal,stop.signal]):stop.signal;
    const parse=(line:string)=>{
      const token=line.split(',')[0].trim();
      if(!token)return;
      const value=Number(token),pts=Math.round(value*1e6);
      if(token==='N/A'||!Number.isFinite(value)||!Number.isSafeInteger(pts)){
        if(options.strictErrors){
          parseError??=new FrameProbeError('영상 프레임의 정확한 표시 시각을 확인하지 못했습니다.');
          stop.abort();
        }
        return;
      }
      records++;
      if(following||parseError)return;
      first??=pts;
      if(pts<=wanted){
        if(previous===undefined||pts>previous){before=previous;previous=pts;}
      }else{
        next=pts;following=true;stop.abort();
      }
    };
    try{
      await runProcess(ctx.ffprobe,[
        '-v','error','-threads','1',...(options.strictErrors?['-err_detect','explode']:[]),
        '-protocol_whitelist','file,pipe','-select_streams',String(index),
        ...(seek===undefined?[]:['-read_intervals',ffprobeIntervalFrom(seek)]),
        '-show_frames','-show_entries','frame=best_effort_timestamp_time:frame_side_data=',
        '-of','csv=p=0',file,
      ],{
        signal:combined,timeoutMs:120000,captureStdout:false,
        onSpawn:spawned=>{
          pid=spawned;
          queueMicrotask(()=>{
            try{ctx.diagnostics?.({event:'frame-probe-start',pid,seek,wanted});}catch{}
          });
        },
        onStderr:text=>{probeError=(probeError+text).slice(-512);},
        onStdout:data=>{
          outputBytes+=data.length;
          if(outputHead.length<256)outputHead=(outputHead+data.toString()).slice(0,256);
          pending+=data.toString();
          const lines=pending.split(/\r?\n/);pending=lines.pop()||'';
          for(const line of lines)parse(line);
          if(options.strictErrors&&pending.length>4096){
            parseError??=new FrameProbeError('영상 프레임 시각 레코드가 너무 깁니다.');
            stop.abort();
          }
        },
      });
    }catch(error){
      if(signal?.aborted)throw new CancelledError();
      if(parseError)throw parseError;
      if(options.strictErrors&&probeError.trim())throw new FrameProbeError(`영상 프레임을 정확히 확인할 수 없습니다.\n${probeError.trim()}`);
      if(!following||!(error instanceof CancelledError))throw error;
    }
    if(signal?.aborted)throw new CancelledError();
    if(pending)parse(pending);
    if(parseError)throw parseError;
    if(options.strictErrors&&probeError.trim()){
      throw new FrameProbeError(`영상 프레임을 정확히 확인할 수 없습니다.\n${probeError.trim()}`);
    }
    try{
      ctx.diagnostics?.({
        event:'frame-probe-exit',pid,seek,wanted,first,previous,before,next,records,
        ...(first===undefined?{outputBytes,outputHead,probeError}:{}),
      });
    }catch{}
    return {first,previous,before,next};
  };

  const read=async(seek?:number)=>{
    try{return await scan(seek);}
    catch(error){
      if(signal?.aborted)throw new CancelledError();
      if(seek===undefined||!(error instanceof FrameProbeError))throw error;
      // A valid reordered stream can report missing references after seeking.
      // Retry from its beginning and still require a completely clean witness.
      try{ctx.diagnostics?.({event:'frame-probe-retry',seek,wanted,reason:'decode-error'});}catch{}
      return scan();
    }
  };

  const seek=time>1?origin+time-1:undefined;
  let result=await read(seek);
  // A seek can land after the cut or omit its predecessor. Expand backward
  // until a decoded witness exists, using an unseeked scan as the last resort.
  if(seek!==undefined){
    let lookback=2;
    while(result.previous===undefined||(requirePrevious&&result.before===undefined)){
      const from=time-lookback;
      result=await read(from>0?origin+from:undefined);
      if(from<=0)break;
      lookback*=2;
    }
  }
  if(signal?.aborted)throw new CancelledError();
  const pts=result.previous??result.first;
  if(pts===undefined)throw new Error('선택 구간의 원본 영상 프레임을 찾지 못했습니다.');
  return {time:pts,previous:result.before,next:result.next!==pts?result.next:undefined};
}

export async function presentedFrameTime(file:string,index:number,origin:number,time:number,ctx:EngineContext,signal?:AbortSignal):Promise<number>{
  return (await presentedFrameTimes(file,index,origin,time,ctx,signal,false)).time;
}
