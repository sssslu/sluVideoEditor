import {spawn} from 'node:child_process';
import type {Clip,MediaAsset,Project} from '../shared/types';
import {projectDuration} from '../shared/project';
import {compileTransitions,type TransitionPlan} from '../shared/transitions';
import {LOUDNESS_TARGET,LOUDNESS_PEAK,loudnessSelection,matchedVolume,type LoudnessItem,type LoudnessResult} from '../shared/loudness';
import {TimelineAudioMixer,AUDIO_RATE} from './render-audio';
import {requireSourceRevision} from './source-revision';
import type {EngineContext,ProgressCallback} from './media';

const cancelled=()=>Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError'});

async function measureClip(project:Project,clip:Clip,media:MediaAsset,projectEnd:number,plan:TransitionPlan,ctx:EngineContext,progress:ProgressCallback,signal:AbortSignal):Promise<LoudnessItem>{
  if(signal.aborted)throw cancelled();
  const clipId=clip.id,range=plan.byClip.get(clipId)!;
  const first=Math.max(0,Math.round((clip.start+range.audioFrom)*AUDIO_RATE)),last=Math.min(projectEnd,Math.round((clip.start+range.audioTo)*AUDIO_RATE));
  if(last-first<Math.ceil(.4*AUDIO_RATE))return {clipId,skip:'short'};
  const control=new AbortController();let failure:Error|undefined,stderr='',written=0;
  const fail=(error:Error)=>{failure??=error;control.abort();};
  const abort=()=>fail(cancelled());signal.addEventListener('abort',abort,{once:true});
  const mixer=new TimelineAudioMixer({...project,clips:[clip],media:[media]},ctx.ffmpeg,control.signal,event=>ctx.diagnostics?.({...event}),ctx.audioStretch,plan);
  const child=spawn(ctx.ffmpeg,['-hide_banner','-loglevel','info','-nostats','-nostdin','-threads','1','-filter_threads','1','-protocol_whitelist','pipe','-f','f32le','-ar',String(AUDIO_RATE),'-ac','2','-i','pipe:0','-af',`loudnorm=I=${LOUDNESS_TARGET}:TP=${LOUDNESS_PEAK}:LRA=11:print_format=json`,'-f','null','-'],{windowsHide:true,shell:false,stdio:['pipe','ignore','pipe']});
  const terminate=()=>{child.stdin.destroy();child.kill();};control.signal.addEventListener('abort',terminate,{once:true});
  const closed=new Promise<number|null>(resolve=>child.once('close',code=>{ctx.diagnostics?.({event:'loudness-end',clipId,pid:child.pid,code,inputFrames:written});resolve(code);}));
  child.on('error',fail);child.stdin.on('error',fail);
  child.stderr.on('data',(data:Buffer)=>{stderr=(stderr+data.toString()).slice(-32000);});
  if(child.pid)ctx.diagnostics?.({event:'loudness-start',clipId,pid:child.pid,firstFrame:first,lastFrame:last});
  let lastProgress=0;
  try{
    if(signal.aborted)abort();
    for(let at=first;at<last;at+=4096){
      if(failure)throw failure;
      const frames=Math.min(4096,last-at),pcm=await mixer.mix(at,frames);
      if(failure)throw failure;
      // Await each write callback: no unbounded PCM queue behind the analyzer.
      await new Promise<void>((resolve,reject)=>child.stdin.write(pcm,error=>error?reject(error):resolve()));
      written+=frames;
      if(Date.now()-lastProgress>=150){progress(written/(last-first));lastProgress=Date.now();}
    }
    child.stdin.end();const code=await closed;
    if(failure)throw failure;if(code!==0)throw new Error(`음량 분석에 실패했습니다 (${code}).\n${stderr.trim()}`);
    const json=stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
    if(!json)throw new Error('음량 측정 결과를 읽을 수 없습니다.');
    const data=JSON.parse(json) as Record<string,string>,integrated=Number(data.input_i),truePeak=Number(data.input_tp);
    if(data.input_i==='-inf'||data.input_tp==='-inf')return {clipId,skip:'silent'};
    if(!Number.isFinite(integrated)||!Number.isFinite(truePeak))throw new Error('음량 측정 결과가 올바르지 않습니다.');
    return {clipId,integrated,truePeak,...matchedVolume(clip.volume,integrated,truePeak)};
  }catch(error){fail(error instanceof Error?error:new Error(String(error)));throw failure;}
  finally{
    signal.removeEventListener('abort',abort);control.abort();
    // Cancellation and errors settle only after every owned decoder/analyzer closes.
    await Promise.all([mixer.close(),closed]);control.signal.removeEventListener('abort',terminate);
  }
}

/** Measure the selected edited ranges sequentially. Source PCM, speed processing,
 * EQ, fades and transition weights share the export mixer; no limiter is added. */
export async function measureSelectionLoudness(project:Project,ids:readonly string[],ctx:EngineContext,progress:ProgressCallback,signal:AbortSignal):Promise<LoudnessResult>{
  if(signal.aborted)throw cancelled();
  const selection=loudnessSelection(project,ids),plan=compileTransitions(project),items:LoudnessItem[]=[],revisions=new Map<string,string>(),mediaById=new Map(project.media.map(media=>[media.id,media])),projectEnd=Math.round(projectDuration(project)*AUDIO_RATE);
  for(let index=0;index<selection.length;index++){
    if(signal.aborted)throw cancelled();
    const {clip,skip}=selection[index];
    if(skip){items.push({clipId:clip.id,skip});continue;}
    const media=mediaById.get(clip.mediaId!)!;
    const revision=await requireSourceRevision(media.path,revisions.get(media.path)??media.sourceRevision);revisions.set(media.path,revision);
    const update=(fraction:number)=>progress((index+fraction)/selection.length,`음량 분석 ${index+1}/${selection.length} · ${clip.name}`);
    update(0);items.push(await measureClip(project,clip,media,projectEnd,plan,ctx,update,signal));
    await requireSourceRevision(media.path,revision);update(1);
  }
  // The first selected file may change while later clips are being measured.
  for(const [file,revision] of revisions){if(signal.aborted)throw cancelled();await requireSourceRevision(file,revision);}
  if(signal.aborted)throw cancelled();return {items};
}
