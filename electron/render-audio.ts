import {continuousAudioGroups} from '../shared/audio-continuity';
import {AudioEQProcessor} from '../shared/audio-eq';
import {spawn} from 'node:child_process';
import path from 'node:path';
import type {Clip,MediaAsset,Project} from '../shared/types';
import {clipEnvelope} from '../shared/project';
import {audioTrackEnabled} from '../shared/effects';
import {clipSourceTime} from '../shared/speed';
import {compileTransitions,transitionGain,type TransitionPlan} from '../shared/transitions';
import {CurveAudioSource,type AudioRenderRange} from './render-speed-audio';
import {ffmpegSeconds} from './ffmpeg-time';

export interface AudioDiagnostic {event:'audio-start'|'audio-end'|'audio-chunk';pid?:number;clipId:string;role?:'decoder'|'stretch';inputFrames?:number;outputFrames?:number;bufferBytes?:number;engine?:number}
const RATE=48000,CHANNELS=2,BYTES=4;
function tempo(speed:number){const filters:string[]=[];while(speed>2){filters.push('atempo=2');speed/=2;}while(speed<.5){filters.push('atempo=0.5');speed/=.5;}if(Math.abs(speed-1)>1e-8)filters.push(`atempo=${speed}`);return filters;}

/** One decoder per currently active audio clip. Its atempo state survives
 * video-window boundaries; bounded stdout backpressure prevents eager decode. */
class AudioSource {
  private child:ReturnType<typeof spawn>;
  private iterator:AsyncIterator<Buffer>;
  private pending:Buffer=Buffer.alloc(0);
  private eof=false;private error?:Error;private stderr='';private detachAbort:()=>void;
  private closed:Promise<void>;
  position=0;
  constructor(ffmpeg:string,clip:Clip,media:MediaAsset,signal:AbortSignal,diagnostic?:(event:AudioDiagnostic)=>void,range:AudioRenderRange={from:0,to:clip.duration}){
    const args=['-hide_banner','-loglevel','error','-nostdin','-threads','1','-ss',ffmpegSeconds(clipSourceTime(clip,range.from)),'-t',ffmpegSeconds((range.to-range.from)*clip.speed),'-protocol_whitelist','file,pipe','-i',media.path,'-map','0:a:0','-vn','-af',['aresample=48000:async=1:first_pts=0',...tempo(clip.speed),'aformat=sample_fmts=fltp:channel_layouts=stereo'].join(','),'-c:a','pcm_f32le','-ar','48000','-ac','2','-f','f32le','pipe:1'];
    this.child=spawn(ffmpeg,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});this.iterator=this.child.stdout![Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    diagnostic?.({event:'audio-start',pid:this.child.pid,clipId:clip.id});
    this.child.stderr!.on('data',(data:Buffer)=>{this.stderr=(this.stderr+data.toString()).slice(-8000);});
    this.child.on('error',error=>{this.error=error;});
    this.closed=new Promise((resolve,reject)=>this.child.on('close',code=>{diagnostic?.({event:'audio-end',pid:this.child.pid,clipId:clip.id});if(this.error)reject(this.error);else if(code!==0)reject(new Error(`오디오 디코딩에 실패했습니다.\n${this.stderr}`));else resolve();}));void this.closed.catch(()=>{});
    const abort=()=>{this.error=Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError'});this.child.kill();this.child.stdout?.destroy(this.error);};signal.addEventListener('abort',abort,{once:true});this.detachAbort=()=>signal.removeEventListener('abort',abort);if(signal.aborted)abort();
  }
  async read(frames:number):Promise<Buffer>{
    const bytes=frames*CHANNELS*BYTES,out=Buffer.alloc(bytes);let offset=0;
    while(offset<bytes){
      if(this.pending.length){const size=Math.min(bytes-offset,this.pending.length);this.pending.copy(out,offset,0,size);this.pending=this.pending.subarray(size);offset+=size;continue;}
      if(this.eof)break;
      const next=await this.iterator.next();if(next.done){this.eof=true;await this.closed;break;}this.pending=next.value;
    }
    this.position+=frames;return out;
  }
  async close(){this.detachAbort();this.child.stdout?.destroy();this.child.kill();await this.closed.catch(()=>{});}
}

type AudioItem={clip:Clip;media:MediaAsset;start:number;end:number;originalStart:number;range:AudioRenderRange;hasTransitions:boolean};
export class TimelineAudioMixer {
  private sources=new Map<string,{item:AudioItem;source:AudioSource|CurveAudioSource;eq:AudioEQProcessor}>();
  private clips:AudioItem[];
  private transitionPlan:TransitionPlan;
  private cursor=0;private previousEnd=0;
  peakActiveSources=0;
  constructor(private project:Project,private ffmpeg:string,private signal:AbortSignal,private diagnostic?:(event:AudioDiagnostic)=>void,private audioStretch=path.join(path.dirname(ffmpeg),'slu-audio-stretch.exe'),transitionPlan?:TransitionPlan){
    const tracks=new Map(project.tracks.map(t=>[t.id,t])),media=new Map(project.media.map(m=>[m.id,m]));
    this.transitionPlan=transitionPlan||compileTransitions(project);
    const audible=project.clips.filter(c=>c.text===undefined&&c.volume>0&&media.get(c.mediaId||'')?.hasAudio&&audioTrackEnabled(project,tracks.get(c.trackId)));
    const transitionIds=new Set(this.transitionPlan.transitions.flatMap(t=>[t.from.id,t.to.id]));
    this.clips=continuousAudioGroups(audible,transitionIds).map(({clip,members})=>{const exposure=this.transitionPlan.byClip.get(clip.id)!,range=members.length>1?{from:0,to:clip.duration}:{from:exposure.audioFrom,to:exposure.audioTo};return {clip,media:media.get(clip.mediaId!)!,start:Math.round((clip.start+range.from)*RATE),end:Math.round((clip.start+range.to)*RATE),originalStart:Math.round(clip.start*RATE),range,hasTransitions:exposure.transitions.length>0};}).sort((a,b)=>a.start-b.start);
  }
  async mix(start:number,frames:number):Promise<Buffer>{
    if(this.signal.aborted)throw Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError'});
    if(start<this.previousEnd)throw new Error('오디오 구간 순서가 올바르지 않습니다.');
    const end=start+frames,output=Buffer.alloc(frames*CHANNELS*BYTES);
    for(const [id,{item,source}] of this.sources){if(item.end<=start){await source.close();this.sources.delete(id);}}
    // Each clip is visited once when its start enters the forward-only render.
    // Work per PCM block depends on simultaneous clips, not total project size.
    while(this.cursor<this.clips.length&&this.clips[this.cursor].start<end){const item=this.clips[this.cursor++];if(item.end<=start)continue;this.sources.set(item.clip.id,{item,eq:new AudioEQProcessor(item.clip.audioEQ,RATE,CHANNELS),source:item.clip.speedCurve?new CurveAudioSource(this.ffmpeg,this.audioStretch,item.clip,item.media,this.signal,this.diagnostic,item.range):new AudioSource(this.ffmpeg,item.clip,item.media,this.signal,this.diagnostic,item.range)});}
    this.peakActiveSources=Math.max(this.peakActiveSources,this.sources.size);
    for(const {item,source,eq} of this.sources.values()){
      const {clip,media}=item,begin=Math.max(start,item.start),finish=Math.min(end,item.end),count=finish-begin;
      const localStart=begin-item.start;
      if(source.position>localStart)throw new Error('오디오 구간 순서가 올바르지 않습니다.');
      // Sequential exports normally require no skip. This also supports a
      // partial-range render without retaining unbounded discarded PCM.
      const process=(samples:Buffer)=>{if(eq.active)eq.process(new Float32Array(samples.buffer,samples.byteOffset,samples.length/4));return samples;};
      while(source.position<localStart)process(await source.read(Math.min(4096,localStart-source.position)));
      const samples=process(await source.read(count)),envelope=clipEnvelope(clip),outputStart=(begin-start)*CHANNELS*BYTES;
      for(let i=0;i<count;i++){
        const time=(begin+i-item.originalStart)/RATE+envelope.time;
        const gain=clip.volume*Math.min(1,clip.fadeIn?Math.max(0,time/clip.fadeIn):1,clip.fadeOut?Math.max(0,(envelope.duration-time)/clip.fadeOut):1)*(item.hasTransitions?transitionGain(this.transitionPlan,clip.id,(begin+i)/RATE):1);
        const inputOffset=i*CHANNELS*BYTES,outOffset=outputStart+inputOffset;
        for(let channel=0;channel<CHANNELS;channel++){const pos=channel*BYTES;const value=samples.readFloatLE(inputOffset+pos);output.writeFloatLE(output.readFloatLE(outOffset+pos)+(Number.isFinite(value)?value:0)*gain,outOffset+pos);}
      }
    }
    this.previousEnd=end;return output;
  }
  async close(){await Promise.all([...this.sources.values()].map(({source})=>source.close()));this.sources.clear();}
}

export const AUDIO_RATE=RATE;
