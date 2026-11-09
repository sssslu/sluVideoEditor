import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import type {Clip,MediaAsset} from '../shared/types';
import {clipSourceOffset,clipTimelineTime,clipSpeedAt} from '../shared/speed';
import type {AudioDiagnostic} from './render-audio';
import {ffmpegSeconds} from './ffmpeg-time';

const RATE=48000,BYTES=8,BLOCK=4096;
const abortError=()=>Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError'});
export interface AudioRenderRange {from:number;to:number}

/** Bounded binary pipe reader. Decoder EOF can be padded with silence; a native
 * worker EOF is always an error because each request has an exact response size. */
class PcmProcess {
  child:ReturnType<typeof spawn>;
  private iterator:AsyncIterator<Buffer>;private pending:Buffer=Buffer.alloc(0);private eof=false;
  private closed:Promise<void>;private error?:Error;private stderr='';
  constructor(executable:string,args:string[],private padEof:boolean,clipId:string,role:'decoder'|'stretch',diagnostic?:(event:AudioDiagnostic)=>void){
    this.child=spawn(executable,args,{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
    this.iterator=this.child.stdout![Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    this.child.stdin!.on('error',()=>{});this.child.stderr!.on('data',(data:Buffer)=>{this.stderr=(this.stderr+data.toString()).slice(-12000);});this.child.on('error',error=>{this.error=error;});
    diagnostic?.({event:'audio-start',pid:this.child.pid,clipId,role});
    this.closed=new Promise((resolve,reject)=>this.child.on('close',code=>{diagnostic?.({event:'audio-end',pid:this.child.pid,clipId,role});if(this.error)reject(this.error);else if(code!==0)reject(new Error(`속도 곡선 오디오 처리에 실패했습니다 (${code}).\n${this.stderr}`));else resolve();}));void this.closed.catch(()=>{});
  }
  async read(frames:number){
    const output=Buffer.alloc(frames*BYTES);let at=0;
    while(at<output.length){
      if(this.pending.length){const count=Math.min(this.pending.length,output.length-at);this.pending.copy(output,at,0,count);this.pending=this.pending.subarray(count);at+=count;continue;}
      if(this.eof){if(!this.padEof)throw new Error('속도 곡선 오디오 응답이 불완전합니다.');break;}
      const next=await this.iterator.next();if(next.done){this.eof=true;await this.closed;continue;}this.pending=next.value;
    }
    return output;
  }
  write(data:Buffer){return new Promise<void>((resolve,reject)=>this.child.stdin!.write(data,error=>error?reject(error):resolve()));}
  get bufferedBytes(){return this.pending.length;}
  wait(){return this.closed;}
  end(){this.child.stdin?.end();}
  async close(){this.child.stdin?.destroy();this.child.stdout?.destroy();this.child.kill();await this.closed.catch(()=>{});}
}

/** One decoder and one continuous offline R3 phase-vocoder per active curve.
 * PCM input/output are streamed with backpressure. The native exact source-time
 * map runs at every FFT analysis hop, with no independent chunk joins. */
export class CurveAudioSource {
  private decoder:PcmProcess;private stretcher:PcmProcess;private detachAbort:()=>void;
  private pump:Promise<void>;private failure?:Error;private total:number;
  position=0;
  constructor(ffmpeg:string,helper:string,private clip:Clip,media:MediaAsset,private signal:AbortSignal,private diagnostic?:(event:AudioDiagnostic)=>void,range:AudioRenderRange={from:0,to:clip.duration}){
    if(!existsSync(helper))throw new Error('속도 곡선 오디오 처리 프로그램(slu-audio-stretch.exe)이 없습니다. 앱을 복구하거나 다시 설치해 주세요.');
    if(!Number.isFinite(range.from)||!Number.isFinite(range.to)||range.from< -86400||range.to>86400||range.to<=range.from||range.to-range.from>86400)throw new Error('오디오 렌더링 구간이 유효하지 않습니다.');
    this.total=Math.round((range.to-range.from)*RATE);
    const firstSpeed=clipSpeedAt(clip,range.from),lastSpeed=clipSpeedAt(clip,range.to);
    const sourceFrom=Math.round((clipSourceOffset(clip,range.from)-Math.max(.2,.25*firstSpeed))*RATE),sourceTo=Math.round((clipSourceOffset(clip,range.to)+Math.max(.2,.25*lastSpeed))*RATE);
    const inputFrames=sourceTo-sourceFrom,sourceOffset=sourceFrom/RATE,timelineFrom=clipTimelineTime(clip,clip.in+sourceOffset),timelineTo=clipTimelineTime(clip,clip.in+sourceTo/RATE);
    const outputFrames=Math.round((timelineTo-timelineFrom)*RATE),cropStart=Math.round((range.from-timelineFrom)*RATE);
    const start=clip.in+sourceOffset,end=clip.in+sourceTo/RATE,actualStart=Math.max(0,start),actualEnd=Math.min(media.duration,end),leading=Math.round((actualStart-start)*RATE);
    this.decoder=new PcmProcess(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-threads','1','-ss',ffmpegSeconds(actualStart),'-t',ffmpegSeconds(Math.max(1/RATE,actualEnd-actualStart)),'-protocol_whitelist','file,pipe','-i',media.path,'-map','0:a:0','-vn','-af','aresample=48000:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo','-c:a','pcm_f32le','-ar',String(RATE),'-ac','2','-f','f32le','pipe:1'],true,clip.id,'decoder',diagnostic);
    this.stretcher=new PcmProcess(helper,[],false,clip.id,'stretch',diagnostic);
    const abort=()=>{void this.decoder.close();void this.stretcher.close();};signal.addEventListener('abort',abort,{once:true});this.detachAbort=()=>signal.removeEventListener('abort',abort);
    const points=clip.speedCurve!;
    const header=Buffer.from(`SLURB3 ${inputFrames} ${outputFrames} ${cropStart} ${this.total} ${points.length} ${clip.duration} ${sourceOffset} ${range.from} ${range.to}\n${points.map(point=>`${point.position} ${point.speed}\n`).join('')}`);
    const decoder=this.decoder,stretcher=this.stretcher;
    this.pump=(async()=>{
      await stretcher.write(header);
      for(let at=0;at<inputFrames;){
        if(signal.aborted)throw abortError();
        const count=Math.min(BLOCK,inputFrames-at,at<leading?leading-at:Infinity);
        await stretcher.write(at<leading?Buffer.alloc(count*BYTES):await decoder.read(count));at+=count;
      }
      stretcher.end();
    })().catch(error=>{this.failure=error instanceof Error?error:new Error(String(error));void this.stretcher.close();void this.decoder.close();throw this.failure;});void this.pump.catch(()=>{});
    if(signal.aborted)abort();
  }
  async read(frames:number){
    try{
      if(this.signal.aborted)throw abortError();if(this.failure)throw this.failure;
      const count=Math.min(frames,Math.max(0,this.total-this.position)),pcm=await this.stretcher.read(count);
      const output=count===frames?pcm:Buffer.concat([pcm,Buffer.alloc((frames-count)*BYTES)]);
      this.position+=frames;
      if(this.position>=this.total){await this.pump;await this.stretcher.wait();}
      this.diagnostic?.({event:'audio-chunk',clipId:this.clip.id,inputFrames:BLOCK,outputFrames:count,bufferBytes:this.decoder.bufferedBytes+this.stretcher.bufferedBytes+BLOCK*BYTES+output.length,engine:3});
      return output;
    }catch(error){if(this.signal.aborted)throw abortError();throw this.failure||error;}
  }
  async close(){this.detachAbort();await Promise.all([this.decoder.close(),this.stretcher.close()]);await this.pump.catch(()=>{});}
}
