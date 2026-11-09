import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {MediaAsset} from '../shared/types';
import {CancelledError,probeMedia,runProcess,type EngineContext,type ProgressCallback} from './media';
import {localFilePath} from './file-policy';
import {requireSourceRevision,readSourceRevision} from './source-revision';
import {mediaTimingFromProbe} from './media-timing';
import {previewVideoColor,previewColorPrefix,type VideoColorInfo} from './video-color';
import {videoDecoderArgs,videoHasAlpha} from './video-input';
import {alphaSpatialFilters} from './alpha-filters';
import {ffmpegSeconds} from './ffmpeg-time';

interface VideoInfo extends VideoColorInfo {index:number;sample_aspect_ratio?:string;tags?:{rotate?:string;alpha_mode?:string;ALPHA_MODE?:string}}
/** Match the native preview's SDR matrix fallback and bilinear chroma sampling.
 * Chromium media/ffmpeg/ffmpeg_common.cc uses natural height for incomplete
 * color tags, except VP9/AV1 where stream color information takes precedence. */
export function freezeColorFilter(video:VideoInfo):string {
  if(['smpte2084','arib-std-b67'].includes(video.color_transfer||'')||['bt2020','smpte431','smpte432'].includes(video.color_primaries||'')||['bt2020nc','bt2020c','ictcp'].includes(video.color_space||''))throw new Error('HDR·광색역 영상의 정지 프레임은 아직 지원하지 않습니다. SDR 영상으로 변환해 주세요.');
  const {matrix:conversion,range}=previewVideoColor(video);
  if(!['bt601','bt709','fcc','smpte240m','gbr'].includes(conversion!))throw new Error('이 영상의 색상 행렬은 정지 프레임 변환을 지원하지 않습니다.');
  const rgb=/^(?:gbr|rgb|bgr|argb|abgr|rgba|bgra)/.test(video.pix_fmt||'');
  // Native video first converts chroma at encoded resolution, then scales the
  // RGB image to its display aspect. Combining those steps shifts colored edges.
  const sizing=["scale=w='round(iw*max(sar,1))':h='round(ih*max(1/sar,1))':flags=bilinear+accurate_rnd"];
  const spatial=videoHasAlpha(video)?alphaSpatialFilters(sizing):sizing;
  return `${previewColorPrefix(video)}scale=iw:ih:flags=bilinear+full_chroma_int+accurate_rnd${rgb?'':`:in_color_matrix=${conversion}:in_range=${range}`}:out_range=pc,format=rgba,${spatial.join(',')},setsar=1,setparams=range=full:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=gbr`;
}

export async function freezeFrame(media:MediaAsset,time:number,ctx:EngineContext&{derivedDir?:string},progress?:ProgressCallback,signal?:AbortSignal):Promise<MediaAsset>{
  const abort=()=>{if(signal?.aborted)throw new CancelledError();};abort();
  if(media.kind!=='video'||!localFilePath(media.path))throw new Error('정지 프레임에는 로컬 영상 클립이 필요합니다.');
  if(!Number.isFinite(time)||time<0||time>=media.duration)throw new Error('정지 프레임 시각이 원본 범위를 벗어났습니다.');
  const revision=await requireSourceRevision(media.path,media.sourceRevision),unchanged=async()=>{abort();await requireSourceRevision(media.path,revision);};
  const info=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',media.path],{signal,timeoutMs:60000})).stdout.toString());
  const video=info.streams?.find((s:any)=>s.codec_type==='video'&&!s.disposition?.attached_pic) as VideoInfo|undefined;
  if(!video||!video.width||!video.height)throw new Error('원본 영상 스트림을 찾지 못했습니다.');
  const sar=(video.sample_aspect_ratio||'1:1').split(':').map(Number),ratio=sar[1]&&sar[0]>0?sar[0]/sar[1]:1,w=Math.round(video.width*Math.max(1,ratio)),h=Math.round(video.height*Math.max(1,1/ratio));
  if(w>8192||h>8192||w*h>35_000_000)throw new Error('정지 프레임은 최대 8192픽셀·3,500만 화소까지 지원합니다.');
  const clock=mediaTimingFromProbe(info);if(time>=clock.duration)throw new Error('정지 프레임 시각이 원본 범위를 벗어났습니다.');
  const colors=freezeColorFilter(video),directory=path.resolve(ctx.derivedDir||path.join(ctx.cacheDir,'derived'));if(!localFilePath(directory))throw new Error('정지 프레임 저장 폴더가 올바르지 않습니다.');
  await fs.mkdir(directory,{recursive:true});const id=randomUUID(),label=path.parse(media.path).name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,70)||'video';
  const target=path.join(directory,`${label}-freeze-${id}.png`),partial=path.join(directory,`.freeze-${id}.partial.png`);let published=false,complete=false;
  try{
    await unchanged();progress?.(0,'원본 프레임 추출 중');
    // Keep absolute PTS until selection: input -ss otherwise rounds away a
    // fractional request at the stream time base. fps uses a two-frame buffer
    // and chooses the last presented frame at/before the requested instant.
    const at=Math.round((clock.timing.origin+time)*1e6),select=`settb=AVTB,setpts=PTS-${at},fps=fps=1:start_time=0:round=up`;
    // FFmpeg's native VP8/VP9 decoders omit WebM's separate alpha plane. The
    // bundled libvpx decoder reads it; retain that plane in the derived PNG.
    const decoder=videoDecoderArgs(video);
    await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-copyts','-ss',ffmpegSeconds(Math.max(0,time-1)),'-noaccurate_seek','-threads','2',...decoder,'-protocol_whitelist','file,pipe','-i',media.path,'-map',`0:${video.index}`,'-an','-sn','-dn','-filter_threads','2','-vf',`${select},${colors}`,'-frames:v','1','-fps_mode','passthrough','-map_metadata','-1','-c:v','png','-threads','1','-update','1',partial],{signal,timeoutMs:120000,onSpawn:pid=>ctx.diagnostics?.({event:'freeze-frame-start',pid})});
    await unchanged();progress?.(.9,'정지 프레임 확인 중');
    const asset=await probeMedia(partial,ctx,signal,{derivatives:false});if(asset.kind!=='image'||!asset.width||!asset.height)throw new Error('정지 프레임을 확인하지 못했습니다.');
    await unchanged();await fs.link(partial,target);published=true;await unchanged();await fs.unlink(partial);
    const result={...asset,path:target,name:`${media.name} · ${time.toFixed(3)}초`,sourceRevision:await readSourceRevision(target)};await unchanged();complete=true;progress?.(1,'정지 프레임 준비 완료');return result;
  }finally{await fs.rm(partial,{force:true}).catch(()=>{});if(published&&!complete)await fs.rm(target,{force:true}).catch(()=>{});}
}
