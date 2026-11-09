import {spawn} from 'node:child_process';
import {promises as fs,createWriteStream} from 'node:fs';
import {once} from 'node:events';
import {availableParallelism} from 'node:os';
import {CancelledError,type EngineContext} from './media';
import {ffprobeIntervalFrom} from './probe-interval';
import {ffmpegSeconds} from './ffmpeg-time';

/** Presentation timestamps are spooled as little-endian float64 integers.
 * Memory depends on pipe/write buffers, never on the selected clip length. */
export async function spoolReverseFrames(file:string,index:number,origin:number,at:number,until:number,target:string,ctx:EngineContext,signal?:AbortSignal,decoder:'cpu'|'cuda'='cpu'):Promise<{count:number;first:number;last:number}> {
  const cuda=decoder==='cuda';
  const scan=async(seek?:number)=>{
    if(signal?.aborted)throw new CancelledError();
    const output=createWriteStream(target,{flags:'w',highWaterMark:65536});
    // Read from the seek through decoded PTS, with no packet-time cut endpoint:
    // it can discard a reference packet before its earlier B-frame is decoded.
    // wrapped_avframe sends only an AVFrame descriptor to framecrc: GPU pixels
    // stay on the device. The checksum is ignored; its integer PTS is exact.
    // Explicit format=cuda forbids an unnoticed software-decoder fallback.
    const args=cuda?['-v','error','-nostdin','-copyts','-threads','1','-hwaccel','cuda','-hwaccel_output_format','cuda','-extra_hw_frames','2','-noautorotate',...(seek===undefined?[]:['-ss',ffmpegSeconds(seek),'-seek_timestamp','1','-noaccurate_seek']),'-protocol_whitelist','file,pipe','-i',file,'-map',`0:${index}`,'-an','-sn','-dn','-vf','format=cuda,settb=AVTB','-fps_mode','passthrough','-enc_time_base:v','filter','-c:v','wrapped_avframe','-avoid_negative_ts','disabled','-f','framecrc','pipe:1']:['-v','error','-threads',String(Math.max(1,Math.min(4,availableParallelism()-1))),'-protocol_whitelist','file,pipe','-select_streams',String(index),...(seek===undefined?[]:['-read_intervals',ffprobeIntervalFrom(seek)]),'-show_frames','-show_entries','frame=best_effort_timestamp_time:frame_side_data=','-of','csv=p=0',file];
    const child=spawn(cuda?ctx.ffmpeg:ctx.ffprobe,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    let count=0,first=NaN,last=NaN,previous:number|undefined,seen:number|undefined,pending='',stderr='',stop=false,started=false,timebase=false,failure:Error|undefined;
    // Observe spawn errors immediately; stdout may finish on a later turn.
    const finish=once(child,'close').then(([code])=>code as number|null,error=>{failure=error;return null;});
    const abort=()=>{failure=new CancelledError();child.kill();};signal?.addEventListener('abort',abort,{once:true});
    let idle:ReturnType<typeof setTimeout>;const reset=()=>{clearTimeout(idle);idle=setTimeout(()=>{failure=new Error('역재생 프레임 분석이 응답하지 않습니다.');child.kill();},180000);idle.unref();};reset();
    child.stderr.on('data',data=>{reset();stderr=(stderr+data.toString()).slice(-8000);});
    output.on('error',error=>{failure=error;child.kill();});
    try{
      try{ctx.diagnostics?.({event:'reverse-process',phase:'frames',decoder,pid:child.pid});}catch{}
      if(signal?.aborted)abort();
      const parse=(line:string,values:number[])=>{
        if(stop)return;
        if(cuda&&line.startsWith('#')){if(/^#tb 0:\s+1\/1000000\s*$/.test(line))timebase=true;return;}
        const fields=line.split(','),token=(fields[cuda?2:0]||'').trim();if(!token||token==='N/A')return;
        const value=Number(token);if(!Number.isFinite(value))return;
        if(cuda&&(!timebase||fields[0].trim()!=='0'||!Number.isSafeInteger(value)))throw new Error('GPU 프레임 시각의 시간 단위가 올바르지 않습니다.');
        const pts=cuda?value:Math.round(value*1e6);
        if(seen!==undefined&&pts<=seen)throw new Error('중복되거나 역행하는 원본 프레임 시각은 역재생할 수 없습니다.');seen=pts;
        if(pts<=at){previous=pts;return;}
        if(!started){if(previous!==undefined)values.push(previous);started=true;}
        if(pts>=until){stop=true;child.kill();return;}values.push(pts);
      };
      const append=async(values:number[])=>{if(!values.length)return;const buffer=Buffer.allocUnsafe(values.length*8);for(let i=0;i<values.length;i++)buffer.writeDoubleLE(values[i],i*8);first=Number.isNaN(first)?values[0]:first;last=values[values.length-1];count+=values.length;if(!output.write(buffer))await once(output,'drain');};
      for await(const data of child.stdout){reset();pending+=data.toString();const lines=pending.split(/\r?\n/);pending=lines.pop()||'';const values:number[]=[];for(const line of lines)parse(line,values);await append(values);}
      if(pending){const values:number[]=[];parse(pending,values);await append(values);}
      if(!started&&previous!==undefined)await append([previous]);
      const code=await finish;if(failure)throw failure;if(!stop&&code!==0)throw new Error(`원본 프레임 분석에 실패했습니다. ${stderr.trim()}`);
      output.end();await once(output,'finish');return {count,first,last,hasPrevious:previous!==undefined};
    }finally{
      clearTimeout(idle!);signal?.removeEventListener('abort',abort);child.kill();await finish.catch(()=>{});output.destroy();
      if(!output.closed)await once(output,'close').catch(()=>{});
    }
  };
  const seek=(at/1e6-origin)>1?Number((at/1e6-1).toFixed(6)):undefined;
  let result=await scan(seek);if(seek!==undefined&&(!result.count||!result.hasPrevious))result=await scan();
  if(signal?.aborted)throw new CancelledError();if(!result.count)throw new Error('선택 구간에서 역재생할 영상 프레임을 찾지 못했습니다.');
  const stat=await fs.stat(target);if(stat.size!==result.count*8)throw new Error('프레임 시각 목록을 저장하지 못했습니다.');return result;
}

export function timestampExpression(values:readonly number[],lo=0,hi=values.length):string {
  if(!values.length)throw new Error('프레임 시각이 없습니다.');
  if(hi-lo===1)return String(values[lo]);const mid=Math.floor((lo+hi)/2);
  return `if(lt(N,${mid}),${timestampExpression(values,lo,mid)},${timestampExpression(values,mid,hi)})`;
}

/** Reverse whole PCM frames, preserving the channel order within each frame. */
export async function reversePcmFile(input:string,output:string,channels:number,signal?:AbortSignal,onProgress?:(p:number)=>void,padding:{before:number;after:number}={before:0,after:0}):Promise<number>{
  if(signal?.aborted)throw new CancelledError();
  if(!Number.isInteger(channels)||channels<1||channels>32)throw new Error('지원하지 않는 오디오 채널 수입니다.');
  if(![padding.before,padding.after].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error('오디오 여백이 올바르지 않습니다.');
  const source=await fs.open(input,'r');let target:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{
    const {size}=await source.stat(),stride=channels*4;if(size%stride)throw new Error('오디오 샘플 파일이 손상되었습니다.');
    target=await fs.open(output,'wx');const total=size/stride+padding.before+padding.after;if(!Number.isSafeInteger(total*stride))throw new Error('오디오 크기가 지원 범위를 벗어났습니다.');await target.truncate(total*stride);
    const block=Math.max(stride,Math.floor(1024*1024/stride)*stride),bytes=Buffer.allocUnsafe(Math.min(block,size)),reversed=Buffer.allocUnsafe(bytes.length);let remaining=size,position=padding.after*stride;
    while(remaining){if(signal?.aborted)throw new CancelledError();const length=Math.min(remaining,bytes.length);remaining-=length;let received=0;while(received<length){const {bytesRead}=await source.read(bytes,received,length-received,remaining+received);if(!bytesRead)throw new Error('오디오 샘플이 읽는 중 변경되었습니다.');received+=bytesRead;}
      for(let offset=0;offset<length;offset+=stride)bytes.copy(reversed,length-offset-stride,offset,offset+stride);
      let written=0;while(written<length){const result=await target.write(reversed,written,length-written,position+written);if(!result.bytesWritten)throw new Error('역재생 오디오를 저장하지 못했습니다.');written+=result.bytesWritten;}position+=length;
      onProgress?.(1-remaining/size);
    }
    if(signal?.aborted)throw new CancelledError();return total;
  }finally{await source.close();await target?.close();}
}
