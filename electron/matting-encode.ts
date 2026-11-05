import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {NutVideoStream} from './nut-video';
import {CancelledError,type EngineContext} from './media';
export interface ProcessedVideoOptions {opaque?:boolean;maximumPixels?:number;idleTimeoutMs?:number}

/** Backpressured BGRA encoder. Alpha and every visible RGB byte are lossless;
 * RGB under exactly-zero alpha is canonicalized to zero before compression.
 * The only raw frame retained in JS is the caller's current one. */
export class MattingVideoEncoder {
 private child:ChildProcessWithoutNullStreams;private mux:NutVideoStream;
 private done:Promise<void>;private failure?:Error;private ended=false;private closed=false;
 private stderr='';private abort:()=>void;private idle?:ReturnType<typeof setTimeout>;
 private pendingReject?: (error:Error)=>void;private writing=false;
 constructor(width:number,height:number,target:string,private ctx:EngineContext,private signal?:AbortSignal,private options:ProcessedVideoOptions={}){
  if(signal?.aborted)throw new CancelledError();
  if(options.idleTimeoutMs!==undefined&&(!Number.isFinite(options.idleTimeoutMs)||options.idleTimeoutMs<100||options.idleTimeoutMs>1800000))throw new Error('영상 저장 대기 시간이 올바르지 않습니다.');
  this.mux=new NutVideoStream(width,height,options.maximumPixels);
  // A 65536-entry lookup clears ONLY invisible RGB; no alpha thresholding,
  // quantization, chroma subsampling or modification of the caller's buffer.
  const canonical="[0:v:0]format=gbrap,setparams=range=full,split[image][mask];[mask]alphaextract,format=gbrap[alpha];[image][alpha]lut2=c0='if(eq(y,0),0,x)':c1='if(eq(y,0),0,x)':c2='if(eq(y,0),0,x)':c3=x,format=bgra[encoded]";
  const pixelFormat=options.opaque?'bgr0':'bgra';
  const filter=options.opaque?'[0:v:0]format=bgr0[encoded]':canonical;
  this.child=spawn(ctx.ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y','-f','nut','-i','pipe:0','-filter_complex_threads','2','-filter_complex',filter,'-map','[encoded]','-an','-sn','-dn','-map_metadata','-1','-fps_mode','passthrough','-enc_time_base:v','1:1000000','-c:v','ffv1','-level','3','-g','30','-threads','4','-pix_fmt',pixelFormat,'-color_range','pc','-colorspace','rgb','-color_primaries','bt709','-color_trc','iec61966-2-1','-f','nut',target],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  this.abort=()=>this.fail(new CancelledError());
  this.child.on('error',error=>this.fail(error));this.child.stdin.on('error',error=>this.fail(error));this.child.stdout.on('error',error=>this.fail(error));this.child.stderr.on('error',error=>this.fail(error));
  this.child.stdout.resume();this.child.stderr.on('data',(chunk:Buffer)=>{this.stderr=(this.stderr+chunk.toString()).slice(-4000);this.resetTimeout();});
  this.done=new Promise(resolve=>this.child.on('close',code=>{
   this.closed=true;clearTimeout(this.idle);signal?.removeEventListener('abort',this.abort);
   if(code!==0||!this.ended)this.fail(new Error(`배경 제거 영상 저장에 실패했습니다 (${code}). ${this.stderr}`));
   this.diagnostic({event:'matting-encoder-exit',pid:this.child.pid,code});resolve();
  }));
  signal?.addEventListener('abort',this.abort,{once:true});if(signal?.aborted)this.abort();this.resetTimeout();
  queueMicrotask(()=>this.diagnostic({event:'matting-encoder-start',pid:this.child.pid}));
 }
 private diagnostic(event:Record<string,unknown>){try{this.ctx.diagnostics?.(event);}catch{}}
 private resetTimeout(){clearTimeout(this.idle);if(this.closed)return;this.idle=setTimeout(()=>this.fail(new Error('영상 저장 프로세스가 응답하지 않습니다.')),this.options.idleTimeoutMs??180000);this.idle.unref();}
 private fail(error:Error){this.failure??=error;this.pendingReject?.(this.failure);this.pendingReject=undefined;if(!this.closed)this.child.kill();}
 private async write(bytes:Buffer){
  if(this.failure)throw this.failure;if(this.ended||this.closed)throw new Error('배경 제거 영상 스트림이 종료되었습니다.');this.resetTimeout();
  await new Promise<void>((resolve,reject)=>{this.pendingReject=reject;this.child.stdin.write(bytes,error=>{this.pendingReject=undefined;if(error){this.fail(error);reject(error);}else if(this.failure)reject(this.failure);else resolve();});});
 }
 async start(){await this.write(this.mux.header);}
 async frame(data:Uint8Array,pts:number){
  if(this.writing)throw new Error('이전 배경 제거 프레임을 저장 중입니다.');this.writing=true;
  try{for(const part of this.mux.frame(data,pts))await this.write(part);}finally{this.writing=false;}
 }
 async finish(){
  if(this.writing)throw new Error('배경 제거 프레임 저장 후 종료하세요.');if(this.failure)throw this.failure;
  if(!this.ended){this.ended=true;this.child.stdin.end();}await this.done;if(this.failure)throw this.failure;
 }
 async close(){if(!this.closed)this.fail(new CancelledError());await this.done;}
}
