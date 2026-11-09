import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {availableParallelism,constants,setPriority} from 'node:os';
import type {MediaAsset,StabilizationOptions} from '../shared/types';
import {CancelledError,probeMedia,runProcess,type EngineContext,type ProgressCallback} from './media';
import {assertOutputNotSource,insideDirectory,localFilePath} from './file-policy';
import {readSourceRevision,requireSourceRevision} from './source-revision';
import {previewVideoColor,previewColorPrefix} from './video-color';
import {mediaTimingFromProbe} from './media-timing';
import {presentedFrameTime} from './video-frame';
import {videoDecoderArgs,videoHasAlpha} from './video-input';
import {shareAlphaTransforms} from './stabilization-alpha';
import {ffmpegSeconds,fileSizeTimeout,sizeScaledTimeout} from './ffmpeg-time';

export interface StabilizationContext extends EngineContext {derivedDir?:string}
export interface NormalizedStabilizationOptions {
  start:number;duration:number;smoothing:number;accuracy:number;shakiness:number;crop:'auto'|'black';zoom:number;
}
const capabilities=new Map<string,boolean>();
const decimal=(value:number)=>ffmpegSeconds(value,9);
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const abortIfRequested=(signal?:AbortSignal)=>{if(signal?.aborted)throw new CancelledError();};

function bounded(value:unknown,fallback:number,min:number,max:number,label:string,integer=false):number {
  if(value===undefined)value=fallback;
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||(integer&&!Number.isInteger(value)))
    throw new Error(`${label} 설정이 올바르지 않습니다.`);
  return value;
}

/** Public validation also runs in the backend; renderer values are not trusted. */
export function normalizeStabilizationOptions(options:StabilizationOptions,sourceDuration:number):NormalizedStabilizationOptions {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('흔들림 보정 설정이 필요합니다.');
  if(!Number.isFinite(sourceDuration)||sourceDuration<=0)throw new Error('원본 영상의 길이를 확인할 수 없습니다.');
  const start=bounded(options.start,0,0,Math.min(864000,sourceDuration),'시작 시간');
  const duration=bounded(options.duration,sourceDuration-start,.001,86400,'구간 길이');
  if(start>=sourceDuration||start+duration>sourceDuration+.002)throw new Error('보정 구간이 원본 영상의 범위를 벗어났습니다.');
  const shakiness=bounded(options.shakiness,5,1,10,'흔들림',true);
  const accuracy=bounded(options.accuracy,15,5,15,'분석 정확도',true);
  if(accuracy<shakiness)throw new Error('분석 정확도는 흔들림 값 이상이어야 합니다.');
  const crop=options.crop??'auto';
  if(crop!=='auto'&&crop!=='black')throw new Error('가장자리 처리 설정이 올바르지 않습니다.');
  return {start,duration:Math.min(duration,sourceDuration-start),shakiness,accuracy,crop,
    smoothing:bounded(options.smoothing,30,0,120,'평활화',true),zoom:bounded(options.zoom,0,0,20,'확대')};
}

export async function supportsStabilization(ctx:EngineContext,signal?:AbortSignal):Promise<boolean> {
  abortIfRequested(signal);
  const key=path.resolve(ctx.ffmpeg),cached=capabilities.get(key);
  if(cached!==undefined)return cached;
  const result=await runProcess(ctx.ffmpeg,['-hide_banner','-filters'],{signal,timeoutMs:20000});
  const text=result.stdout.toString()+result.stderr;
  const supported=/\bvidstabdetect\b/.test(text)&&/\bvidstabtransform\b/.test(text);
  capabilities.set(key,supported);return supported;
}

interface StreamInfo {
  index:number;codec_type:string;codec_name?:string;width?:number;height?:number;pix_fmt?:string;
  bits_per_raw_sample?:string;color_space?:string;color_transfer?:string;color_primaries?:string;color_range?:string;
  sample_aspect_ratio?:string;sample_rate?:string;channels?:number;duration?:string;
  disposition?:{attached_pic?:number};tags?:{alpha_mode?:string;ALPHA_MODE?:string;rotate?:string};side_data_list?:{rotation?:number}[];
}
async function sourceInfo(file:string,ctx:EngineContext,signal?:AbortSignal) {
  const result=await runProcess(ctx.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',file],{signal,timeoutMs:60000});
  const info=JSON.parse(result.stdout.toString()) as {streams:StreamInfo[];format:{duration?:string;start_time?:string;format_name?:string}};
  const video=info.streams.find(s=>s.codec_type==='video'&&!s.disposition?.attached_pic);
  if(!video||!video.width||!video.height)throw new Error('흔들림 보정은 영상 파일에 사용할 수 있습니다.');
  if(video.width>16384||video.height>16384)throw new Error('흔들림 보정에 지원하지 않는 영상 크기입니다.');
  const colors={...video,width:video.width,height:video.height},alpha=videoHasAlpha(colors),pixel=video.pix_fmt||'';
  const eightBit=/^(?:yuvj?(?:410|411|420|422|440|444)p|nv12|nv21|nv16|nv24|nv42|yuyv422|uyvy422|yvyu422|gray|gray8|rgb24|bgr24|gbrp|rgb0|bgr0|0rgb|0bgr|yuva(?:420|422|444)p|gbrap|rgba|bgra|argb|abgr|ya8|pal8)$/.test(pixel);
  if(Number(video.bits_per_raw_sample)>8||!eightBit||
      ['smpte2084','arib-std-b67'].includes(video.color_transfer||'')||['bt2020','smpte431','smpte432'].includes(video.color_primaries||'')||['bt2020nc','bt2020c','ictcp'].includes(video.color_space||''))
      throw new Error('현재 흔들림 보정은 8비트 SDR(BT.601/709) 영상만 지원합니다. HDR·고비트 영상을 자동 변환하지 않습니다.');
  // Stabilization operates on planar 8-bit frames. Keep existing chroma detail
  // for 4:2:2 / 4:4:4 input; those derived files may need the normal preview proxy.
  const format=/444|gbr|rgb|bgr/.test(pixel)?'yuv444p':/422/.test(pixel)?'yuv422p':'yuv420p';
  const color=previewVideoColor(colors),clock=mediaTimingFromProbe(info),rgb=/^(?:gbr|rgb|bgr|argb|abgr|rgba|bgra)/.test(pixel);
  if(alpha){
    const sar=(video.sample_aspect_ratio||'1:1').split(':').map(Number),ratio=sar[1]>0&&sar[0]>0?sar[0]/sar[1]:1,w=Math.round(video.width*Math.max(1,ratio)),h=Math.round(video.height*Math.max(1,1/ratio));
    if(w>8192||h>8192||w*h>35_000_000)throw new Error('투명 영상 보정은 최대 8192픽셀·3,500만 화소까지 지원합니다.');
    if(!['bt601','bt709','fcc','smpte240m','gbr'].includes(color.matrix))throw new Error('이 영상의 색상 행렬은 투명 영상 보정을 지원하지 않습니다.');
  }
  const known=(value?:string)=>!!value&&!['unknown','unspecified','reserved'].includes(value),specified=known(video.color_space)&&known(video.color_primaries)&&known(video.color_transfer),retain=specified||['vp9','av1'].includes(video.codec_name||'');
  const matrix=rgb?'bt709':color.matrix==='bt601'?'smpte170m':color.matrix,range=rgb?'tv':color.range;
  const primaries=retain&&known(video.color_primaries)?video.color_primaries!:matrix==='smpte170m'?'smpte170m':'bt709',transfer=retain&&known(video.color_transfer)?video.color_transfer!:matrix==='smpte170m'?'smpte170m':'bt709';
  return {video,alpha,decoder:videoDecoderArgs(colors),format,color,colorPrefix:previewColorPrefix(colors),matrix,range,primaries,transfer,rgb,clock,duration:clock.duration,audio:info.streams.filter(s=>s.codec_type==='audio')};
}

/** FFmpeg's two-pass libvidstab implementation, with identical decoded frame
 * selection in both passes. No proxy size/fps conversion is introduced.
 * Reference: https://ffmpeg.org/ffmpeg-filters.html#vidstabdetect
 * and https://ffmpeg.org/ffmpeg-filters.html#vidstabtransform . */
export async function stabilizeMedia(media:MediaAsset,options:StabilizationOptions,ctx:StabilizationContext,
  progress?:ProgressCallback,signal?:AbortSignal):Promise<MediaAsset> {
  abortIfRequested(signal);
  if(media.kind!=='video'||!localFilePath(media.path))throw new Error('흔들림 보정에는 로컬 영상 파일이 필요합니다.');
  // Reject malformed options before opening a source or spawning a process.
  normalizeStabilizationOptions(options,media.duration);
  const inputRevision=await requireSourceRevision(media.path,media.sourceRevision);
  const sourceUnchanged=async()=>{abortIfRequested(signal);await requireSourceRevision(media.path,inputRevision);};
  if(!await supportsStabilization(ctx,signal))throw new Error('FFmpeg에 vidstabdetect/vidstabtransform 흔들림 보정 기능이 없습니다.');
  const info=await sourceInfo(media.path,ctx,signal),settings=normalizeStabilizationOptions(options,info.duration);
  await sourceUnchanged();
  const derived=path.resolve(ctx.derivedDir||path.join(ctx.cacheDir,'derived'));
  if(!localFilePath(derived))throw new Error('보정 영상 저장 폴더가 올바르지 않습니다.');
  await fs.mkdir(derived,{recursive:true});
  const work=await fs.mkdtemp(path.join(derived,'.stabilize-'));
  const filename=`${path.parse(path.basename(media.path)).name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,70)||'video'}-stabilized-${randomUUID()}.mov`;
  const target=path.join(derived,filename),temporary=path.join(work,'stabilized.mov');
  let published=false,complete=false,lastProgress=0;
  const notify=(value:number,message:string)=>{lastProgress=Math.max(lastProgress,clamp(value,0,1));try{progress?.(lastProgress,message);}catch{/* UI teardown cannot orphan the child process. */}};
  const diagnostic=(event:Record<string,unknown>)=>{try{ctx.diagnostics?.(event);}catch{}};
  try{
    await assertOutputNotSource(target,[media.path]);await assertOutputNotSource(temporary,[media.path]);
    const threads=Math.max(1,Math.min(8,availableParallelism()-1));
    // Square-pixel input is unchanged. Non-square pixels are normalized without
    // reducing either encoded axis, so rotation compensation has correct geometry.
    const firstFrame=await presentedFrameTime(media.path,info.video.index,info.clock.timing.origin,settings.start,ctx,signal);await sourceUnchanged();
    const at=Math.round((info.clock.timing.origin+settings.start)*1e6),until=Math.round((info.clock.timing.origin+settings.start+settings.duration)*1e6);
    if(firstFrame>=until)throw new Error('선택 구간에 영상 프레임이 없습니다.');
    // Keep the held frame at the cut. Accurate input seeking drops this frame
    // when the cut is between timestamps. Clamp only its negative local PTS;
    // preserve all subsequent VFR timestamps and any genuine video delay.
    const clock=`settb=AVTB,trim=start_pts=${firstFrame}:end_pts=${until},setpts='max(PTS-${at},0)'`;
    const conversion=info.rgb?'':`:in_color_matrix=${info.color.matrix}:in_range=${info.color.range}`,matrix=info.matrix==='smpte170m'?'bt601':info.matrix;
    // Convert chroma at native size, then premultiply BEFORE any geometry
    // resampling. Hidden RGB must not bleed into translucent foreground edges.
    // lut2 precomputes the exact rounded 8-bit product. FFmpeg's premultiply8
    // divides by 256, darkening even fully opaque pixels; bicubic sampling can
    // amplify that error. A shared alpha lookup divides by 255 and keeps A.
    const alphaPrefix=`[0:${info.video.index}]${clock},${info.colorPrefix}scale=iw:ih:flags=bilinear+full_chroma_int+accurate_rnd${conversion}:out_range=pc,format=gbrap,setparams=range=full,split[straight][mask];[mask]alphaextract,format=gbrap[opacity];[straight][opacity]lut2=c0='floor((x*y+127)/255)':c1='floor((x*y+127)/255)':c2='floor((x*y+127)/255)':c3=x,scale=w='round(iw*max(sar,1))':h='round(ih*max(1/sar,1))':flags=bilinear+accurate_rnd,setsar=1,format=gbrap,setparams=range=full:colorspace=gbr:color_primaries=bt709:color_trc=iec61966-2-1`;
    const prefix=`${clock},${info.colorPrefix}scale=w='ceil(iw*max(sar,1)/2)*2':h='ceil(ih*max(1/sar,1)/2)*2':flags=lanczos${conversion}:out_color_matrix=${matrix}:out_range=${info.range},setsar=1,format=${info.format},setparams=range=${info.range==='pc'?'full':'limited'}:colorspace=${info.matrix}:color_primaries=${info.primaries}:color_trc=${info.transfer}`;
    const analyzeFilter=(tail:string)=>info.alpha?['-filter_complex_threads','2','-filter_complex',`${alphaPrefix},format=gray,${tail}[analyzed]`,'-map','[analyzed]']:['-map',`0:${info.video.index}`,'-vf',`${prefix},${tail}`];
    const seek=Math.max(0,(firstFrame/1e6-info.clock.timing.origin)-1);
    const input=['-copyts','-threads',String(threads),...(seek>0?['-ss',decimal(seek),'-noaccurate_seek']:[]),...info.decoder,'-protocol_whitelist','file,pipe','-i',media.path];
    // Seeking even to zero resets AAC decoder state (including its noise seed).
    // Decode audio from the beginning on its own input when video uses a seek;
    // atrim discards the preroll without buffering it or altering sample values.
    const separateAudio=seek>0&&info.audio.length>0;
    const audioInput=separateAudio?['-threads',String(threads),'-protocol_whitelist','file,pipe','-i',media.path]:[];
    const pass=async(args:string[],phase:'analyze'|'fit'|'transform',offset:number,span:number)=>{
      const control=new AbortController();const combined=signal?AbortSignal.any([signal,control.signal]):control.signal;
      let idle:ReturnType<typeof setTimeout>|undefined,timedOut=false,pending='',written=0;
      // No progress is printed while +faststart rewrites the finished file.
      const reset=()=>{if(idle)clearTimeout(idle);idle=setTimeout(()=>{timedOut=true;control.abort();},sizeScaledTimeout(180000,written));idle.unref();};
      reset();
      try{
        await runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y','-filter_threads',String(Math.min(4,threads)),
          '-stats_period','0.25','-progress','pipe:1',...args],{cwd:work,signal:combined,captureStdout:false,
          // Keep field ordering stable for reproducible motion estimation.
          // Decoder/encoder threads stay enabled.
          env:{...process.env,OMP_NUM_THREADS:'1',OMP_DYNAMIC:'FALSE'},
          onSpawn:pid=>{try{setPriority(pid,constants.priority.PRIORITY_BELOW_NORMAL);}catch{}queueMicrotask(()=>diagnostic({event:'stabilization-process',phase,pid}));},
          onStderr:reset,onStdout:data=>{
            reset();pending+=data.toString();const lines=pending.split(/\r?\n/);pending=lines.pop()||'';
            for(const line of lines)if(line.startsWith('total_size='))written=Number(line.slice(11))||written;else if(line.startsWith('out_time_us=')){
              const elapsed=Number(line.slice(12))/1e6;
              if(Number.isFinite(elapsed))notify(offset+span*clamp(elapsed/settings.duration,0,1),phase==='analyze'?'카메라 움직임 분석 중':phase==='fit'?'보정 경로 계산 중':'흔들림 보정 영상 생성 중');
            }
          }});
      }catch(error){if(timedOut&&!signal?.aborted)throw new Error('흔들림 보정 프로세스가 오랫동안 응답하지 않아 중단했습니다.');throw error;}
      finally{if(idle)clearTimeout(idle);}
    };
    diagnostic({event:'stabilization-plan',backend:'libvidstab-cpu',settings,source:media.path,output:target,format:info.alpha?'bgra':info.format,alpha:info.alpha});
    notify(0,'카메라 움직임 분석 중');
    await sourceUnchanged();
    // Fine search at high accuracy avoids periodic-texture aliases that a
    // six-pixel search stride can otherwise mistake for camera movement.
    // ASCII motion records make the two-pass interchange portable and auditable.
    const stepSize=Math.max(1,Math.round((16-settings.accuracy)/2));
    await pass([...input,'-an','-sn','-dn',...analyzeFilter(`vidstabdetect=result=transforms.trf:fileformat=ascii:shakiness=${settings.shakiness}:accuracy=${settings.accuracy}:stepsize=${stepSize}:mincontrast=.25`),
      '-fps_mode:v','passthrough','-enc_time_base:v','filter','-f','null','-'],'analyze',0,.45);
    abortIfRequested(signal);await sourceUnchanged();
    const transformHandle=await fs.open(path.join(work,'transforms.trf'),'r');
    let hasFrames=false;
    try{const header=Buffer.alloc(512);const {bytesRead}=await transformHandle.read(header,0,header.length,0);hasFrames=/\bFrame\s+1\b/.test(header.subarray(0,bytesRead).toString());}
    finally{await transformHandle.close();}
    if(!hasFrames)throw new Error('선택 구간에서 분석할 영상 프레임을 찾지 못했습니다.');
    let alphaFrames=0;
    if(info.alpha){
      notify(.45,'보정 경로 계산 중');
      await pass([...input,'-an','-sn','-dn',...analyzeFilter(`copy,vidstabtransform=input=transforms.trf:smoothing=${settings.smoothing}:optalgo=gauss:relative=1:crop=black:optzoom=0:debug=1`),'-frames:v','1','-f','null','-'],'fit',.45,0);
      await sourceUnchanged();alphaFrames=await shareAlphaTransforms(path.join(work,'global_motions.trf'),path.join(work,'rigid.trf'),signal);
    }
    notify(.45,'흔들림 보정 영상 생성 중');
    // Always feed an owned frame to libvidstab. Its src-buffer initialization
    // assumes the first frame's writable/shared state remains consistent; a
    // decoder changing that state can otherwise corrupt a later frame.
    // FFmpeg's copy filter preserves pixels/timestamps and guarantees ownership.
    if(info.alpha){
      // Gray planes use a zero border; packed RGBA in libvidstab fills alpha
      // with 16. Use identical bicubic sampling on all premultiplied planes.
      // Pinned libvidstab's bilinear kernel adds 1 even to an all-zero sample,
      // making fully transparent areas visible; bicubic preserves zero.
      const warp=`copy,vidstabtransform=input=rigid.trf:smoothing=${settings.smoothing}:optalgo=gauss:relative=1:crop=black:optzoom=${settings.crop==='auto'?1:0}:zoom=${settings.zoom}:interpol=bicubic`;
      const graph=`${alphaPrefix},extractplanes=r+g+b+a[r][g][b][a];[r]${warp}[rr];[g]${warp}[gg];[b]${warp}[bb];[a]${warp}[aa];[gg][bb][rr][aa]mergeplanes=map0s=0:map1s=1:map2s=2:map3s=3:format=gbrap,unpremultiply=inplace=1,format=bgra[out]`;
      await pass([...input,...audioInput,'-filter_complex_threads','2','-filter_complex',graph,'-map','[out]','-map',`${separateAudio?1:0}:a?`,'-sn','-dn','-map_metadata','-1','-map_chapters','-1',
        '-fps_mode:v','passthrough','-enc_time_base:v','1:1000000','-c:v','ffv1','-level','3','-g','30','-threads',String(threads),'-pix_fmt','bgra',
        '-color_range','pc','-colorspace','rgb','-color_primaries','bt709','-color_trc','iec61966-2-1','-metadata:s:v:0','rotate=0',
        '-bsf:v',`setts=duration='if(eq(N,${alphaFrames-1}),${until-at}-PTS,DURATION)'`,
        ...(info.audio.length?['-af',`atrim=start=${decimal(at/1e6)}:end=${decimal(until/1e6)},asetpts=PTS-round(${decimal(at/1e6)}/TB)`]:[]),
        '-c:a','pcm_f32le','-video_track_timescale','1000000','-movie_timescale','1000000','-movflags','+faststart','-f','mov',temporary],'transform',.45,.5);
    }else await pass([...input,...audioInput,'-map',`0:${info.video.index}`,'-map',`${separateAudio?1:0}:a?`,'-sn','-dn','-map_metadata','0','-map_chapters','-1',
      '-vf',`${prefix},copy,vidstabtransform=input=transforms.trf:smoothing=${settings.smoothing}:optalgo=gauss:relative=1:crop=black:optzoom=${settings.crop==='auto'?1:0}:zoom=${settings.zoom}:interpol=bicubic`,
      '-fps_mode:v','passthrough','-enc_time_base:v','filter','-c:v','libx264','-preset','medium','-crf','16','-threads',String(threads),'-pix_fmt',info.format,
      '-colorspace',info.matrix,'-color_range',info.range,'-color_primaries',info.primaries,'-color_trc',info.transfer,'-metadata:s:v:0','rotate=0',...(info.audio.length?['-af',`atrim=start=${decimal(at/1e6)}:end=${decimal(until/1e6)},asetpts=PTS-round(${decimal(at/1e6)}/TB)`]:[]),
      '-c:a','pcm_f32le','-movie_timescale','1000000','-movflags','+faststart','-f','mov',temporary],'transform',.45,.5);
    abortIfRequested(signal);await sourceUnchanged();notify(.96,'보정 영상 확인 중');
    const result=await probeMedia(temporary,ctx,signal,{derivatives:false});
    if(result.kind!=='video'||!result.width||!result.height||!Number.isFinite(result.duration)||result.duration<=0)
      throw new Error('보정 영상 검증에 실패했습니다.');
    if(result.hasAudio!==Boolean(info.audio.length))throw new Error('보정 영상의 오디오가 원본과 일치하지 않습니다.');
    if(info.alpha){
      if(!result.hasAlpha||Math.abs(result.duration-settings.duration)>.002)throw new Error('보정 영상의 투명도 또는 길이가 일치하지 않습니다.');
      const count=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-count_packets','-select_streams','v:0','-show_entries','stream=nb_read_packets','-of','json',temporary],{signal,timeoutMs:await fileSizeTimeout(120000,temporary)})).stdout.toString()).streams?.[0]?.nb_read_packets;
      if(Number(count)!==alphaFrames)throw new Error('보정 영상의 프레임 수가 일치하지 않습니다.');
    }
    // Publish a complete file without replacing any existing path. The staging
    // folder is on the same volume as the destination; link creation is atomic.
    await sourceUnchanged();await fs.link(temporary,target);published=true;abortIfRequested(signal);
    await fs.unlink(temporary);const sourceRevision=await readSourceRevision(target);
    await sourceUnchanged();
    complete=true;notify(1,'흔들림 보정이 완료되었습니다.');
    return {...result,path:target,sourceRevision,name:`${media.name} · 흔들림 보정`};
  }finally{
    if(published&&!complete)await fs.rm(target,{force:true}).catch(()=>{});
    const actualWork=await fs.realpath(work).catch(()=>undefined),actualDerived=await fs.realpath(derived).catch(()=>undefined);
    if(actualWork&&actualDerived&&insideDirectory(actualWork,actualDerived))await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
  }
}
