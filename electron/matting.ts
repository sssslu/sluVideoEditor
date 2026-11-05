import {muxProcessedVideo} from './processed-mux';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {MediaAsset} from '../shared/types';
import {CancelledError,probeMedia,runProcess,type EngineContext,type ProgressCallback} from './media';
import {prepareTrackingInput} from './tracking-source';
import {verifyVideoSelection} from './video-selection';
import {decodeTrackingFrames} from './tracking-decode';
import {MattingVideoEncoder} from './matting-encode';
import type {MattingModelOptions,MattingBackend,MattingFrame,MattingOutput} from './matting-model';
import {requireSourceRevision,readSourceRevision} from './source-revision';
import {assertOutputNotSource,insideDirectory,localFilePath} from './file-policy';

import type {PersonCutoutOptions} from '../shared/types';
export type {PersonCutoutOptions} from '../shared/types';
export interface PersonCutoutEngine {readonly backend:MattingBackend;process(frame:MattingFrame,pts:number):Promise<MattingOutput>;close():Promise<void>}
export interface PersonCutoutContext extends EngineContext {
 derivedDir?:string;createMatting:(options:Pick<MattingModelOptions,'backend'|'quality'>,signal?:AbortSignal)=>Promise<PersonCutoutEngine>;
}

/** Derives a reversible, lossless transparent source. The input clip/effects
 * are untouched. Source-native frames are processed once, in presentation
 * order. An internal NUT pipe preserves microsecond PTS; final FFV1/PCM MOV
 * preserves edge RGB/alpha, VFR timing and the exact final held-frame duration.
 * Browser playback requires the existing transparent WebM proxy workflow. */
export async function removePersonBackground(media:MediaAsset,options:PersonCutoutOptions,ctx:PersonCutoutContext,progress?:ProgressCallback,signal?:AbortSignal):Promise<MediaAsset>{
 const abort=()=>{if(signal?.aborted)throw new CancelledError();};abort();
 if(!options||!Number.isFinite(options.start)||!Number.isFinite(options.duration)||options.start<0||options.duration<.001||options.start+options.duration>864000||!['auto','cpu','gpu'].includes(options.device??'auto')||!['portrait','fullbody','precision'].includes(options.quality??'portrait'))throw new Error('배경 제거 구간 또는 설정이 올바르지 않습니다.');
 const settings={...options};
 // Reuse the tested native presentation clock, rotation/SAR and SDR decoder.
 // Translate its contextual errors; cancellation/source-revision errors retain
 // their type. Alpha inputs need original-alpha multiplication, not flattening.
 const source=await prepareTrackingInput(media,4096,ctx,signal).catch(error=>{if(error instanceof Error)error.message=error.message.replaceAll('객체 추적','배경 제거').replaceAll('추적','배경 제거');throw error;});
 const {plan,revision}=source;
 if(source.hasAlpha)throw new Error('이미 투명도가 있는 영상의 AI 배경 제거는 아직 지원하지 않습니다.');
 const selection=await verifyVideoSelection({...plan,revision,probe:source.probe},settings.start,settings.duration,ctx,signal);
 const {startPts:at,endPts:until,firstPts:first}=selection;
 const directory=path.resolve(ctx.derivedDir||path.join(ctx.cacheDir,'derived'));if(!localFilePath(directory))throw new Error('배경 제거 저장 폴더가 올바르지 않습니다.');await fs.mkdir(directory,{recursive:true});
 const work=await fs.mkdtemp(path.join(directory,'.cutout-')),target=path.join(directory,`cutout-${randomUUID()}.mov`),video=path.join(work,'video.nut'),temporary=path.join(work,'output.mov');
 let encoder:MattingVideoEncoder|undefined,engine:PersonCutoutEngine|undefined,published=false,complete=false,frameCount=0,last=-1,lastProgress=0;
 const notify=(value:number,message:string)=>{lastProgress=Math.max(lastProgress,Math.min(1,value));try{progress?.(lastProgress,message);}catch{}};
 const unchanged=async()=>{abort();await requireSourceRevision(media.path,revision);abort();};
 try{
  await assertOutputNotSource(target,[media.path]);await assertOutputNotSource(temporary,[media.path]);await unchanged();notify(0,'인물 배경 제거 준비 중');
  engine=await ctx.createMatting({backend:settings.device==='gpu'?'dml':settings.device??'auto',quality:settings.quality??'portrait'},signal);
  for await(const frame of decodeTrackingFrames(plan,first,until,ctx,signal)){
   abort();if(frame.width!==frame.sourceWidth||frame.height!==frame.sourceHeight)throw new Error('배경 제거는 현재 원본 표시 크기 4096픽셀까지 지원합니다.');
   if(!encoder){encoder=new MattingVideoEncoder(frame.width,frame.height,video,ctx,signal);await encoder.start();}
   const result=await engine.process(frame,frame.pts),pts=Math.max(0,frame.pts-at);await encoder.frame(result.data,pts);last=pts;frameCount++;
   notify(.05+.8*(pts/(until-at)),`인물 배경 제거 중 · ${result.backend==='dml'?'GPU':'CPU'}`);
  }
  if(!encoder||!frameCount||last<0||until-at<=last)throw new Error('배경 제거할 영상 프레임을 찾지 못했습니다.');
  await engine.close();engine=undefined;await encoder.finish();await encoder.close();encoder=undefined;await unchanged();
  notify(.88,'투명 영상과 오디오 저장 중');
  // Decode audio from the original beginning: seeking into AAC changes decoder
  // state. Trim absolute sample times, preserve channels and delays with PCM.
  // A valid selection can lie entirely before or after a source audio track.
  // Observe the samples that actually reach its encoder after trimming, using
  // the existing mux pass and a bounded text buffer rather than another decode.
  // Keep an otherwise-empty track's ordinal slot with one zero sample at PTS0.
  // Nonempty tracks keep every original sample and their existing start delay.
  // Dropping the empty first track would make another track audible in preview.
  const audioSamples=await muxProcessedVideo({video,source:media.path,output:temporary,startPts:at,endPts:until,lastPts:last,frameCount},ctx,signal);
  await unchanged();const result=await probeMedia(temporary,ctx,signal,{derivatives:false});
  if(result.kind!=='video'||!result.hasAlpha||Math.abs(result.duration-settings.duration)>.002||result.hasAudio!==audioSamples)throw new Error('배경 제거 영상의 투명도, 길이 또는 오디오가 원본과 일치하지 않습니다.');
  const count=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-count_packets','-select_streams','v:0','-show_entries','stream=nb_read_packets','-of','json',temporary],{signal,timeoutMs:120000})).stdout.toString()).streams?.[0]?.nb_read_packets;
  if(Number(count)!==frameCount)throw new Error('배경 제거 영상의 프레임 수가 일치하지 않습니다.');
  await unchanged();await fs.link(temporary,target);published=true;await unchanged();await fs.unlink(temporary);
  const output={...result,path:target,name:`${media.name} · 배경 제거`,sourceRevision:await readSourceRevision(target)};await unchanged();complete=true;notify(1,'배경 제거 완료');return output;
 }finally{
  await Promise.allSettled([engine?.close(),encoder?.close()]);
  if(published&&!complete)await fs.rm(target,{force:true}).catch(()=>{});
  const actualWork=await fs.realpath(work).catch(()=>undefined),actualDirectory=await fs.realpath(directory).catch(()=>undefined);
  if(actualWork&&actualDirectory&&insideDirectory(actualWork,actualDirectory))await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
 }
}
