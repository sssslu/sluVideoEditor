import {RenderMotion,renderMotionMaximumScale,renderMotionRotates} from './render-motion';
import {eqFFmpegFilters} from '../shared/audio-eq';
import { spawn } from 'node:child_process';
import {setMaxListeners} from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Clip, ExportSettings, Keyframe, MediaAsset, Project } from '../shared/types';
import { clipEnvelope, interpolate, projectDuration } from '../shared/project';
import {audioTrackEnabled,visualTrackEnabled,ease,clipCrop} from '../shared/effects';
import {assertProject} from '../shared/validation';
import {RawStreamBridge} from './render-stream';
import {TimelineAudioMixer,AUDIO_RATE} from './render-audio';
import {planRenderWindows,type RenderWindow} from './render-plan';
import {assertOutputNotSource} from './file-policy';
import {replaceWithRetry} from './project-store';
import {clipSourceSpan,clipSourceTime,clipTimelineTime} from '../shared/speed';
import {speedTimelineExpression} from './render-speed';
import {compileTransitions,transitionProgress,type TransitionPlan} from '../shared/transitions';
import {appendTransitionPair,transitionOpacityCommands} from './render-transitions';
import {transitionGpuDevice,transitionOpenClSource,appendOpenClTransition} from './render-transition-gpu';
import {cachedVideoRange,probeVideoRange} from './video-range';
import {readSourceRevision,sourceRevisionFromStat} from './source-revision';
import type {CaptionRasterFactory,CaptionRasterSession} from './caption-raster-types';
import {captionLayerGroups,CaptionWindowStreams} from './render-captions';
import {RenderColorFiles} from './render-color';
import {hasColorGrade} from '../shared/color';
import {mediaTimingFromProbe} from './media-timing';
import {previewVideoColor,previewColorPrefix,type VideoColorInfo} from './video-color';
import {videoHasAlpha,videoDecoderArgs} from './video-input';
import {alphaSpatialFilters,alphaPremultiply,alphaUnpremultiply} from './alpha-filters';
import {previewProxyPath} from '../shared/media-clock';
import {proxyCacheKey,hasLegacyProxyTiming} from './proxy-cache';

export interface EngineContext { ffmpeg:string; ffprobe:string; cacheDir:string; workDir?:string; maxWindowSeconds?:number; gpuProcessing?:boolean; audioStretch?:string; captionRasterFactory?:CaptionRasterFactory; diagnostics?:(event:Record<string,unknown>)=>void }
export type ProgressCallback = (progress:number, message?:string) => void;
export interface ProcessOptions { signal?:AbortSignal; cwd?:string; env?:NodeJS.ProcessEnv; timeoutMs?:number; onStdout?:(data:Buffer)=>void; onStderr?:(data:string)=>void; captureStdout?:boolean; maxOutputBytes?:number; onSpawn?:(pid:number)=>void }
export class CancelledError extends Error { constructor(){super('작업을 취소했습니다.');this.name='AbortError';} }

/** Runs binaries directly, never through a command shell. Child windows remain hidden. */
export function runProcess(executable:string,args:string[],options:ProcessOptions={}):Promise<{stdout:Buffer;stderr:string}> {
  if(options.signal?.aborted)return Promise.reject(new CancelledError());
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{cwd:options.cwd,env:options.env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
    if(child.pid)options.onSpawn?.(child.pid);
    const chunks:Buffer[]=[]; let bytes=0,stderr='',failure:Error|undefined;
    const abort=()=>{failure=new CancelledError();child.kill();};
    options.signal?.addEventListener('abort',abort,{once:true});
    const timer=options.timeoutMs?setTimeout(()=>{failure=new Error('미디어 처리 시간이 초과되었습니다.');child.kill();},options.timeoutMs):undefined;
    child.stdout.on('data',(chunk:Buffer)=>{
      options.onStdout?.(chunk);
      if(options.captureStdout===false)return;
      bytes+=chunk.length;
      if(bytes>(options.maxOutputBytes??32*1024*1024)){failure=new Error('미디어 프로세스 출력 제한을 초과했습니다.');child.kill();return;}
      chunks.push(chunk);
    });
    child.stderr.on('data',(chunk:Buffer)=>{const value=chunk.toString();stderr=(stderr+value).slice(-24000);options.onStderr?.(value);});
    child.on('error',error=>{failure=error;});
    child.on('close',code=>{
      if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
      if(failure){reject(failure);return;}
      if(code!==0){reject(new Error(`미디어 처리에 실패했습니다 (${code}).\n${stderr.trim()}`));return;}
      resolve({stdout:Buffer.concat(chunks),stderr});
    });
  });
}

const number=(value:unknown,fallback=0)=>{const n=Number(value);return Number.isFinite(n)?n:fallback;};
const dec=(n:number)=>Number(n.toFixed(6)).toString();
const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
const isAbort=(error:unknown)=>error instanceof Error&&error.name==='AbortError';
const imageExtensions=new Set(['.png','.jpg','.jpeg','.bmp','.webp','.tif','.tiff','.avif']);
const localPath=(p:string)=>typeof p==='string'&&path.isAbsolute(p)&&!p.includes('\0')&&!/^\\\\/.test(p);
const exists=async(p:string)=>fs.access(p).then(()=>true,()=>false);

async function waveform(file:string,duration:number,ctx:EngineContext,signal?:AbortSignal):Promise<number[]> {
  const bins=320,sums=new Float64Array(bins),counts=new Uint32Array(bins);
  let index=0,pending:Buffer=Buffer.alloc(0);const sampleCount=Math.max(1,duration*8000);
  await runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file,pipe','-i',file,'-map','0:a:0','-vn','-ac','1','-ar','8000','-f','s16le','pipe:1'],{
    signal,captureStdout:false,onStdout:data=>{
      const all=pending.length?Buffer.concat([pending,data]):data;const size=all.length-all.length%2;
      for(let i=0;i<size;i+=2){const b=Math.min(bins-1,Math.floor(index++/sampleCount*bins)),v=all.readInt16LE(i)/32768;sums[b]+=v*v;counts[b]++;}
      pending=all.subarray(size);
    }
  });
  const raw=Array.from(sums,(sum,i)=>Math.sqrt(sum/Math.max(1,counts[i])));const peak=Math.max(.025,...raw);
  return raw.map(v=>Number(Math.min(1,v/peak).toFixed(4)));
}

export interface ProbeOptions {derivatives?:boolean}
export const THUMBNAIL_SUFFIX='-color-thumbnail.png';
export async function probeMedia(file:string,ctx:EngineContext,signal?:AbortSignal,options:ProbeOptions={}):Promise<MediaAsset> {
  if(!localPath(file))throw new Error('로컬 미디어 파일 경로가 필요합니다.');
  const stat=await fs.stat(file);if(!stat.isFile())throw new Error('파일을 선택해 주세요.');
  await fs.mkdir(ctx.cacheDir,{recursive:true});
  const sourceRevision=sourceRevisionFromStat(file,stat);
  const unchanged=async()=>{if(signal?.aborted)throw new CancelledError();if(await readSourceRevision(file)!==sourceRevision)throw new Error('미디어를 읽는 중 원본 파일이 변경되었습니다. 다시 가져와 주세요.');};
  const key=createHash('sha256').update(`media-source-v5|${sourceRevision}`).digest('hex').slice(0,28);
  const cache=path.join(ctx.cacheDir,`${key}.json`);
  try{const saved=JSON.parse(await fs.readFile(cache,'utf8')) as MediaAsset;const thumbnailReady=saved.thumbnail?saved.thumbnail.endsWith(THUMBNAIL_SUFFIX)&&await exists(saved.thumbnail):options.derivatives===false||saved.kind==='audio';if(saved.path===file&&saved.sourceRevision===sourceRevision&&thumbnailReady){if(saved.kind==='video'){const range=await cachedVideoRange(file,ctx,signal);if(range)Object.assign(saved,range,{duration:Math.max(saved.duration,range.videoEnd)});}await unchanged();return saved;}}catch(error){if(isAbort(error))throw error;}
  const result=await runProcess(ctx.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',file],{signal,timeoutMs:60000});
  const info=JSON.parse(result.stdout.toString());
  const video=info.streams?.find((s:any)=>s.codec_type==='video'&&!s.disposition?.attached_pic);
  const audio=info.streams?.find((s:any)=>s.codec_type==='audio');
  if(!video&&!audio)throw new Error('지원하는 영상 또는 오디오 스트림이 없습니다.');
  const isImage=Boolean(video)&&imageExtensions.has(path.extname(file).toLowerCase());
  const rate=String(video?.avg_frame_rate||video?.r_frame_rate||'0/1').split('/').map(Number);
  const rotation=number(video?.side_data_list?.find((s:any)=>s.rotation!==undefined)?.rotation??video?.tags?.rotate);
  const swap=Math.abs(rotation)%180===90;
  const clock=mediaTimingFromProbe(info);
  const media:MediaAsset={id:randomUUID(),path:file,sourceRevision,name:path.basename(file),kind:isImage?'image':video?'video':'audio',duration:isImage?5:clock.duration,timing:clock.timing,width:number(swap?video?.height:video?.width),height:number(swap?video?.width:video?.height),fps:isImage?0:(rate[1]?rate[0]/rate[1]:0),hasAudio:!!audio,hasAlpha:videoHasAlpha(video),codec:video?.codec_name||audio?.codec_name};
  if(media.kind==='video'){const range=await probeVideoRange(file,ctx,signal,{probe:info,allowScan:false});if(range)Object.assign(media,range,{duration:Math.max(media.duration,range.videoEnd)});}
  if(!isImage&&media.duration<=0)throw new Error('파일의 재생 시간을 확인할 수 없습니다.');
  if(options.derivatives===false){await unchanged();return media;}
  const derivatives:Promise<unknown>[]=[];
  if(video){
    const thumb=path.join(ctx.cacheDir,`${key}${THUMBNAIL_SUFFIX}`);
    const color=previewVideoColor(video),conversion=!isImage&&!/^(?:gbr|rgb|bgr|argb|abgr|rgba|bgra)/.test(video.pix_fmt||'')?`${previewColorPrefix(video)}scale=iw:ih:flags=bilinear+full_chroma_int+accurate_rnd:in_color_matrix=${color.matrix}:in_range=${color.range}:out_range=pc,`:'';
    // Decode video color before resizing, then mark the resulting RGB as sRGB.
    // Copying a video's BT709 transfer tag into PNG changes its displayed gamma.
    const sizing=['scale=320:180:force_original_aspect_ratio=decrease:flags=bilinear+accurate_rnd'];
    const thumbnailFilters=media.hasAlpha?alphaSpatialFilters(sizing):['format=gbrap',...sizing,'format=rgba'];
    derivatives.push(runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...(!isImage?['-ss',dec(Math.min(.25,media.duration/4))]:[]),...videoDecoderArgs(video),'-protocol_whitelist','file,pipe','-i',file,'-map','0:v:0','-frames:v','1','-vf',`${conversion}${thumbnailFilters.join(',')},setparams=range=full:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=gbr`,'-pix_fmt','rgba','-threads','1',thumb],{signal,timeoutMs:60000}).then(()=>{media.thumbnail=thumb;}));
  }
  if(audio)derivatives.push(waveform(file,media.duration,ctx,signal).then(v=>{media.waveform=v;}));
  const completed=await Promise.allSettled(derivatives);
  for(const item of completed)if(item.status==='rejected'&&isAbort(item.reason))throw item.reason;
  if(signal?.aborted)throw new CancelledError();
  // A requested range scan may have completed while the thumbnail/waveform was
  // running. Do not publish an older duration over those verified bounds.
  if(media.kind==='video'){const range=await cachedVideoRange(file,ctx,signal);if(range)Object.assign(media,range,{duration:Math.max(media.duration,range.videoEnd)});}
  await unchanged();await fs.writeFile(cache,JSON.stringify(media),'utf8');return media;
}

export async function enrichMedia(asset:MediaAsset,ctx:EngineContext,signal?:AbortSignal):Promise<MediaAsset>{
  const enriched=await probeMedia(asset.path,ctx,signal),same=asset.sourceRevision===enriched.sourceRevision,proxy=hasLegacyProxyTiming(asset)?undefined:previewProxyPath({...asset,hasAlpha:enriched.hasAlpha});return {...enriched,id:asset.id,name:same?asset.name:enriched.name,...(proxy&&same?{proxyPath:proxy}:{})};
}

const encoderCache=new Map<string,Promise<string[]>>();
export async function detectEncoders(ctx:EngineContext,signal?:AbortSignal):Promise<string[]> {
  if(signal?.aborted)throw new CancelledError();
  const previous=encoderCache.get(ctx.ffmpeg);if(previous)return previous;
  const work=(async()=>{
    const list=await runProcess(ctx.ffmpeg,['-hide_banner','-encoders'],{signal,timeoutMs:20000});
    const available=list.stdout.toString()+list.stderr;
    const software=['libx264','libx265','libsvtav1','libvpx-vp9'].filter(e=>new RegExp(`\\b${e}\\b`).test(available));
    const candidates=['h264_nvenc','hevc_nvenc','av1_nvenc','h264_qsv','hevc_qsv','av1_qsv','h264_amf','hevc_amf','av1_amf'].filter(e=>new RegExp(`\\b${e}\\b`).test(available));
    // Probe one device at a time to avoid consuming concurrent encoder sessions.
    for(const encoder of candidates){
      try{await runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i','color=c=black:s=640x360:r=30','-frames:v','2','-an','-c:v',encoder,'-f','null','-'],{signal,timeoutMs:12000});software.push(encoder);}catch(error){if(isAbort(error))throw error;}
    }
    return software;
  })();
  encoderCache.set(ctx.ffmpeg,work);work.catch(()=>encoderCache.delete(ctx.ffmpeg));return work;
}

async function ffmpegProgress(ctx:EngineContext,args:string[],duration:number,cwd:string|undefined,onProgress:ProgressCallback|undefined,signal?:AbortSignal){
  let pending='',last=0;
  return runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y','-stats_period','0.25','-progress','pipe:1',...args],{cwd,signal,captureStdout:false,onSpawn:pid=>ctx.diagnostics?.({event:'ffmpeg-start',pid}),onStdout:data=>{
    pending+=data.toString();const lines=pending.split(/\r?\n/);pending=lines.pop()||'';
    for(const line of lines){if(line.startsWith('out_time_us=')){const p=clamp(number(line.slice(12))/1e6/duration,0,.995);if(p>=last){last=p;onProgress?.(p);}}}
  }});
}

export async function createProxy(asset:MediaAsset,ctx:EngineContext,onProgress?:ProgressCallback,signal?:AbortSignal):Promise<MediaAsset> {
  if(asset.kind!=='video')throw new Error('프록시는 영상 파일에 사용할 수 있습니다.');
  const fresh=await probeMedia(asset.path,ctx,signal,{derivatives:false});
  if(fresh.kind!=='video')throw new Error('원본 파일이 영상이 아닙니다. 다시 가져와 주세요.');
  asset={...(asset.sourceRevision===fresh.sourceRevision?asset:{}),...fresh,id:asset.id,name:asset.sourceRevision===fresh.sourceRevision?asset.name:fresh.name};
  const alpha=!!asset.hasAlpha,key=proxyCacheKey(asset),extension=alpha?'webm':'mp4';
  await fs.mkdir(ctx.cacheDir,{recursive:true});const target=path.join(ctx.cacheDir,`${key}-${alpha?'alpha':'color'}-proxy.${extension}`);
  if(await exists(target)){onProgress?.(1,'기존 프록시를 사용합니다.');return {...asset,proxyPath:target};}
  const temporary=path.join(ctx.cacheDir,`${key}-${randomUUID()}.partial.${extension}`);
  try{
    // The encoder's default time base follows nominal FPS and can round VFR
    // frames onto a different clock. Keep every presentation timestamp, with
    // microsecond precision until the container's own time-base conversion.
    const video=await sourceVideoInfo(asset,ctx,signal),resize="scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",input=[...videoDecoderArgs(video),'-protocol_whitelist','file,pipe','-i',asset.path,'-map','0:v:0','-map','0:a:0?','-fps_mode:v','passthrough','-enc_time_base:v','1:1000000'];
    if(alpha){
      // H264/NVENC cannot retain an alpha plane. Transparent previews use
      // VP9+Opus in WebM; normal opaque proxies retain hardware H264 encoding.
      const color=video?previewVideoColor(video):{matrix:'bt709',range:'tv'},conversion=video&&/^(?:gbr|rgb|bgr|argb|abgr|rgba|bgra)/.test(video.pix_fmt||'')?'':`:in_color_matrix=${color.matrix}:in_range=${color.range}`;
      // Decode color at native size, then resize premultiplied RGB and alpha
      // together. Straight-alpha scaling leaks invisible background colors.
      const filters=[`${video?previewColorPrefix(video):''}scale=iw:ih:flags=bilinear+full_chroma_int+accurate_rnd${conversion}:out_range=pc`,...alphaSpatialFilters([`${resize}:flags=bilinear+accurate_rnd`]),'scale=iw:ih:out_color_matrix=bt709:out_range=tv','format=yuva420p'];
      onProgress?.(0,'투명 프록시 생성 · CPU');await ffmpegProgress(ctx,[...input,'-vf',filters.join(','),'-pix_fmt','yuva420p','-c:v','libvpx-vp9','-crf','24','-b:v','0','-deadline','good','-cpu-used','5','-row-mt','1','-threads','4','-auto-alt-ref','0','-g','30','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-c:a','libopus','-b:a','128k',temporary],asset.duration,undefined,onProgress,signal);
    }else{
      const encoders=await detectEncoders(ctx,signal);const hardware=encoders.includes('h264_nvenc')?'h264_nvenc':encoders.includes('h264_qsv')?'h264_qsv':encoders.includes('h264_amf')?'h264_amf':undefined;
      const color=video?previewVideoColor(video):{matrix:'bt709',range:'tv'},conversion=video&&/^(?:gbr|rgb|bgr|argb|abgr|rgba|bgra)/.test(video.pix_fmt||'')?'':`:in_color_matrix=${color.matrix}:in_range=${color.range}`;
      const base=[...input,'-vf',`${video?previewColorPrefix(video):''}${resize}${conversion}:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=limited:colorspace=bt709:color_primaries=bt709:color_trc=bt709`,'-pix_fmt','yuv420p','-color_range','tv','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-c:a','aac','-b:a','128k','-movflags','+faststart'];
      const encode=async(codec:string)=>ffmpegProgress(ctx,[...base,...encoderArguments(codec,'draft'),'-g','30','-video_track_timescale','1000000',temporary],asset.duration,undefined,onProgress,signal);
      try{onProgress?.(0,hardware?`GPU 프록시 생성 · ${hardware}`:'프록시 생성 · CPU');await encode(hardware||'libx264');}catch(error){if(isAbort(error)||!hardware)throw error;onProgress?.(0,'GPU를 사용할 수 없어 CPU로 프록시를 생성합니다.');await encode('libx264');}
    }
    if(await readSourceRevision(asset.path)!==asset.sourceRevision)throw new Error('프록시 생성 중 원본 파일이 변경되었습니다. 다시 가져와 주세요.');
    await replaceWithRetry(temporary,target);onProgress?.(1,'프록시가 준비되었습니다.');return {...asset,proxyPath:target};
  }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
}

function validNumber(value:unknown,min:number,max:number,label:string){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`${label} 값이 올바르지 않습니다 (${min}–${max}).`);}
export function validateProject(project:Project,settings:ExportSettings):void {
  assertProject(project);
  if(!project.clips.length)throw new Error('타임라인에 클립을 추가해 주세요.');
  validNumber(project.width,16,8192,'프로젝트 너비');validNumber(project.height,16,8192,'프로젝트 높이');
  validNumber(settings.width,16,7680,'출력 너비');validNumber(settings.height,16,7680,'출력 높이');validNumber(settings.fps,1,120,'프레임 속도');
  if(settings.width%2||settings.height%2)throw new Error('출력 너비와 높이는 짝수여야 합니다.');
  if(!['mp4','webm','gif','wav'].includes(settings.format)||!['h264','hevc','av1'].includes(settings.codec)||!['auto','cpu','nvenc','qsv','amf'].includes(settings.encoder)||!['draft','standard','high'].includes(settings.quality))throw new Error('내보내기 설정이 올바르지 않습니다.');
  if(settings.transitionProcessing!==undefined&&!['auto','cpu'].includes(settings.transitionProcessing))throw new Error('전환 처리 설정이 올바르지 않습니다.');
  if(!settings.outputPath||!localPath(settings.outputPath))throw new Error('저장할 로컬 파일 경로가 필요합니다.');
  const output=path.resolve(settings.outputPath).toLowerCase();
  if(project.media.some(m=>typeof m.path==='string'&&path.resolve(m.path).toLowerCase()===output))throw new Error('원본 미디어 파일을 덮어쓸 수 없습니다. 다른 파일명을 사용해 주세요.');
  if(!/^#[\da-f]{6}$/i.test(project.background))throw new Error('배경색이 올바르지 않습니다.');
  const tracks=new Set(project.tracks.map(t=>t.id)),assets=new Map(project.media.map(m=>[m.id,m]));
  if(tracks.size!==project.tracks.length||assets.size!==project.media.length||new Set(project.clips.map(c=>c.id)).size!==project.clips.length)throw new Error('중복된 프로젝트 항목이 있습니다.');
  if(project.clips.length>10000)throw new Error('한 프로젝트는 최대 10,000개 클립을 지원합니다.');
  for(const c of project.clips){
    if(!tracks.has(c.trackId))throw new Error('클립의 트랙을 찾을 수 없습니다.');
    validNumber(c.start,0,86400,'시작 시간');validNumber(c.duration,.01,86400,'길이');validNumber(c.in,0,864000,'원본 시작');validNumber(c.speed,.1,16,'재생 속도');validNumber(c.volume,0,10,'볼륨');
    validNumber(c.scale,.01,8,'크기');validNumber(c.x,-16384,16384,'X 위치');validNumber(c.y,-16384,16384,'Y 위치');validNumber(c.rotation,-3600,3600,'회전');validNumber(c.opacity,0,1,'불투명도');
    validNumber(c.fadeIn,0,86400,'페이드 인');validNumber(c.fadeOut,0,86400,'페이드 아웃');validNumber(c.brightness,-1,1,'밝기');validNumber(c.contrast,0,3,'대비');validNumber(c.saturation,0,3,'채도');validNumber(c.blur,0,30,'블러');
    if(c.sourceClipOffset!==undefined||c.sourceClipDuration!==undefined){validNumber(c.sourceClipOffset,0,86400,'효과 시작점');validNumber(c.sourceClipDuration,.01,86400,'효과 전체 길이');if(c.sourceClipOffset!+c.duration>c.sourceClipDuration!+.002)throw new Error('클립 효과 구간이 원래 길이를 초과합니다.');}
    if(!['contain','cover'].includes(c.fit)||!['none','cinematic','warm','cool','mono','vivid'].includes(c.preset)||!['none','fade','pop','slide'].includes(c.animation))throw new Error('클립 효과 설정이 올바르지 않습니다.');
    if(c.text!==undefined){
      if(typeof c.text!=='string'||c.text.length>20000)throw new Error('텍스트는 20,000자 이내로 입력해 주세요.');
      validNumber(c.fontSize,4,1000,'글자 크기');if(!/^#[\da-f]{6}$/i.test(c.color)||!/^#[\da-f]{6}$/i.test(c.textBackground))throw new Error('텍스트 색상이 올바르지 않습니다.');
      if(!['minimal','bold','box','neon','title'].includes(c.textStyle)||!['left','center','right'].includes(c.align)||typeof c.fontFamily!=='string')throw new Error('텍스트 스타일이 올바르지 않습니다.');
    } else {
      const media=assets.get(c.mediaId||'');if(!media||!localPath(media.path))throw new Error('클립의 원본 미디어를 찾을 수 없습니다.');
      if(media.kind!=='image'&&c.in+clipSourceSpan(c)>media.duration+Math.max(.15,2/(media.fps||30)))throw new Error(`“${c.name}” 클립이 원본 길이를 초과합니다. 끝을 줄여 주세요.`);
    }
    if(!Array.isArray(c.keyframes)||c.keyframes.length>1000)throw new Error('키프레임 정보가 올바르지 않습니다.');
    for(const k of c.keyframes){validNumber(k.time,0,c.duration+.001,'키프레임 시간');validNumber(k.x,-16384,16384,'키프레임 X');validNumber(k.y,-16384,16384,'키프레임 Y');validNumber(k.scale,.01,8,'키프레임 크기');validNumber(k.opacity,0,1,'키프레임 불투명도');validNumber(k.rotation,-3600,3600,'키프레임 회전');}
  }
  validNumber(projectDuration(project),.01,86400,'전체 재생 시간');
}

/** Eased interpolation, retaining restricted easing domains after a split. */
export function keyframeExpression(clip:Clip,key:'x'|'y'|'scale'|'rotation'|'opacity',clock='t'):string {
  const numeric=(value:number)=>Number(value.toPrecision(15)).toString();
  const keys=[...clip.keyframes].sort((a,b)=>a.time-b.time).filter((k,i,all)=>i===all.length-1||k.time!==all[i+1].time);
  if(!keys.length)return numeric(clip[key]);
  const interval=(i:number)=>{
    if(i===keys.length-1)return numeric(keys[i][key]);
    if(keys[i].easing==='hold'||keys[i][key]===keys[i+1][key])return numeric(keys[i][key]);
    const a=keys[i],b=keys[i+1],start=a.easingStart??0,end=a.easingEnd??1,range=ease(end,a.easing)-ease(start,a.easing);
    const unit=`clip((${clock}-${numeric(a.time)})/${numeric(b.time-a.time)},0,1)`,domain=`(${numeric(start)}+${numeric(end-start)}*(${unit}))`;
    let curve=domain;
    if(a.easing==='ease-in')curve=`pow(${domain},2)`;
    if(a.easing==='ease-out')curve=`(1-pow(1-${domain},2))`;
    if(a.easing==='ease-in-out')curve=`if(lt(${domain},0.5),2*pow(${domain},2),1-2*pow(1-${domain},2))`;
    if(a.easing==='hold')curve=`gte(${domain},1)`;
    const progress=Math.abs(range)<1e-12?'0':`((${curve})-${numeric(ease(start,a.easing))})/${numeric(range)}`;
    return `(${numeric(a[key])}+${numeric(b[key]-a[key])}*(${progress}))`;
  };
  const tree=(lo:number,hi:number):string=>{if(lo===hi)return interval(lo);const mid=(lo+hi)>>>1;return `if(lt(${clock},${numeric(keys[mid+1].time)}),${tree(lo,mid)},${tree(mid+1,hi)})`;};
  return `if(lte(${clock},${numeric(keys[0].time)}),${numeric(keys[0][key])},${tree(0,keys.length-1)})`;
}

function fadeExpression(c:Clip,clock:string){
  const envelope=clipEnvelope(c),time=envelope.time?`(${clock}+${dec(envelope.time)})`:clock;
  const terms=['1'];if(c.fadeIn>0)terms.push(`max(0,${time}/${dec(c.fadeIn)})`);if(c.fadeOut>0)terms.push(`max(0,(${dec(envelope.duration)}-${time})/${dec(c.fadeOut)})`);
  return terms.reduce((a,b)=>`min(${a},${b})`);
}
function alphaExpression(c:Clip,clock:string){let alpha=`(${keyframeExpression(c,'opacity',clock)})*(${fadeExpression(c,clock)})`;if(c.text!==undefined&&c.animation!=='none'){const envelope=clipEnvelope(c),time=`(${clock}+${dec(envelope.time)})`;alpha+=`*min(1,min(max(0,${time}/0.25),max(0,(${dec(envelope.duration)}-${time})/0.2)))`;}return alpha;}

function colorFilters(c:Clip,outputScale:number):string[] {
  const filters:string[]=[];
  const lut=(expression:string)=>filters.push(`lutrgb=r='${expression}':g='${expression}':b='${expression}'`);
  const matrix=(v:number[])=>filters.push('colorchannelmixer='+['rr','rg','rb','gr','gg','gb','br','bg','bb'].map((key,i)=>`${key}=${dec(v[i])}`).join(':'));
  const contrast=(amount:number)=>{if(amount!==1)lut(`clip((val-127.5)*${dec(amount)}+127.5,0,255)`);};
  const saturation=(amount:number)=>{
    if(amount===1)return;
    // colorchannelmixer coefficients are limited to [-2,2]; two smaller
    // matrices preserve CSS saturation values above that coefficient bound.
    if(amount>2){saturation(Math.sqrt(amount));saturation(Math.sqrt(amount));return;}
    matrix([.213+.787*amount,.715-.715*amount,.072-.072*amount,.213-.213*amount,.715+.285*amount,.072-.072*amount,.213-.213*amount,.715-.715*amount,.072+.928*amount]);
  };
  // Same order and sRGB formulas as the editor's CSS filter list. FFmpeg eq's
  // brightness is additive in YUV, so using it here would change the look.
  if(c.brightness!==0)lut(`clip(val*${dec(1+c.brightness)},0,255)`);
  contrast(c.contrast);saturation(c.saturation);
  if(c.blur>0)filters.push(...alphaSpatialFilters([`gblur=sigma=${dec(c.blur*outputScale)}:steps=2`]));
  if(c.preset==='cinematic'){contrast(1.15);saturation(.8);}
  if(c.preset==='warm'){matrix([.89074,.13842,.03402,.06282,.94348,.03024,.04896,.09612,.84358]);saturation(1.15);}
  if(c.preset==='cool'){
    const cos=Math.cos(12*Math.PI/180),sin=Math.sin(12*Math.PI/180);
    matrix([.213+.787*cos-.213*sin,.715-.715*cos-.715*sin,.072-.072*cos+.928*sin,.213-.213*cos+.143*sin,.715+.285*cos+.140*sin,.072-.072*cos-.283*sin,.213-.213*cos-.787*sin,.715-.715*cos+.715*sin,.072+.928*cos+.072*sin]);saturation(.9);
  }
  if(c.preset==='mono')saturation(0);
  if(c.preset==='vivid'){saturation(1.4);contrast(1.1);}
  return filters;
}

function sourceFilters(c:Clip,media:MediaAsset):string[]{
  const filters:string[]=[],crop=clipCrop(c);
  if(Object.values(crop).some(v=>v!==0))filters.push(`crop=w='max(1,iw*${dec(1-crop.left-crop.right)})':h='max(1,ih*${dec(1-crop.top-crop.bottom)})':x='iw*${dec(crop.left)}':y='ih*${dec(crop.top)}':exact=1`);
  if(c.chromaKey?.enabled){
    const key=c.chromaKey,opaque=!media.hasAlpha&&media.kind==='video'&&['h264','hevc','av1','mpeg4','mpeg2video','mpeg1video','h263','vp8'].includes(media.codec||'');
    if(opaque)filters.push(`colorkey=color=${key.color.replace('#','0x')}:similarity=${dec(Math.max(.00001,key.similarity))}:blend=${dec(key.smoothness)}`);
    else{
      const red=parseInt(key.color.slice(1,3),16),green=parseInt(key.color.slice(3,5),16),blue=parseInt(key.color.slice(5,7),16);
      const alpha=`alpha(X,Y)*clip((sqrt(pow(r(X,Y)-${red},2)+pow(g(X,Y)-${green},2)+pow(b(X,Y)-${blue},2))/(255*sqrt(3))-${dec(key.similarity)})/${dec(key.smoothness)},0,1)`;
      filters.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}':interpolation=nearest`,'format=rgba');
    }
  }
  return filters;
}

/** Static alpha mattes are calculated once per render window, not through an
 * expensive RGB equation for every video frame. */
async function writeMask(c:Clip,width:number,height:number,file:string){
  const mask=c.mask!,pixels=Buffer.allocUnsafe(width*height),cx=mask.x*width,cy=mask.y*height,rx=Math.max(.0001,mask.width*width/2),ry=Math.max(.0001,mask.height*height/2),feather=mask.feather*Math.min(width,height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const px=x+.5-cx,py=y+.5-cy;let distance:number;
    if(mask.type==='ellipse')distance=(Math.hypot(px/rx,py/ry)-1)*Math.min(rx,ry);
    else {const dx=Math.abs(px)-rx,dy=Math.abs(py)-ry;distance=Math.hypot(Math.max(dx,0),Math.max(dy,0))+Math.min(Math.max(dx,dy),0);}
    let alpha=feather?clamp(.5-distance/feather,0,1):distance<=0?1:0;if(mask.invert)alpha=1-alpha;pixels[y*width+x]=Math.round(alpha*255);
  }
  await fs.writeFile(file,Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`),pixels]));
}

function tempoFilters(speed:number){const values:string[]=[];while(speed>2){values.push('atempo=2');speed/=2;}while(speed<.5){values.push('atempo=0.5');speed/=.5;}if(Math.abs(speed-1)>.000001)values.push(`atempo=${dec(speed)}`);return values;}

function assTime(seconds:number){const centis=Math.round(Math.max(0,seconds)*100),hours=Math.floor(centis/360000),minutes=Math.floor(centis/6000)%60,secs=Math.floor(centis/100)%60;return `${hours}:${String(minutes).padStart(2,'0')}:${String(secs).padStart(2,'0')}.${String(centis%100).padStart(2,'0')}`;}
function assColor(hex:string){return `&H00${hex.slice(5,7)}${hex.slice(3,5)}${hex.slice(1,3)}`.toUpperCase();}
function assAlpha(opacity:number){return Math.round((1-clamp(opacity,0,1))*255).toString(16).padStart(2,'0').toUpperCase();}
function textState(c:Clip,time:number){const k=interpolate(c,time),envelope=clipEnvelope(c,time);let opacity=k.opacity*Math.min(1,c.fadeIn?Math.max(0,envelope.time/c.fadeIn):1,c.fadeOut?Math.max(0,(envelope.duration-envelope.time)/c.fadeOut):1);let scale=k.scale,y=k.y;
  if(c.animation!=='none'){const entry=clamp(envelope.time/.25,0,1),exit=clamp((envelope.duration-envelope.time)/.2,0,1);opacity*=Math.min(entry,exit);if(c.animation==='pop')scale*=.8+.2*(1-Math.pow(1-entry,3));if(c.animation==='slide')y+=(1-entry)*40;}
  return {...k,opacity,scale,y};
}

/** Render one event per motion segment; libass interpolates motion/scale/rotation at output frame rate. */
export function buildAss(project:Project,settings:ExportSettings,range?:{start:number;end:number}):string {
  const w=settings.width,h=settings.height,sx=w/project.width,sy=h/project.height;
  const styles:string[]=[],events:string[]=[];
  const text=project.clips.filter(c=>c.text!==undefined&&!c.captionStyle&&visualTrackEnabled(project,project.tracks.find(t=>t.id===c.trackId))).sort((a,b)=>project.tracks.findIndex(t=>t.id===a.trackId)-project.tracks.findIndex(t=>t.id===b.trackId)||a.start-b.start);
  text.forEach((c,index)=>{
    const font=c.fontFamily.replace(/[\r\n,{}\\]/g,'').slice(0,80)||'Malgun Gothic';
    const border=c.textStyle==='box'?3:1,outline=c.textStyle==='bold'?2.5:c.textStyle==='box'?12:c.textStyle==='title'?1:0,shadow=c.textStyle==='minimal'?1.5:c.textStyle==='bold'?2:0;
    const bold=c.textStyle==='minimal'?0:-1;
    const name=`Text${index}`,alignment=c.align==='left'?4:c.align==='right'?6:5;
    styles.push(`Style: ${name},${font},${dec(c.fontSize*sy)},${assColor(c.color)},&H000000FF,${assColor(c.textStyle==='box'?c.textBackground:'#080910')},${assColor(c.textStyle==='box'?c.textBackground:'#080910')},${bold},0,0,0,100,100,${c.textStyle==='title'?dec(1.5*sx):0},0,${border},${dec(outline*sy)},${dec(shadow*sy)},${alignment},${Math.round(w*.05)},${Math.round(w*.05)},0,1`);
    const breaks=new Set([0,c.duration,...c.keyframes.map(k=>k.time)]),envelope=clipEnvelope(c);
    if(c.keyframes.some(k=>k.easing&&k.easing!=='linear'))for(let frame=Math.max(Math.ceil(c.start*settings.fps),range?Math.floor(range.start*settings.fps)-1:0),end=Math.min((c.start+c.duration)*settings.fps,range?Math.ceil(range.end*settings.fps)+1:Infinity);frame<end;frame++)breaks.add(frame/settings.fps-c.start);
    if(c.fadeIn>0)breaks.add(c.fadeIn-envelope.time);if(c.fadeOut>0)breaks.add(envelope.duration-c.fadeOut-envelope.time);
    if(c.animation!=='none'){breaks.add(.25-envelope.time);breaks.add(envelope.duration-.2-envelope.time);for(let t=.05;t<.25;t+=.05)breaks.add(t-envelope.time);}
    // Product of alpha ramps and keyframes is sampled during ramps for close preview parity.
    if(c.keyframes.length&&(c.fadeIn||c.fadeOut||c.animation!=='none'))for(let t=.1;t<c.duration;t+=Math.max(.1,c.duration/2000)){const phase=t+envelope.time;if(phase<c.fadeIn||phase>envelope.duration-c.fadeOut||phase<.25||phase>envelope.duration-.2)breaks.add(t);}
    const times=[...breaks].filter(t=>t>=0&&t<=c.duration).sort((a,b)=>a-b);
    const literal=(c.text||'').replace(/\\/g,'＼').replace(/\{/g,'｛').replace(/\}/g,'｝').replace(/\r?\n/g,'\\N');
    for(let i=0;i<times.length-1;i++){
      const a=times[i],b=times[i+1];if(range&&(c.start+b<range.start-.02||c.start+a>range.end+.02))continue;
      // ASS timestamps have centisecond precision. Quantize shared boundaries
      // before deciding whether an event exists: 120 fps motion segments are
      // shorter than 10 ms, but most still occupy a positive ASS interval.
      const startCs=Math.round(Math.max(0,c.start+a)*100),endCs=Math.round(Math.max(0,c.start+b)*100);if(endCs<=startCs)continue;
      const eventStart=startCs/100,eventEnd=endCs/100,localStart=eventStart-c.start,localEnd=eventEnd-c.start;
      // Evaluate the original clip clock at the emitted event boundaries. A
      // rounded event must not restart an animation or its inherited envelope.
      const first=textState(c,localStart),last=textState(c,Math.max(localStart,localEnd-1e-8)),ms=(endCs-startCs)*10;
      const anchor=c.align==='left'?w*.05:c.align==='right'?w*.95:w/2;
      const position=`\\move(${dec(anchor+first.x*sx)},${dec(h/2+first.y*sy)},${dec(anchor+last.x*sx)},${dec(h/2+last.y*sy)},0,${ms})`;
      const transform=`\\fscx${dec(first.scale*100)}\\fscy${dec(first.scale*100)}\\frz${dec(-first.rotation)}\\alpha&H${assAlpha(first.opacity)}&\\t(0,${ms},\\fscx${dec(last.scale*100)}\\fscy${dec(last.scale*100)}\\frz${dec(-last.rotation)}\\alpha&H${assAlpha(last.opacity)}&)`;
      const tags=`${position}${transform}\\q0`;
      const line=(layer:number,extra:string)=>`Dialogue: ${layer},${assTime(eventStart)},${assTime(eventEnd)},${name},,0,0,0,,{${tags}${extra}}${literal}`;
      if(c.textStyle==='neon')events.push(line(index*2,`\\3c${assColor(c.color)}&\\bord${dec(Math.min(3,c.fontSize*.035)*sy)}\\blur${dec(c.fontSize*.12*sy)}\\shad0`));
      events.push(line(index*2+1,c.textStyle==='neon'?'\\bord0\\blur0\\shad0':''));
    }
  });
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${w}\nPlayResY: ${h}\nWrapStyle: 0\nScaledBorderAndShadow: yes\nYCbCr Matrix: TV.709\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styles.join('\n')}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}

function encoderArguments(encoder:string,quality:ExportSettings['quality']):string[]{
  const q=quality==='draft'?27:quality==='high'?17:21;
  if(encoder.endsWith('_nvenc'))return ['-c:v',encoder,'-preset',quality==='draft'?'p2':quality==='high'?'p6':'p4','-rc','vbr','-cq',String(q),'-b:v','0'];
  if(encoder.endsWith('_qsv'))return ['-c:v',encoder,'-preset','fast','-global_quality',String(q)];
  if(encoder.endsWith('_amf'))return ['-c:v',encoder,'-quality',quality==='high'?'quality':'speed','-rc','cqp','-qp_i',String(q),'-qp_p',String(q)];
  if(encoder==='libx265')return ['-c:v',encoder,'-preset',quality==='high'?'medium':'fast','-crf',String(q+2),'-x265-params','log-level=error'];
  if(encoder==='libsvtav1')return ['-c:v',encoder,'-preset',quality==='high'?'6':'9','-crf',String(q+8)];
  if(encoder==='libvpx-vp9')return ['-c:v',encoder,'-crf',String(q+10),'-b:v','0','-row-mt','1','-cpu-used',quality==='high'?'2':'5'];
  return ['-c:v','libx264','-preset',quality==='high'?'medium':'veryfast','-crf',String(q),'-threads','4'];
}

async function chooseEncoder(settings:ExportSettings,ctx:EngineContext,signal?:AbortSignal){
  if(settings.format==='gif'||settings.format==='wav')return '';
  if(settings.format==='webm'&&settings.codec!=='av1')return 'libvpx-vp9';
  const base=settings.codec==='hevc'?'hevc':settings.codec==='av1'?'av1':'h264';
  const cpu=base==='hevc'?'libx265':base==='av1'?'libsvtav1':'libx264';
  if(settings.encoder==='cpu')return cpu;
  const supported=await detectEncoders(ctx,signal);
  if(settings.encoder!=='auto'){const name=`${base}_${settings.encoder}`;if(!supported.includes(name))throw new Error(`${name} GPU 인코더를 사용할 수 없습니다. 자동 또는 CPU를 선택해 주세요.`);return name;}
  return ['nvenc','qsv','amf'].map(s=>`${base}_${s}`).find(e=>supported.includes(e))||cpu;
}

export async function canUseNativeBase(clip:Clip|undefined,media:MediaAsset|undefined,duration:number,ctx:EngineContext,signal?:AbortSignal):Promise<boolean>{
  if(!clip||!media||media.kind!=='video'||clip.start!==0||clip.duration<duration||clip.speed!==1||clip.speedCurve||clip.scale!==1||clip.x!==0||clip.y!==0||clip.rotation!==0||clip.opacity!==1||clip.flipH||clip.flipV||clip.fadeIn!==0||clip.fadeOut!==0||clip.keyframes.length||clip.preset!=='none'||clip.brightness!==0||clip.contrast!==1||clip.saturation!==1||clip.blur!==0||hasColorGrade(clip.colorGrade))return false;
  if(Object.values(clipCrop(clip)).some(value=>value!==0)||clip.chromaKey?.enabled||(clip.mask&&clip.mask.type!=='none'))return false;
  // Converting an alpha-bearing clip directly to YUV would lose transparency.
  // Inspect the actual source instead of trusting project metadata. Unknown or
  // palette pixel formats conservatively keep the normal compositing path.
  try{
    const stream=await sourceVideoInfo(media,ctx,signal);return !!stream?.pix_fmt&&!videoHasAlpha(stream);
  }catch(error){if(isAbort(error))throw error;return false;}
}

const cudaAssets=new Map<string,Promise<boolean>>();
const videoInfoCache=new Map<string,Promise<VideoColorInfo|undefined>>();
async function sourceVideoInfo(media:MediaAsset,ctx:EngineContext,signal?:AbortSignal):Promise<VideoColorInfo|undefined>{
  const stat=await fs.stat(media.path),key=`${ctx.ffprobe}|${sourceRevisionFromStat(media.path,stat)}`,cached=videoInfoCache.get(key);if(cached)return cached;
  const pending=(async()=>{
    return JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-select_streams','v:0','-show_entries','stream=codec_name,width,height,pix_fmt,color_space,color_primaries,color_transfer,color_range:stream_side_data=rotation:stream_tags=rotate,alpha_mode,ALPHA_MODE','-of','json',media.path],{signal,timeoutMs:20000})).stdout.toString()).streams?.[0] as VideoColorInfo|undefined;
  })();if(videoInfoCache.size>256)videoInfoCache.delete(videoInfoCache.keys().next().value!);videoInfoCache.set(key,pending);pending.catch(()=>videoInfoCache.delete(key));return pending;
}
async function sourceColor(media:MediaAsset,ctx:EngineContext,signal?:AbortSignal):Promise<{matrix:string;range:'pc'|'tv';actualRange:'pc'|'tv';prefix:string}>{
    if(media.kind==='image')return {matrix:'bt709',range:'pc',actualRange:'pc',prefix:''};const stream=await sourceVideoInfo(media,ctx,signal);
    const color=stream?previewVideoColor(stream):undefined,matrix=color?.matrix;
    const normalized=matrix==='bt709'||matrix==='bt601'||matrix==='fcc'||matrix==='smpte240m'?matrix:matrix==='bt2020nc'||matrix==='bt2020c'?'bt2020':(stream?.width||0)>=1280||(stream?.height||0)>=720?'bt709':'bt601';
    return {matrix:normalized,range:color?.range||'tv',actualRange:stream?.color_range==='pc'||stream?.pix_fmt?.startsWith('yuvj')?'pc':'tv',prefix:stream?previewColorPrefix(stream):''};
}
async function canUseCudaScale(media:MediaAsset,ctx:EngineContext,signal?:AbortSignal){
  if(ctx.gpuProcessing===false||!['h264','hevc','av1','vp9','mpeg2video'].includes(media.codec||''))return false;
  const key=`${ctx.ffmpeg}|${media.sourceRevision||await readSourceRevision(media.path)}`;let cached=cudaAssets.get(key);if(cached)return cached;
  cached=(async()=>{try{await runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-threads','1','-hwaccel','cuda','-hwaccel_output_format','cuda','-protocol_whitelist','file,pipe','-i',media.path,'-vf','scale_cuda=320:180:format=yuv420p,hwdownload,format=yuv420p','-frames:v','1','-an','-f','null','-'],{signal,timeoutMs:30000});return true;}catch(error){if(isAbort(error))throw error;return false;}})();
  if(cudaAssets.size>256)cudaAssets.delete(cudaAssets.keys().next().value!);cudaAssets.set(key,cached);cached.catch(()=>cudaAssets.delete(key));return cached;
}

/** Keep eligible decoded/scaled frames on the GPU through NVENC. General
 * timelines still use bounded composition; no effects are silently omitted. */
async function nativeCudaClip(project:Project,settings:ExportSettings,ctx:EngineContext,signal?:AbortSignal):Promise<{clip:Clip;media:MediaAsset}|undefined>{
  if(ctx.gpuProcessing===false||!['mp4','webm'].includes(settings.format))return;
  const tracks=new Map(project.tracks.map(track=>[track.id,track])),assets=new Map(project.media.map(media=>[media.id,media]));
  const visible=project.clips.filter(clip=>visualTrackEnabled(project,tracks.get(clip.trackId))&&(clip.text!==undefined||assets.get(clip.mediaId||'')?.kind!=='audio'));
  if(visible.length!==1)return;
  const clip=visible[0],media=assets.get(clip.mediaId||'');
  // Non-frame-aligned and trimmed-in sources retain the fully tested general
  // timeline clock. This fast path cannot change their sampling semantics.
  if(!media||media.videoStart===undefined||Math.abs(media.videoStart)>1e-6||clip.in!==0||Math.abs(clip.duration*settings.fps-Math.round(clip.duration*settings.fps))>1e-7||!await canUseNativeBase(clip,media,projectDuration(project),ctx,signal))return;
  const info=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-select_streams','v:0','-show_entries','stream=width,height,sample_aspect_ratio:stream_side_data=rotation:stream_tags=rotate','-of','json',media.path],{signal,timeoutMs:20000})).stdout.toString()).streams?.[0];
  if(!info||!['1:1','N/A',undefined].includes(info.sample_aspect_ratio)||number(info.tags?.rotate)||info.side_data_list?.some((data:any)=>number(data.rotation)!==0)||Math.abs(info.width/info.height-settings.width/settings.height)>1e-8)return;
  const color=await sourceColor(media,ctx,signal);
  // A direct stream retains its original range. If Chromium reinterprets
  // incomplete tags, use the normal conversion path to match the preview.
  return color.matrix==='bt709'&&color.range===color.actualRange&&await canUseCudaScale(media,ctx,signal)?{clip,media}:undefined;
}

interface WindowOutput {start:number;duration:number;frames:number;destination:string;transitionPlan?:TransitionPlan;captionRaster?:CaptionRasterSession}
/** Serialized metadata never authorizes reading transition handles. Refresh
 * used sources once, resolve only participating video ranges, and retain the
 * stat identity so replacements during rendering cannot be published. */
export async function prepareRenderSources(project:Project,settings:ExportSettings,ctx:EngineContext,signal?:AbortSignal,onProgress?:ProgressCallback){
  validateProject({...project,transitions:undefined},settings);
  if(project.transitions!==undefined&&(!Array.isArray(project.transitions)||project.transitions.length>10000||project.transitions.some(item=>!item||typeof item.fromClipId!=='string'||typeof item.toClipId!=='string')))throw new Error('전환 정보가 올바르지 않습니다.');
  const participants=new Set((project.transitions||[]).flatMap(item=>[item.fromClipId,item.toClipId]));
  const used=new Set(project.clips.flatMap(clip=>clip.mediaId?[clip.mediaId]:[])),participantMedia=new Set(project.clips.filter(clip=>participants.has(clip.id)).map(clip=>clip.mediaId));
  const revisions=new Map<string,string>(),media:MediaAsset[]=[];
  for(const asset of project.media){
    if(!used.has(asset.id)){media.push(asset);continue;}
    if(signal?.aborted)throw new CancelledError();
    const revision=await readSourceRevision(asset.path);
    if(asset.sourceRevision&&asset.sourceRevision!==revision)throw new Error(`“${asset.name}” 원본 파일이 변경되었습니다. 프로젝트에서 미디어를 다시 가져온 뒤 내보내 주세요.`);
    revisions.set(asset.path,revision);
    const fresh=await probeMedia(asset.path,ctx,signal,{derivatives:false});
    if(fresh.sourceRevision!==revision)throw new Error(`“${asset.name}” 원본 파일을 확인하는 중 변경되었습니다. 다시 가져와 주세요.`);
    const updated={...asset,...fresh,id:asset.id,name:asset.name};
    if(participantMedia.has(asset.id)&&updated.kind==='video'){
      delete updated.videoStart;delete updated.videoEnd;
      onProgress?.(0,`전환용 원본 프레임 확인 · ${asset.name}`);
      const range=await probeVideoRange(asset.path,ctx,signal,{allowScan:true,progress:(_value,message)=>onProgress?.(0,message||`전환용 원본 프레임 확인 · ${asset.name}`)});
      if(range)Object.assign(updated,range,{duration:Math.max(updated.duration,range.videoEnd)});
    }
    media.push(updated);
  }
  const rendered={...project,media};validateProject(rendered,settings);
  const verify=async()=>{for(const [file,revision] of revisions){if(signal?.aborted)throw new CancelledError();if(await readSourceRevision(file)!==revision)throw new Error(`내보내는 중 원본 파일이 변경되었습니다: ${path.basename(file)}. 미디어를 다시 가져와 주세요.`);}};
  await verify();return {project:rendered,verify};
}
/** Kept as a reference path for regression comparisons; production uses the
 * bounded raw-stream orchestrator below. Window output never encodes media. */
export async function renderProjectDirect(project:Project,settings:ExportSettings,ctx:EngineContext,onProgress?:ProgressCallback,signal?:AbortSignal,window?:WindowOutput):Promise<string> {
  // Standalone video calls use the same bounded composition clock as the app.
  // The direct WAV path remains available for audio-engine parity checks.
  if(!window&&settings.format!=='wav')return renderProject(project,settings,ctx,onProgress,signal);
  // The orchestrator validates once and passes its immutable render plan to
  // each window; rebuilding all transition indexes per window is unnecessary.
  if(window?.transitionPlan?.project!==project)validateProject(project,settings);if(signal?.aborted)throw new CancelledError();
  if(!window&&(project.clips.some(clip=>clip.speedCurve||clip.captionStyle)||project.transitions?.length))return renderProject(project,settings,ctx,onProgress,signal);
  const sources=!window?await prepareRenderSources(project,settings,ctx,signal,onProgress):undefined;if(sources)project=sources.project;
  if(!window)await assertOutputNotSource(settings.outputPath!,[...project.media.map(media=>media.path),...(project.motionPaths||[]).map(a=>a.path)]);
  const output=path.resolve(settings.outputPath!);const duration=window?.duration??projectDuration(project),windowStart=window?.start??0,windowEnd=windowStart+duration,width=settings.width,height=settings.height,fps=settings.fps,windowFrame=Math.round(windowStart*settings.fps);
  const format=window?'mp4':settings.format;
  const baseDirectory=path.resolve(ctx.workDir||ctx.cacheDir);await fs.mkdir(baseDirectory,{recursive:true});
  const work=await fs.mkdtemp(path.join(baseDirectory,'render-'));
  const temporary=path.join(path.dirname(output),`.${path.basename(output)}.${randomUUID()}.partial.${settings.format}`);
  const captionControl=new AbortController(),abortCaptions=()=>captionControl.abort();signal?.addEventListener('abort',abortCaptions,{once:true});if(signal?.aborted)captionControl.abort();
  let captionStreams:CaptionWindowStreams|undefined,ownedRaster:CaptionRasterSession|undefined,captionFailure:Error|undefined;
  const failCaption=(error:Error)=>{captionFailure??=error;captionControl.abort();};
  try{
    const assets=new Map(project.media.map(m=>[m.id,m]));const tracks=new Map(project.tracks.map(t=>[t.id,t]));
    const transitionPlan=window?.transitionPlan||compileTransitions(project),exposure=(c:Clip)=>transitionPlan.byClip.get(c.id)!;
    const pairs=transitionPlan.transitions.filter(item=>visualTrackEnabled(project,tracks.get(item.trackId))&&Math.min(Math.round(windowEnd*fps),Math.ceil(item.end*fps-1e-7))>Math.max(windowFrame,Math.ceil(item.start*fps-1e-7))),paired=new Set(pairs.flatMap(item=>[item.from.id,item.to.id]));
    const transitionDevice=settings.transitionProcessing!=='cpu'&&pairs.some(pair=>pair.transition.kind==='slide'||pair.transition.kind==='zoom')?await transitionGpuDevice(ctx,signal):undefined;
    const visuals=project.clips.filter(c=>c.text===undefined&&assets.get(c.mediaId||'')?.kind!=='audio'&&visualTrackEnabled(project,tracks.get(c.trackId))&&(!window||(c.start+exposure(c).visualFrom<windowEnd&&c.start+exposure(c).visualTo>windowStart))).sort((a,b)=>project.tracks.findIndex(t=>t.id===a.trackId)-project.tracks.findIndex(t=>t.id===b.trackId)||a.start-b.start);
    const sounds=window?[]:project.clips.filter(c=>c.text===undefined&&assets.get(c.mediaId||'')?.hasAudio&&audioTrackEnabled(project,tracks.get(c.trackId))&&c.volume>0);
    const inputs=window?visuals:format==='wav'?sounds:format==='gif'?visuals:[...new Map([...visuals,...sounds].map(c=>[c.id,c])).values()];
    const first=visuals[0],transitionClips=new Set(transitionPlan.transitions.flatMap(pair=>[pair.from.id,pair.to.id]));
    // The same clip must follow the same color path in every render window.
    // A transition outside this window still prevents native-base bypass.
    const nativeBase=format!=='wav'&&!transitionClips.has(first?.id||'')&&await canUseNativeBase(first,assets.get(first?.mediaId||''),projectDuration(project),ctx,signal);
    const colors=new Map(await Promise.all([...new Map(visuals.map(clip=>[clip.mediaId!,assets.get(clip.mediaId!)!])).values()].map(async media=>[media.id,await sourceColor(media,ctx,signal)] as const)));
    const cudaBase=!!nativeBase&&colors.get(first.mediaId!)?.matrix==='bt709'&&await canUseCudaScale(assets.get(first.mediaId!)!,ctx,signal);
    if(cudaBase)ctx.diagnostics?.({event:'gpu-processing',backend:'cuda',operations:['decode','scale'],clipId:first.id});
    const inputArgs:string[]=[],inputIndex=new Map<string,number>();
    for(const c of inputs){
      const asset=assets.get(c.mediaId!)!;await fs.access(asset.path);inputIndex.set(c.id,inputIndex.size);
      inputArgs.push('-thread_queue_size','8','-threads','1');
      if(cudaBase&&c.id===first.id)inputArgs.push('-hwaccel','cuda','-hwaccel_output_format','cuda');
      if(asset.kind==='video')inputArgs.push(...videoDecoderArgs(await sourceVideoInfo(asset,ctx,signal)));
      const rawFrom=window?Math.max(asset.kind==='image'?exposure(c).visualFrom:clipTimelineTime(c,0),windowStart-c.start-.5):0,from=window&&asset.kind==='image'?Math.floor(rawFrom*fps+1e-7)/fps:rawFrom,to=window?Math.min(exposure(c).visualTo,windowEnd-c.start+.5):c.duration;
      if(asset.kind==='image')inputArgs.push('-loop','1','-framerate',dec(fps));else {inputArgs.push('-ss',dec(Math.max(0,clipSourceTime(c,from))));if(window)inputArgs.push('-noaccurate_seek');}
      // An image loop needs one lookahead frame for fps's EOF rounding. Its
      // exact exposure is trimmed below; rounding demux duration can otherwise
      // choose a different held last frame after a fractional window seek.
      // With noaccurate_seek, input -t counts from the preceding keyframe and
      // can end before the requested window. Video is bounded downstream by
      // the source trim and exact output-frame limit instead.
      if(asset.kind==='image'||!window)inputArgs.push('-t',dec(asset.kind==='image'?Math.ceil((to-from)*fps+1e-7)/fps+1/fps:clipSourceTime(c,to)-clipSourceTime(c,from)));
      inputArgs.push('-protocol_whitelist','file,pipe','-i',asset.path);
    }
    const clipPhase=(c:Clip)=>c.start-Math.floor(c.start*fps+1e-7)/fps;
    const timing=(c:Clip)=>{
      if(!window)return [`trim=duration=${dec(clipSourceSpan(c))}`,c.speedCurve?`setpts='(${speedTimelineExpression(c,'(PTS-STARTPTS)*TB')})/TB'`:`setpts=(PTS-STARTPTS)/${dec(c.speed)}`,`fps=${dec(fps)}`,`trim=duration=${dec(c.duration)}`];
      const image=assets.get(c.mediaId!)?.kind==='image',range=exposure(c),phase=clipPhase(c),fromFrame=Math.floor((Math.max(range.visualFrom,windowStart-c.start-.5)+phase)*fps+1e-7);
      const origin=assets.get(c.mediaId!)?.timing?.origin||0;
      // Native decoders round packet and requested timestamps to microseconds.
      // Subtract half a SOURCE microsecond before the inverse speed mapping:
      // frame_us <= round(request_us) iff frame_us-.5 <= request_us.
      // Nanosecond filter time preserves that half microsecond. Using AVTB with
      // plain ceil would delay every third 30fps frame by one output frame.
      const clock=image?`settb=1/1000000000,setpts=PTS-STARTPTS+${fromFrame}/(${dec(fps)}*TB)`:
        `settb=AVTB,settb=1/1000000000,setpts=PTS-${Math.round(origin*1e6)*1000}-500,trim=end=${dec(clipSourceTime(c,range.visualTo))},${c.speedCurve?`setpts='(${speedTimelineExpression(c,`PTS*TB-${dec(c.in)}`)})/TB'`:`setpts=(PTS-${dec(c.in)}/TB)/${dec(c.speed)}`}`;
      // Anchor fps at zero, then restore an INTEGER frame index. Passing a
      // rounded fractional start_time changes fps's input/output offset pair
      // (e.g. 19/60 seconds) and shifts individual render windows.
      // trim's seconds options round to the link timebase; use explicit ceil
      // frame bounds so a fractional endpoint keeps its final visible frame.
      return [clock,`setpts=PTS${!image&&phase?`+${phase}/TB`:''}-${fromFrame}/(${dec(fps)}*TB)`,`fps=${dec(fps)}:start_time=0:round=up`,`setpts=PTS+${fromFrame}`,`trim=start_pts=${Math.ceil((range.visualFrom+phase)*fps-1e-7)}:end_pts=${Math.ceil((range.visualTo+phase)*fps-1e-7)}`];
    };
    const graph:string[]=[],colorFiles=new RenderColorFiles(work);let video='base';
    const enable=(start:number,end:number)=>`gte(t*${dec(fps)}+${windowFrame}+0.000001,${dec(start*fps)})*lt(t*${dec(fps)}+${windowFrame}+0.000001,${dec(end*fps)})`;
    const draws:Array<{label:string;x:string;y:string;enable:string;track:number;start:number}>=[];
    if(format!=='wav'){
      if(nativeBase){
        // The common single-video edit stays in native YUV. This avoids two
        // full-frame RGB conversions and an unnecessary transparent overlay.
        const chain=timing(first);if(window)chain.push(`trim=start_pts=${windowFrame}:end_pts=${windowFrame+window.frames}`,`setpts=PTS-${windowFrame}`);
        const color=colors.get(first.mediaId!)!;
        const resize=cudaBase?`scale_cuda=${width}:${height}:force_original_aspect_ratio=${first.fit==='cover'?'increase':'decrease'}:force_divisible_by=2:reset_sar=1:interp_algo=bilinear:format=yuv420p,hwdownload,format=yuv420p${color.range==='pc'?',scale=in_color_matrix=bt709:in_range=pc:out_color_matrix=bt709:out_range=tv':''}`:`scale=${width}:${height}:force_original_aspect_ratio=${first.fit==='cover'?'increase':'decrease'}:force_divisible_by=2:reset_sar=1:flags=bilinear:in_color_matrix=${color.matrix}:in_range=${color.range}:out_color_matrix=bt709:out_range=tv`;
        chain.push((cudaBase?'':color.prefix)+resize);
        if(first.fit==='cover')chain.push(`crop=${width}:${height}`);
        else chain.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${project.background.replace('#','0x')}`);
        chain.push('setsar=1','format=yuv444p','setparams=range=limited:colorspace=bt709');graph.push(`[${inputIndex.get(first.id)}:v:0]${chain.join(',')}[base]`);
      }else graph.push(`color=c=${project.background.replace('#','0x')}:s=${width}x${height}:r=${dec(fps)}:d=${dec(duration)},scale=in_color_matrix=bt601:out_color_matrix=bt709,format=yuv444p,setparams=colorspace=bt709[base]`);
      for(let i=nativeBase?1:0;i<visuals.length;i++){
        const c=visuals[i],range=exposure(c),phase=clipPhase(c),localClock=phase?`(t-${phase})`:'t',index=inputIndex.get(c.id)!;let layerInput=`${index}:v:0`;
        const color=colors.get(c.mediaId!)!;
        const chain=[...timing(c),...(assets.get(c.mediaId!)!.kind==='video'?[`${color.prefix}scale=in_color_matrix=${color.matrix}:in_range=${color.range}:out_range=pc`]:[]),'format=rgba',...sourceFilters(c,assets.get(c.mediaId!)!)];
        const fitting=c.fit==='cover'?[`scale=${width}:${height}:force_original_aspect_ratio=increase:reset_sar=1:flags=bilinear`,`crop=${width}:${height}`]:[`scale=${width}:${height}:force_original_aspect_ratio=decrease:reset_sar=1:flags=bilinear`,`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`];
        const media=assets.get(c.mediaId!)!;chain.push(...(media.hasAlpha||media.kind==='image'||c.chromaKey?.enabled?alphaSpatialFilters(fitting):fitting));
        chain.push(...colorFilters(c,height/project.height),'setsar=1');
        layerInput=await colorFiles.append(graph,layerInput,chain,c.colorGrade,project.colorLuts?.find(lut=>lut.id===c.colorGrade?.lutId),`grade${i}`);
        if(c.mask&&c.mask.type!=='none'){
          const file=`mask${i}.pgm`;await writeMask(c,width,height,path.join(work,file));
          graph.push(`[${layerInput}]${chain.join(',')},split[maskcolor${i}][maskalpha${i}]`);
          graph.push(`[maskalpha${i}]alphaextract[originalalpha${i}]`,`movie=${file},format=gray${range.visualFrom<0?`,setpts=PTS-${Math.ceil(-range.visualFrom)+1}/TB`:''}[matte${i}]`,`[originalalpha${i}][matte${i}]blend=all_mode=multiply:repeatlast=1[combinedalpha${i}]`,`[maskcolor${i}][combinedalpha${i}]alphamerge[masked${i}]`);
          layerInput=`masked${i}`;chain.length=0;
        }
        if(c.flipH)chain.push('hflip');if(c.flipV)chain.push('vflip');
        const trackingScale=renderMotionMaximumScale(c),movingScale=(trackingScale!==undefined&&trackingScale!==1)||c.scale!==1||c.keyframes.some(k=>k.scale!==1),movingRotation=renderMotionRotates(c)||c.rotation!==0||c.keyframes.some(k=>k.rotation!==0);
        if(movingScale||movingRotation)chain.push(...alphaPremultiply);
        if(movingScale){const scale=keyframeExpression(c,'scale',localClock),maximum=trackingScale??Math.max(c.scale,...c.keyframes.map(k=>k.scale)),unit=c.motionBinding?1:2,fixedWidth=Math.max(unit,Math.ceil(width*maximum/unit)*unit),fixedHeight=Math.max(unit,Math.ceil(height*maximum/unit)*unit),round=c.motionBinding?'round':'trunc';chain.push(`scale=w='max(${unit},${round}(${width}*(${scale})/${unit})*${unit})':h='max(${unit},${round}(${height}*(${scale})/${unit})*${unit})':eval=frame:flags=bilinear`,`pad=${fixedWidth}:${fixedHeight}:(ow-iw)/2:(oh-ih)/2:color=0x00000000:eval=frame`,'setsar=1');}
        if(movingRotation){
          // rotate's output dimensions are evaluated at initialization. A
          // buffer sized from the first frame clips later scale keyframes.
          // Keep a fixed buffer large enough for all visible rotated content.
          const maximumScale=trackingScale??Math.max(c.scale,...c.keyframes.map(k=>k.scale));
          const diagonal=Math.hypot(width,height)*maximumScale;
          const maxX=Math.max(Math.abs(c.x),...c.keyframes.map(k=>Math.abs(k.x)))*width/project.width;
          const maxY=Math.max(Math.abs(c.y),...c.keyframes.map(k=>Math.abs(k.y)))*height/project.height;
          const rotatedWidth=Math.ceil((trackingScale!==undefined?diagonal:Math.min(diagonal,width+2*maxX))/2)*2;
          const rotatedHeight=Math.ceil((trackingScale!==undefined?diagonal:Math.min(diagonal,height+2*maxY))/2)*2;
          if(trackingScale!==undefined&&rotatedWidth*rotatedHeight>64_000_000)throw new Error('추적 확대·회전 결과가 너무 큽니다. 확대율을 줄이거나 출력 해상도를 낮춰 주세요.');
          chain.push(`rotate=angle='(${keyframeExpression(c,'rotation',localClock)})*PI/180':ow=${rotatedWidth}:oh=${rotatedHeight}:fillcolor=none:bilinear=1`);
        }
        if(movingScale||movingRotation)chain.push(...alphaUnpremultiply);
        const alphaShift=range.visualFrom<0?Math.ceil(-range.visualFrom*fps)+1:0,opacity=alphaExpression(c,alphaShift||phase?`(T-${alphaShift}/${dec(fps)}-${phase})`:'T');
        if(c.keyframes.length||c.fadeIn||c.fadeOut){const file=`alpha${i}.cmd`;await fs.writeFile(path.join(work,file),`0-${dec(range.visualTo+alphaShift/fps+1)} [expr] colorchannelmixer@opacity${i} aa '${opacity}';\n`);if(alphaShift)chain.push(`setpts=PTS+${alphaShift}`);chain.push(`sendcmd=f=${file}`,`colorchannelmixer@opacity${i}=aa=1`);if(alphaShift)chain.push(`setpts=PTS-${alphaShift}`);}
        else if(c.opacity!==1)chain.push(`colorchannelmixer=aa=${dec(c.opacity)}`);
        // FPS has established a 1/fps timebase. Integer frame translation is
        // essential: truncating negative fractional PTS after a window seek
        // otherwise repeats a frame at the boundary.
        chain.push(`setpts=PTS+${Math.floor(c.start*fps+1e-7)-windowFrame}`);
        const x=keyframeExpression(c,'x',`(t+${windowFrame}/${dec(fps)}-${dec(c.start)})`),y=keyframeExpression(c,'y',`(t+${windowFrame}/${dec(fps)}-${dec(c.start)})`);
        const placedX=`(W-w)/2+(${x})*${dec(width/project.width)}`,placedY=`(H-h)/2+(${y})*${dec(height/project.height)}`,track=project.tracks.findIndex(t=>t.id===c.trackId);
        // Subsample chroma AFTER compositing transparent edges. Subsampling a
        // separate alpha layer mixes hidden colors into visible edge pixels.
        if(paired.has(c.id)){
          graph.push(`[${layerInput}]${chain.join(',')},split[rawNormal${i}][rawLayer${i}]`);
          graph.push(`[rawNormal${i}]scale=in_range=pc:out_color_matrix=bt709:out_range=tv,format=yuva444p,setparams=range=limited:colorspace=bt709[layer${i}]`);
          graph.push(`color=c=black@0:s=${width}x${height}:r=${dec(fps)}:d=${dec(duration)},format=rgba[transparent${i}]`);
          graph.push(`[transparent${i}][rawLayer${i}]overlay=x='${placedX}':y='${placedY}':format=auto:alpha=straight:eval=frame:eof_action=repeat:repeatlast=1:enable='${enable(c.start+range.visualFrom,c.start+range.visualTo)}',format=rgba[fullLayer${i}]`);
          const users=pairs.flatMap((pair,index)=>pair.from.id===c.id?[{pair,index,side:'A'}]:pair.to.id===c.id?[{pair,index,side:'B'}]:[]),labels=users.map(user=>`transitionInput${user.index}${user.side}`);
          graph.push(`[fullLayer${i}]${labels.length>1?`split=${labels.length}`:'null'}${labels.map(label=>`[${label}]`).join('')}`);
          draws.push({label:`layer${i}`,x:placedX,y:placedY,track,start:c.start,enable:`(${enable(c.start,c.start+c.duration)})${users.map(({pair})=>`*(1-(${enable(pair.start,pair.end)}))`).join('')}`});
        }else{
          chain.push('scale=in_range=pc:out_color_matrix=bt709:out_range=tv','format=yuva444p','setparams=range=limited:colorspace=bt709');
          graph.push(`[${layerInput}]${chain.join(',')}[layer${i}]`);
          draws.push({label:`layer${i}`,x:placedX,y:placedY,track,start:c.start,enable:enable(c.start,c.start+c.duration)});
        }
        // Fractional clip endpoints can lie after the last resampled source
        // frame. Hold that frame only until the explicit timeline end, avoiding
        // a one-frame black hole at non-frame-aligned joins.
      }
      for(const [i,pair] of pairs.entries()){
        // Expensive premultiplied warps run only for actual transition frames.
        // Preserve PTS for scene placement and give frame-count expressions
        // their original global offset after trimming the pair inputs.
        const firstFrame=Math.max(windowFrame,Math.ceil(pair.start*fps-1e-7)),lastFrame=Math.min(Math.round(windowEnd*fps),Math.ceil(pair.end*fps-1e-7));
        for(const side of ['A','B'])graph.push(`[transitionInput${i}${side}]trim=start_pts=${firstFrame-windowFrame}:end_pts=${lastFrame-windowFrame}[transitionTrim${i}${side}]`);
        if(transitionDevice&&(pair.transition.kind==='slide'||pair.transition.kind==='zoom')){
          const shader=`transition${i}.cl`;await fs.writeFile(path.join(work,shader),transitionOpenClSource(pair,firstFrame,fps));appendOpenClTransition(graph,`transitionTrim${i}A`,`transitionTrim${i}B`,`transitionRGBA${i}`,shader);
          ctx.diagnostics?.({event:'gpu-processing',backend:'opencl-transitions',operations:[pair.transition.kind],transitionId:pair.transition.id,device:transitionDevice});
        }else{
          const opacityCommands=`transition${i}.cmd`;await fs.writeFile(path.join(work,opacityCommands),transitionOpacityCommands(pair,`transitionRGBA${i}`,`(PTS+${windowFrame}+1)/${dec(fps)}`));
          appendTransitionPair(graph,pair,`transitionTrim${i}A`,`transitionTrim${i}B`,`transitionRGBA${i}`,width,height,{warp:`(N+${firstFrame})/${dec(fps)}`,blend:`(N-1+${firstFrame})/${dec(fps)}`},opacityCommands,1-transitionProgress(pair,firstFrame/fps),{fps,frames:lastFrame-firstFrame,startFrame:firstFrame-windowFrame});
        }
        graph.push(`[transitionRGBA${i}]scale=in_range=pc:out_color_matrix=bt709:out_range=tv,format=yuva444p,setparams=range=limited:colorspace=bt709[transitionLayer${i}]`);
        draws.push({label:`transitionLayer${i}`,x:'0',y:'0',track:project.tracks.findIndex(t=>t.id===pair.trackId),start:pair.from.start,enable:enable(pair.start,pair.end)});
      }
      draws.sort((a,b)=>a.track-b.track||a.start-b.start);
      // Keep full chroma until the final encoder conversion. Even a disabled
      // 4:4:4 overlay negotiates its input format, so mixing 4:2:0 and 4:4:4
      // by active window changes pixels before/after a transition.
      for(const [i,draw] of draws.entries()){graph.push(`[${video}][${draw.label}]overlay=x='${draw.x}':y='${draw.y}':format=yuv444:eval=frame:eof_action=repeat:repeatlast=1:enable='${draw.enable}'[composite${i}]`);video=`composite${i}`;}
      const captionGroups=captionLayerGroups(project,windowStart,windowEnd),hasRich=captionGroups.some(group=>group.rich);
      if(hasRich){
        const raster=window?.captionRaster||(ownedRaster=await (ctx.captionRasterFactory||(await import('./caption-raster')).createCaptionRaster)(project,settings,captionControl.signal,ctx.diagnostics));
        captionStreams=new CaptionWindowStreams(raster,failCaption,captionControl.signal);
        // Composite in RGB to preserve integer/subpixel caption placement;
        // 4:2:0 overlay would silently round odd caption origins to even pixels.
        graph.push(`[${video}]scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgba[captionBase]`);video='captionBase';
      }
      let captionInput=inputs.length;
      for(const [index,group] of captionGroups.entries()){
        const label=`textvideo${index}`;
        if(group.rich){
          const stream=await captionStreams!.add(group.clips),bounds=stream.group;
          inputArgs.push('-thread_queue_size','1','-f','rawvideo','-pixel_format','rgba','-video_size',`${bounds.width}x${bounds.height}`,'-framerate',dec(fps),'-probesize','32','-analyzeduration','0','-i',stream.url);
          graph.push(`[${video}][${captionInput++}:v:0]overlay=x=${bounds.x}:y=${bounds.y}:format=rgb:alpha=straight:shortest=1[${label}]`);
          ctx.diagnostics?.({event:'caption-stream',clips:group.clips.length,...bounds,bytesPerFrame:bounds.width*bounds.height*4});
        }else{
          const file=`captions${index}.ass`;await fs.writeFile(path.join(work,file),buildAss({...project,clips:group.clips},settings,window?{start:windowStart,end:windowEnd}:undefined),'utf8');
          graph.push(`[${video}]setpts=PTS+${windowFrame},ass=filename=${file},setpts=PTS-${windowFrame}[${label}]`);
        }
        video=label;
      }
      const rgbWindow=!!window&&settings.format==='gif';
      if(hasRich&&!rgbWindow){graph.push(`[${video}]scale=in_range=pc:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=range=limited:colorspace=bt709[captionYuv]`);video='captionYuv';}
      if(rgbWindow)graph.push(`[${video}]${hasRich?'':'scale=in_color_matrix=bt709:in_range=tv:out_range=pc,'}format=rgb24[videoout]`);
      else if(format==='gif'){graph.push(`[${video}]split[gifsource][palettein]`);graph.push('[palettein]palettegen=stats_mode=single[palette]');graph.push('[gifsource][palette]paletteuse=new=1:dither=sierra2_4a[videoout]');}else graph.push(`[${video}]format=yuv420p[videoout]`);
    }
    if(!window&&format!=='gif'){
      const labels:string[]=[];
      for(let i=0;i<sounds.length;i++){
        const c=sounds[i],index=inputIndex.get(c.id)!;
        const gain=`${dec(c.volume)}*${fadeExpression(c,'t')}`;
        const chain=[`atrim=duration=${dec(c.duration*c.speed)}`,'asetpts=PTS-STARTPTS',...tempoFilters(c.speed),`atrim=duration=${dec(c.duration)}`,'aresample=48000','aformat=sample_fmts=fltp:channel_layouts=stereo',...eqFFmpegFilters(c.audioEQ),`aeval=exprs='val(0)*${gain}|val(1)*${gain}':c=stereo`,'aformat=sample_fmts=fltp:channel_layouts=stereo',`adelay=${Math.round(c.start*1000)}:all=1`];
        graph.push(`[${index}:a:0]${chain.join(',')}[audio${i}]`);labels.push(`[audio${i}]`);
      }
      if(labels.length)graph.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.97:level=0:latency=1,apad=whole_dur=${dec(duration)},atrim=duration=${dec(duration)}[audioout]`);
      else graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${dec(duration)}[audioout]`);
    }
    await fs.writeFile(path.join(work,'filters.txt'),graph.join(';\n'),'utf8');
    const encoder=window?'':await chooseEncoder(settings,ctx,signal);
    const run=async(selected:string)=>{
      const args=[...(transitionDevice?['-init_hw_device',transitionDevice,'-filter_hw_device','sluTransition']:[]),'-filter_complex_threads','2',...(window?['-copyts']:[]),...inputArgs,'-filter_complex_script','filters.txt'];
      if(window){args.push('-map','[videoout]','-an','-frames:v',String(window.frames),'-fps_mode','passthrough','-c:v','rawvideo','-pix_fmt',settings.format==='gif'?'rgb24':'yuv420p','-f','rawvideo',window.destination);try{await Promise.all([ffmpegProgress(ctx,args,duration,work,onProgress,captionControl.signal),captionStreams?.start(windowFrame,window.frames)]);}catch(error){throw captionFailure||error;}return;}
      if(settings.format!=='wav')args.push('-map','[videoout]','-r',dec(fps),'-fps_mode','cfr');
      if(settings.format!=='gif')args.push('-map','[audioout]');
      if(settings.format==='wav')args.push('-c:a','pcm_s16le');
      else if(settings.format==='gif')args.push('-loop','0');
      else {args.push(...encoderArguments(selected,settings.quality),'-pix_fmt','yuv420p','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:a',settings.format==='webm'?'libopus':'aac','-b:a',settings.quality==='high'?'256k':'192k');if(settings.format==='mp4'){args.push('-movflags','+faststart');if(settings.codec==='hevc')args.push('-tag:v','hvc1');}}
      args.push('-t',dec(duration),'-max_muxing_queue_size','2048',temporary);
      onProgress?.(0,selected?`내보내기 · ${selected}`:`내보내기 · ${settings.format.toUpperCase()}`);
      await ffmpegProgress(ctx,args,duration,work,onProgress,signal);
    };
    try{await run(encoder);}catch(error){
      if(isAbort(error)||settings.encoder!=='auto'||!/_nvenc$|_qsv$|_amf$/.test(encoder))throw error;
      onProgress?.(0,'GPU 작업 실패 — CPU 인코딩으로 다시 시도합니다.');
      await run(settings.codec==='av1'?'libsvtav1':settings.codec==='hevc'?'libx265':'libx264');
    }
    if(signal?.aborted)throw new CancelledError();
    if(window)return window.destination;
    const stat=await fs.stat(temporary);if(stat.size<32)throw new Error('완성된 파일이 비어 있습니다.');
    await sources?.verify();await replaceWithRetry(temporary,output);onProgress?.(1,'내보내기가 완료되었습니다.');return output;
  }finally{
    captionControl.abort();signal?.removeEventListener('abort',abortCaptions);await captionStreams?.close();await ownedRaster?.close();
    await fs.rm(temporary,{force:true}).catch(()=>{});
    // Only delete the unique directory returned by mkdtemp inside our cache/work directory.
    if(path.dirname(path.resolve(work))===baseDirectory&&path.basename(work).startsWith('render-'))await fs.rm(work,{recursive:true,force:true}).catch(()=>{});
  }
}

async function checkExportSpace(output:string,project:Project,settings:ExportSettings,ctx:EngineContext){
  const duration=projectDuration(project),estimatedBytes=settings.format==='wav'?Math.ceil(duration*AUDIO_RATE)*4+4096:settings.format==='gif'?duration*settings.width*settings.height*settings.fps*.18:duration*Math.max(1_000_000,settings.width*settings.height*settings.fps*.14)/8;
  const disk=await fs.statfs(path.dirname(output)),availableBytes=disk.bavail*disk.bsize;
  ctx.diagnostics?.({event:'disk-preflight',availableBytes,estimatedBytes,intermediateBytes:0});
  // Compressed output size depends on content. Enforce a small reserve and
  // monitor it during the job; do not reject an otherwise viable export solely
  // because its deliberately conservative bitrate estimate exceeds free space.
  if(availableBytes<Math.max(32*1024*1024,Math.min(estimatedBytes,256*1024*1024)))throw new Error(`저장 공간이 부족합니다. 남은 공간 ${(availableBytes/1024**2).toFixed(0)} MB, 출력 예상 ${(estimatedBytes/1024**2).toFixed(0)} MB입니다.`);
}

/** Bounded timeline exporter. Windows are composed sequentially; raw frames
 * and float PCM stream with backpressure into one final encoder. Neither raw
 * intermediates nor all-project decoder instances accumulate in memory/disk. */
export async function renderProject(project:Project,settings:ExportSettings,ctx:EngineContext,onProgress?:ProgressCallback,signal?:AbortSignal):Promise<string>{
  if(signal?.aborted)throw new CancelledError();
  const sources=await prepareRenderSources(project,settings,ctx,signal,onProgress);project=sources.project;
  await assertOutputNotSource(settings.outputPath!,[...project.media.map(media=>media.path),...(project.motionPaths||[]).map(a=>a.path)]);
  const transitionPlan=compileTransitions(project),output=path.resolve(settings.outputPath!),duration=projectDuration(project),windows=planRenderWindows(project,settings,project.clips.some(c=>c.motionBinding)?Math.min(ctx.maxWindowSeconds??6,6):ctx.maxWindowSeconds,transitionPlan);
  const motion=new RenderMotion(project,signal);if(settings.format!=='wav')await motion.prepare();
  await fs.mkdir(ctx.cacheDir,{recursive:true});await checkExportSpace(output,project,settings,ctx);
  const temporary=path.join(path.dirname(output),`.${path.basename(output)}.${randomUUID()}.partial.${settings.format}`);
  const encoder=await chooseEncoder(settings,ctx,signal),totalSamples=Math.round(duration*AUDIO_RATE);
  const nativeCuda=!transitionPlan.transitions.length&&/_nvenc$/.test(encoder)?await nativeCudaClip(project,settings,ctx,signal):undefined;
  ctx.diagnostics?.({event:'render-plan',windowCount:windows.length,maxVisualInputs:Math.max(0,...windows.map(w=>w.visualInputs)),totalFrames:windows.reduce((n,w)=>n+w.frames,0),totalAudioSamples:totalSamples});
  let usedCuda=false;
  const attempt=async(selected:string,gpuProcessing=ctx.gpuProcessing!==false)=>{
    usedCuda=false;
    const directCuda=gpuProcessing&&/_nvenc$/.test(selected)?nativeCuda:undefined;
    const control=new AbortController();let failure:Error|undefined,encoderPromise:Promise<unknown>|undefined,audioPromise:Promise<void>|undefined,captionRaster:CaptionRasterSession|undefined,lastProgress=0;
    setMaxListeners(64,control.signal);
    const fail=(value:unknown)=>{if(!failure&&!signal?.aborted)failure=value instanceof Error?value:new Error(String(value));control.abort();};
    const abort=()=>control.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)control.abort();
    const video=settings.format==='wav'||directCuda?undefined:await new RawStreamBridge(fail).open(control.signal);
    const audio=settings.format==='gif'?undefined:await new RawStreamBridge(fail).open(control.signal);
    const mixer=audio?new TimelineAudioMixer(project,ctx.ffmpeg,control.signal,event=>ctx.diagnostics?.({...event}),ctx.audioStretch,transitionPlan):undefined;
    const progress:ProgressCallback=(value,message)=>{lastProgress=Math.max(lastProgress,Math.min(.995,value));onProgress?.(lastProgress,message);};
    try{
      if(settings.format!=='wav'&&project.clips.some(clip=>clip.text!==undefined&&(clip.captionStyle||clip.motionBinding)&&visualTrackEnabled(project,project.tracks.find(track=>track.id===clip.trackId))))captionRaster=await (ctx.captionRasterFactory||(await import('./caption-raster')).createCaptionRaster)(project,settings,control.signal,ctx.diagnostics);
      const args:string[]=['-threads','2'];
      if(directCuda){
        usedCuda=true;ctx.diagnostics?.({event:'gpu-processing',backend:'cuda-direct',operations:['decode','scale','encode'],clipId:directCuda.clip.id});
        args.push('-hwaccel','cuda','-hwaccel_output_format','cuda','-protocol_whitelist','file,pipe','-i',directCuda.media.path);
      }
      if(video)args.push('-thread_queue_size','4','-f','rawvideo','-pixel_format',settings.format==='gif'?'rgb24':'yuv420p','-video_size',`${settings.width}x${settings.height}`,'-framerate',dec(settings.fps),'-color_range',settings.format==='gif'?'pc':'tv','-colorspace',settings.format==='gif'?'rgb':'bt709','-color_primaries','bt709','-color_trc',settings.format==='gif'?'iec61966-2-1':'bt709','-probesize','32','-analyzeduration','0','-i',video.consumerUrl);
      if(audio)args.push('-thread_queue_size','8','-f','f32le','-ar',String(AUDIO_RATE),'-ac','2','-probesize','32','-analyzeduration','0','-i',audio.consumerUrl);
      if((video||directCuda)&&settings.format!=='gif')args.push('-map','0:v:0');if(audio)args.push('-map',video||directCuda?'1:a:0':'0:a:0','-af',`alimiter=limit=0.97:level=0:latency=1,atrim=end_sample=${totalSamples}`);
      if(directCuda)args.push('-vf',`settb=AVTB,settb=1/1000000000,setpts=PTS-STARTPTS-500,fps=${dec(settings.fps)}:start_time=0:round=up,trim=end_frame=${Math.round(duration*settings.fps)},scale_cuda=${settings.width}:${settings.height}:reset_sar=1:interp_algo=bilinear:format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709`,'-frames:v',String(Math.round(duration*settings.fps)));
      if(settings.format==='wav')args.push('-c:a','pcm_s16le');
      else if(settings.format==='gif')args.push('-filter_complex','[0:v]split[s][p];[p]palettegen=stats_mode=single[pal];[s][pal]paletteuse=new=1:dither=sierra2_4a[g]','-map','[g]','-an','-loop','0');
      else {args.push(...encoderArguments(selected,settings.quality),...(!directCuda?['-pix_fmt','yuv420p']:[]),'-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:a',settings.format==='webm'?'libopus':'aac','-b:a',settings.quality==='high'?'256k':'192k');if(settings.format==='mp4'){args.push('-movflags','+faststart');if(settings.codec==='hevc')args.push('-tag:v','hvc1');}}
      args.push('-fps_mode','passthrough',temporary);
      progress(0,`구간 렌더링 · ${selected||settings.format.toUpperCase()} · ${windows.length}구간`);
      encoderPromise=ffmpegProgress({...ctx,diagnostics:event=>ctx.diagnostics?.({...event,role:'encoder'})},args,duration,undefined,progress,control.signal);void encoderPromise.catch(fail);
      let nextSample=0;
      // Audio and video must advance independently. Waiting for the audio of
      // every short video window deadlocks encoders whose lookahead exceeds
      // that window; their audio demux queue cannot drain until more video is
      // supplied. Socket backpressure bounds how far either stream can lead.
      audioPromise=(async()=>{if(!mixer||!audio)return;while(nextSample<totalSamples){const count=Math.min(4096,totalSamples-nextSample);await audio.write(await mixer.mix(nextSample,count));nextSample+=count;}await audio.end();})();void audioPromise.catch(fail);
      for(let index=0;!directCuda&&index<windows.length;index++){
        if(control.signal.aborted)throw failure||new CancelledError();
        const window=windows[index];ctx.diagnostics?.({event:'window-start',index,...window});progress(window.start/duration,`합성 ${index+1}/${windows.length} · ${window.visualInputs}개 영상 소스`);
        const received=video?.expectProducer(settings.width*settings.height*(settings.format==='gif'?3:1.5)*window.frames);if(received)void received.catch(fail);
        const motionProject=video?await motion.window(Math.round(window.start*settings.fps),window.frames,settings.fps):project;
        const compose=video?renderProjectDirect(motionProject,settings,{...ctx,gpuProcessing,diagnostics:event=>{if(event.event==='gpu-processing')usedCuda=true;ctx.diagnostics?.({...event,role:'window',index});}},undefined,control.signal,{...window,destination:video.producerUrl,transitionPlan:{...transitionPlan,project:motionProject},captionRaster}):Promise.resolve();
        void compose.catch(fail);
        await Promise.all([compose,received]);ctx.diagnostics?.({event:'window-end',index,videoBytes:video?.totalBytes||0,audioBytes:audio?.totalBytes||0});
        const disk=await fs.statfs(path.dirname(output));if(disk.bavail*disk.bsize<16*1024*1024)throw new Error('내보내기 중 저장 공간이 부족해 작업을 중단했습니다.');
      }
      await video?.end();await audioPromise;await encoderPromise;
      ctx.diagnostics?.({event:'stream-metrics',peakVideoBufferBytes:video?.peakBufferedBytes||0,peakAudioBufferBytes:audio?.peakBufferedBytes||0,peakAudioDecoders:mixer?.peakActiveSources||0});
    }catch(error){fail(error);if(signal?.aborted)throw new CancelledError();throw failure||error;}
    finally{control.abort();signal?.removeEventListener('abort',abort);video?.close();audio?.close();await Promise.allSettled([encoderPromise,audioPromise,mixer?.close(),captionRaster?.close()]);}
  };
  try{
    try{
      try{await attempt(encoder);}catch(error){if(signal?.aborted||!usedCuda)throw error;ctx.diagnostics?.({event:'gpu-fallback',encoder,reason:error instanceof Error?error.message:String(error)});onProgress?.(0,'GPU 영상 처리를 완료하지 못해 처음부터 CPU 처리로 다시 시도합니다.');await attempt(encoder,false);}
    }catch(error){if(signal?.aborted||settings.encoder!=='auto'||!/_nvenc$|_qsv$|_amf$/.test(encoder))throw error;onProgress?.(0,'GPU 인코딩을 완료하지 못해 CPU로 다시 시도합니다.');await attempt(settings.codec==='av1'?'libsvtav1':settings.codec==='hevc'?'libx265':'libx264',false);}
    if(signal?.aborted)throw new CancelledError();const stat=await fs.stat(temporary);if(stat.size<32)throw new Error('내보낸 파일이 비어 있습니다.');await sources.verify();if(settings.format!=='wav')await motion.verify();await replaceWithRetry(temporary,output);onProgress?.(1,'내보내기가 완료되었습니다.');return output;
  }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
}
