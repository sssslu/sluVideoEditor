import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {constants,setPriority} from 'node:os';
import {CancelledError,runProcess,type EngineContext,type ProgressCallback} from './media';
import {localFilePath} from './file-policy';
import {sourceRevisionFromStat} from './source-revision';

/** Half-open presented-video interval in the same clock as input -ss (without
 * seek_timestamp/copyts). Audio/container duration is not evidence of video. */
export interface VideoRange {videoStart:number;videoEnd:number}
export interface VideoRangeOptions {
  /** Reuse the metadata already read by probeMedia. */
  probe?:unknown;
  /** False never starts a full decode; unresolved ranges remain undefined. */
  allowScan?:boolean;
  /** For verification: bypass both the metadata shortcut and cached results. */
  forceScan?:boolean;
  progress?:ProgressCallback;
}
interface Stream {
  index?:unknown;codec_type?:unknown;start_pts?:unknown;start_time?:unknown;
  duration_ts?:unknown;time_base?:unknown;avg_frame_rate?:unknown;r_frame_rate?:unknown;nb_frames?:unknown;
  disposition?:{attached_pic?:unknown};
}
interface Probe {streams?:Stream[];format?:{format_name?:unknown;start_time?:unknown;duration?:unknown}}
const schema=2;
const maximumTime=864000;
const finite=(value:unknown):number|undefined=>{
  if((typeof value!=='number'&&typeof value!=='string')||value==='')return undefined;
  const number=Number(value);return Number.isFinite(number)?number:undefined;
};
const integer=(value:unknown)=>{const number=finite(value);return number!==undefined&&Number.isSafeInteger(number)?number:undefined;};
const rational=(value:unknown)=>{
  if(typeof value!=='string'||!/^\d+\/\d+$/.test(value))return undefined;
  const [numerator,denominator]=value.split('/').map(Number);
  return Number.isSafeInteger(numerator)&&Number.isSafeInteger(denominator)&&numerator>0&&denominator>0?numerator/denominator:undefined;
};
function probeParts(value:unknown){
  if(!value||typeof value!=='object')return undefined;
  const probe=value as Probe;
  const video=Array.isArray(probe.streams)?probe.streams.find(stream=>stream&&stream.codec_type==='video'&&!stream.disposition?.attached_pic):undefined;
  if(!video)return undefined;
  const index=integer(video.index),timeBase=rational(video.time_base),origin=finite(probe.format?.start_time)??0;
  if(index===undefined||index<0||timeBase===undefined||Math.abs(origin)>maximumTime)return undefined;
  return {probe,video,index,timeBase,origin};
}
function normalized(start:number,end:number,origin:number):VideoRange|undefined {
  // Preroll before source clock zero is unavailable to the existing -ss path.
  const videoStart=Math.max(0,start-origin),videoEnd=end-origin;
  if(!Number.isFinite(videoStart)||!Number.isFinite(videoEnd)||videoEnd<=videoStart||videoEnd>maximumTime)return undefined;
  return {videoStart:Number(videoStart.toFixed(9)),videoEnd:Number(videoEnd.toFixed(9))};
}
const validRange=(value:unknown):value is VideoRange=>{
  const range=value as VideoRange|undefined;
  return !!range&&Number.isFinite(range.videoStart)&&Number.isFinite(range.videoEnd)&&range.videoStart>=0&&range.videoEnd>range.videoStart&&range.videoEnd<=maximumTime;
};
const aborted=(signal?:AbortSignal)=>{if(signal?.aborted)throw new CancelledError();};
async function fingerprint(file:string,ctx:EngineContext){
  if(!localFilePath(file))throw new Error('영상 시각 분석에는 로컬 파일이 필요합니다.');
  const sourceStat=await fs.stat(file);if(!sourceStat.isFile())throw new Error('영상 파일을 찾을 수 없습니다.');
  const binaryStat=await fs.stat(ctx.ffprobe);
  const key=createHash('sha256').update(`${schema}|${sourceRevisionFromStat(file,sourceStat)}|${ctx.ffprobe}|${binaryStat.size}|${binaryStat.mtimeMs}`).digest('hex');
  return {sourceStat,key,cache:path.join(ctx.cacheDir,`video-range-${key}.json`)};
}
async function readRangeCache(cache:string,key:string):Promise<VideoRange|undefined>{
  try{const saved=JSON.parse(await fs.readFile(cache,'utf8'));if(saved.schema===schema&&saved.key===key&&validRange(saved.range))return saved.range;}catch{}
}
/** No probe process is launched. Lets normal media cache hits reuse an exact
 * range completed by a separate user-requested/background scan. */
export async function cachedVideoRange(file:string,ctx:EngineContext,signal?:AbortSignal):Promise<VideoRange|undefined>{
  aborted(signal);const {cache,key}=await fingerprint(file,ctx),range=await readRangeCache(cache,key);aborted(signal);return range;
}

/** Fast path is intentionally narrow. MP4/MOV CFR sample tables must agree on
 * nominal/average rate, sample count and exact track duration. VFR and edit-list
 * discrepancies require decoded frames: an actual VFR MP4 reported 1.800s in
 * both stream/format duration while its final presented frame ended at 2.040s.
 * No bitrate-based duration, stream tag, audio duration or FPS tail guess is used. */
export function videoRangeFromProbe(value:unknown):VideoRange|undefined {
  const parts=probeParts(value);if(!parts)return undefined;
  const {probe,video,timeBase,origin}=parts;
  if(typeof probe.format?.format_name!=='string'||!probe.format.format_name.split(',').includes('mov'))return undefined;
  const start=integer(video.start_pts),duration=integer(video.duration_ts),frames=integer(video.nb_frames);
  const average=rational(video.avg_frame_rate),nominal=rational(video.r_frame_rate);
  if(start===undefined||duration===undefined||duration<=0||frames===undefined||frames<=0||!average||!nominal||nominal>1000)return undefined;
  if(Math.abs(average-nominal)>1e-9*Math.max(average,nominal))return undefined;
  if(Math.abs(duration*timeBase-frames/nominal)>Math.max(timeBase*.51,1e-7))return undefined;
  return normalized(start*timeBase,(start+duration)*timeBase,origin);
}

/** Small streaming reducer; it never stores a frame array. Exported for parser
 * regression tests with fragmented pipe chunks and missing duration fields. */
export class VideoFrameRangeReader {
  private pending='';
  private first=Infinity;
  private last=-Infinity;
  private end=-Infinity;
  private lastDurationKnown=false;
  private invalid=false;
  frames=0;
  peakPendingBytes=0;
  constructor(private readonly timeBase:number,private readonly origin:number){}
  push(chunk:Buffer|string){
    this.pending+=chunk.toString();
    // ffprobe numeric frame records are short. A malformed/injected record must
    // not accumulate without bound, including when a pipe chunk has no newline.
    let newline:number;
    while((newline=this.pending.indexOf('\n'))>=0){
      const line=this.pending.slice(0,newline).replace(/\r$/,'');this.pending=this.pending.slice(newline+1);
      if(line.length>4096)throw new Error('영상 시각 분석 레코드가 너무 깁니다.');
      this.line(line);
    }
    this.peakPendingBytes=Math.max(this.peakPendingBytes,this.pending.length);
    if(this.pending.length>4096)throw new Error('영상 시각 분석 레코드가 너무 깁니다.');
  }
  private line(line:string){
    if(!line.startsWith('frame|'))return;
    const values=Object.fromEntries(line.split('|').slice(1).map(part=>{const equal=part.indexOf('=');return equal<0?[part,'']:[part.slice(0,equal),part.slice(equal+1)];}));
    const timestamp=integer(values.best_effort_timestamp)??integer(values.pts),duration=integer(values.duration);
    this.frames++;
    if(timestamp===undefined){this.invalid=true;return;}
    const pts=timestamp*this.timeBase;
    this.first=Math.min(this.first,pts);
    if(pts>this.last){this.last=pts;this.lastDurationKnown=duration!==undefined&&duration>0;}
    else if(pts===this.last&&duration!==undefined&&duration>0)this.lastDurationKnown=true;
    if(duration!==undefined&&duration>0)this.end=Math.max(this.end,(timestamp+duration)*this.timeBase);
  }
  finish():VideoRange|undefined {
    if(this.pending){this.line(this.pending.replace(/\r$/,''));this.pending='';}
    if(this.invalid||!this.frames||!this.lastDurationKnown||this.end<=this.last)return undefined;
    return normalized(this.first,this.end,this.origin);
  }
  presentedTime(){return Number.isFinite(this.last)?Math.max(0,this.last-this.origin):0;}
}

/** Full frame decode is cancellable and runs below normal priority with one
 * decoder thread. Only call it in a background analysis job or on request.
 * Completion cache is keyed by source stat, ffprobe stat and algorithm version;
 * aborted/uncertain scans are never cached as usable ranges. Concurrent callers
 * own their processes/signals independently. */
export async function probeVideoRange(file:string,ctx:EngineContext,signal?:AbortSignal,options:VideoRangeOptions={}):Promise<VideoRange|undefined> {
  aborted(signal);
  const {sourceStat,key,cache}=await fingerprint(file,ctx);
  if(!options.forceScan){const saved=await readRangeCache(cache,key);if(saved){aborted(signal);return saved;}}
  let probe=options.probe;
  if(!probe){
    const metadata=await runProcess(ctx.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-show_entries',
      'format=format_name,start_time,duration:stream=index,codec_type,start_pts,start_time,duration_ts,time_base,avg_frame_rate,r_frame_rate,nb_frames:stream_disposition=attached_pic','-of','json',file],{signal,timeoutMs:60000,maxOutputBytes:2*1024*1024});
    probe=JSON.parse(metadata.stdout.toString());
  }
  const parts=probeParts(probe);if(!parts)return undefined;
  let range=options.forceScan?undefined:videoRangeFromProbe(probe),method=range?'stream-cfr':'decoded-frames';
  const diagnostic=(event:Record<string,unknown>)=>{try{ctx.diagnostics?.(event);}catch{}};
  const progress=(value:number,message:string)=>{try{options.progress?.(value,message);}catch{}};
  if(!range){
    if(options.allowScan===false)return undefined;
    const reader=new VideoFrameRangeReader(parts.timeBase,parts.origin),control=new AbortController();
    const combined=signal?AbortSignal.any([signal,control.signal]):control.signal;
    let parseError:unknown,timedOut=false,idle:ReturnType<typeof setTimeout>|undefined,lastProgress=0;
    const reset=()=>{if(idle)clearTimeout(idle);idle=setTimeout(()=>{timedOut=true;control.abort();},180000);idle.unref();};
    const duration=finite(parts.probe.format?.duration)??0;
    progress(0,'영상의 실제 시작·끝 프레임 확인 중');reset();
    try{
      const result=await runProcess(ctx.ffprobe,['-v','error','-threads','1','-err_detect','explode','-protocol_whitelist','file,pipe','-select_streams',String(parts.index),
        '-show_frames','-show_entries','frame=pts,best_effort_timestamp,duration:frame_side_data=','-of','compact=p=1:nk=0',file],{
          signal:combined,captureStdout:false,onSpawn:pid=>{try{setPriority(pid,constants.priority.PRIORITY_BELOW_NORMAL);}catch{}queueMicrotask(()=>diagnostic({event:'video-range-process',pid}));},
          onStderr:reset,onStdout:data=>{reset();try{reader.push(data);const value=duration>0?Math.min(.99,reader.presentedTime()/duration):0;if(value-lastProgress>=.01){lastProgress=value;progress(value,'영상의 실제 시작·끝 프레임 확인 중');}}catch(error){parseError=error;control.abort();}}
        });
      if(result.stderr.trim())throw new Error(`영상 프레임을 정확히 확인할 수 없습니다.\n${result.stderr.trim()}`);
      range=reader.finish();diagnostic({event:'video-range-scan',frames:reader.frames,peakPendingBytes:reader.peakPendingBytes,range});
    }catch(error){if(parseError)throw parseError;if(timedOut&&!signal?.aborted)throw new Error('영상 시각 분석이 3분 동안 응답하지 않아 중단했습니다.');throw error;}
    finally{if(idle)clearTimeout(idle);}
  }
  aborted(signal);
  const after=await fs.stat(file);
  if(sourceRevisionFromStat(file,after)!==sourceRevisionFromStat(file,sourceStat))throw new Error('분석 중 영상 파일이 변경되었습니다. 다시 확인해 주세요.');
  if(range){
    const temporary=`${cache}.${randomUUID()}.tmp`;
    try{await fs.mkdir(ctx.cacheDir,{recursive:true});await fs.writeFile(temporary,JSON.stringify({schema,key,range,method}),'utf8');aborted(signal);await fs.rename(temporary,cache);}catch(error){if(signal?.aborted)throw new CancelledError();/* Cache failure does not invalidate measured frames. */}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
    progress(1,'영상 시작·끝 프레임 확인 완료');
  }
  return range;
}
