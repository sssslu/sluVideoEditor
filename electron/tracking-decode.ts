import {spawn} from 'node:child_process';
import type {EngineContext} from './media';
import {CancelledError} from './media';
import type {TrackingFrame} from './tracking-math';
import {ffmpegSeconds} from './ffmpeg-time';

export interface TrackingDecodePlan {file:string;stream:number;origin:number;filter:string;decoder:string[];maxDimension:number}
export interface DecodedTrackingFrame extends TrackingFrame {pts:number;sourceWidth:number;sourceHeight:number}
class SeekMiss extends Error {}

/** Raw BGR frames and their showinfo timestamps come from the SAME decoder.
 * Both pipes are bounded; no nominal-FPS clock or separate decoding oracle is
 * used to pair frames. `data` is valid until the generator advances again. */
export async function* decodeTrackingFrames(plan:TrackingDecodePlan,firstPts:number,endPts:number,ctx:EngineContext,signal?:AbortSignal):AsyncGenerator<DecodedTrackingFrame>{
  if(![firstPts,endPts].every(Number.isSafeInteger)||endPts<=firstPts)throw new Error('추적 디코딩 구간이 올바르지 않습니다.');
  const seek=Math.max(0,firstPts/1e6-plan.origin-1);let emitted=false;
  try{for await(const frame of decode(seek>0?seek:undefined)){emitted=true;yield frame;}}
  catch(error){if(!(error instanceof SeekMiss)||!seek||emitted)throw error;for await(const frame of decode()){yield frame;}}

  async function* decode(seek?:number):AsyncGenerator<DecodedTrackingFrame>{
    if(signal?.aborted)throw new CancelledError();
    const filter=`settb=AVTB,trim=start_pts=${firstPts}:end_pts=${endPts},${plan.filter},showinfo@slu_native=checksum=0,scale=w='min(iw,${plan.maxDimension})':h='min(ih,${plan.maxDimension})':force_original_aspect_ratio=decrease:flags=bilinear+accurate_rnd,format=bgr24,setsar=1,showinfo@slu_tracking=checksum=0`;
    const args=['-hide_banner','-loglevel','info','-nostats','-nostdin','-copyts','-threads','2',...(seek===undefined?[]:['-ss',ffmpegSeconds(seek),'-noaccurate_seek']),...plan.decoder,'-protocol_whitelist','file,pipe','-i',plan.file,'-map',`0:${plan.stream}`,'-an','-sn','-dn','-filter_threads','1','-vf',filter,'-fps_mode','passthrough','-enc_time_base:v','filter','-c:v','rawvideo','-pix_fmt','bgr24','-threads','1','-f','rawvideo','pipe:1'];
    const child=spawn(ctx.ffmpeg,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    type Stamp=Omit<DecodedTrackingFrame,'data'>;
    const queue:Stamp[]=[];let waiter:(()=>void)|undefined,pending='',stderr='',failure:Error|undefined,closed=false,code:number|null=null,seen=0,received=0,last=-Infinity,natural:{width:number;height:number}|undefined;
    const wake=()=>{waiter?.();waiter=undefined;};
    const fail=(error:Error)=>{failure??=error;child.kill();wake();};
    const finish=new Promise<void>(resolve=>{child.on('error',fail);child.on('close',exitCode=>{code=exitCode;closed=true;wake();resolve();});});
    const abort=()=>fail(new CancelledError());signal?.addEventListener('abort',abort,{once:true});
    let idle:ReturnType<typeof setTimeout>,consumerBusy=false;
    const reset=()=>{clearTimeout(idle);if(consumerBusy)return;idle=setTimeout(()=>fail(new Error('추적 영상 디코더가 응답하지 않습니다.')),180000);idle.unref();};reset();
    const line=(text:string)=>{
      const native=text.includes('showinfo@slu_native'),tracking=text.includes('showinfo@slu_tracking');if(!native&&!tracking)return;
      const stamp=text.match(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s.*?\bs:(\d+)x(\d+)\b/);if(!stamp)return;
      const index=Number(stamp[1]),pts=Number(stamp[2]),width=Number(stamp[3]),height=Number(stamp[4]);
      if(native){if(!natural)natural={width,height};else if(natural.width!==width||natural.height!==height)throw new Error('추적 도중 원본 영상 크기가 변경되었습니다.');return;}
      if(!natural||index!==seen||!Number.isSafeInteger(pts)||pts<=last||width<1||height<1||width>plan.maxDimension||height>plan.maxDimension||width*height>4096*4096)throw new Error('추적 영상의 프레임 시각 또는 크기가 올바르지 않습니다.');
      // Tiny frames can fit many timestamps ahead of stdout's pipe watermark.
      // Keep this bounded without rejecting valid small, high-FPS sources.
      const maximum=Math.max(256,Math.min(65536,Math.ceil(4*1024*1024/(width*height*3))));
      if(queue.length>=maximum)throw new Error('추적 영상의 프레임 대기열 제한을 초과했습니다.');
      queue.push({width,height,pts,sourceWidth:natural.width,sourceHeight:natural.height});seen++;last=pts;wake();
    };
    child.stderr.on('data',(chunk:Buffer)=>{
      reset();const text=chunk.toString();stderr=(stderr+text).slice(-8000);pending+=text;
      try{let at:number;while((at=pending.indexOf('\n'))>=0){const text=pending.slice(0,at);pending=pending.slice(at+1);line(text);}if(pending.length>32768)pending=pending.slice(-32768);}catch(error){fail(error instanceof Error?error:new Error(String(error)));}
    });
    child.stderr.on('error',fail);
    const nextStamp=async()=>{
      while(!queue.length){if(failure)throw failure;if(closed)throw new Error('디코딩된 영상과 프레임 시각의 수가 일치하지 않습니다.');await new Promise<void>(resolve=>{waiter=resolve;});}
      if(failure)throw failure;return queue.shift()!;
    };
    try{
      try{ctx.diagnostics?.({event:'tracking-decoder-start',pid:child.pid,firstPts,endPts,seek});}catch{}
      if(signal?.aborted)abort();let frame:Buffer|undefined,stamp:Stamp|undefined,filled=0,width=0,height=0;
      for await(const chunk of child.stdout){
        reset();const bytes=chunk as Buffer;let at=0;
        while(at<bytes.length){
          if(failure)throw failure;
          if(!stamp){stamp=await nextStamp();if(!received&&Math.abs(stamp.pts-firstPts)>1)throw new SeekMiss('선택한 원본 프레임을 디코딩하지 못했습니다.');
            if(frame&&(stamp.width!==width||stamp.height!==height))throw new Error('추적 도중 영상 크기가 변경되었습니다.');
            width=stamp.width;height=stamp.height;frame??=Buffer.alloc(width*height*3);
          }
          const length=Math.min(frame!.length-filled,bytes.length-at);bytes.copy(frame!,filled,at,at+length);filled+=length;at+=length;
          if(filled===frame!.length){
            received++;consumerBusy=true;clearTimeout(idle!);
            // Backpressure from model inference is not a stalled decoder.
            // Abort/error listeners remain active while the consumer owns the frame.
            try{yield {...stamp,data:frame!};}finally{consumerBusy=false;reset();}
            filled=0;stamp=undefined;
          }
        }
      }
      await finish;if(failure)throw failure;if(code!==0)throw new Error(`추적 영상 디코딩에 실패했습니다 (${code}). ${stderr}`);
      // Some demuxers seek beyond the requested interval (notably negative-PTS
      // MPEG-TS). An empty successful decode is also a seek miss; retry without
      // seeking before reporting a missing source frame.
      if(!received&&!seen&&!filled&&seek!==undefined)throw new SeekMiss('선택한 원본 프레임을 디코딩하지 못했습니다.');
      if(filled||queue.length||seen!==received||!received)throw new Error('추적 영상의 프레임 기록이 불완전합니다.');
    }finally{
      clearTimeout(idle!);signal?.removeEventListener('abort',abort);child.kill();await finish;
      try{ctx.diagnostics?.({event:'tracking-decoder-exit',pid:child.pid,code,frames:received});}catch{}
    }
  }
}
