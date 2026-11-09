import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {availableParallelism,constants,setPriority} from 'node:os';
import type {MediaAsset,ReverseOptions} from '../shared/types';
import {CancelledError,detectEncoders,probeMedia,runProcess,type EngineContext,type ProgressCallback} from './media';
import {assertOutputNotSource,insideDirectory,localFilePath} from './file-policy';
import {requireSourceRevision,readSourceRevision} from './source-revision';
import {mediaTimingFromProbe} from './media-timing';
import {previewVideoColor,previewColorPrefix,type VideoColorInfo} from './video-color';
import {spoolReverseFrames,timestampExpression,reversePcmFile} from './reverse-frames';
import {ffmpegSeconds,fileSizeTimeout,sizeScaledTimeout} from './ffmpeg-time';

export type {ReverseOptions} from '../shared/types';
export interface ReverseContext extends EngineContext {derivedDir?:string;reverseBufferBytes?:number;reverseEncoder?:'cpu'|'auto';reverseDecoder?:'cpu'|'auto'}
interface Stream extends VideoColorInfo {index:number;codec_type:string;bits_per_raw_sample?:string;sample_aspect_ratio?:string;sample_rate?:string;channels?:number;channel_layout?:string;disposition?:{attached_pic?:number}}
const dec=(n:number)=>ffmpegSeconds(n,9);
export function normalizeReverseOptions(options:ReverseOptions,duration:number):{start:number;duration:number}{
  if(!options||typeof options!=='object'||Array.isArray(options)||!Number.isFinite(duration)||duration<=0)throw new Error('역재생 구간이 올바르지 않습니다.');
  const start=options.start??0,span=options.duration??duration-start;
  if(!Number.isFinite(start)||start<0||start>=duration||!Number.isFinite(span)||span<.001||span>86400||start+span>duration+.002)throw new Error('역재생 구간이 원본 범위를 벗어났습니다.');
  return {start,duration:Math.min(span,duration-start)};
}

function videoPlan(video:Stream){
  const pixel=video.pix_fmt||'';
  // Generated cutouts are square-pixel, unrotated, full-range sRGB FFV1.
  // Reordering these bytes must not pass through H264/YUV or lose alpha.
  // MOV may omit color tags on FFV1. Untagged 8-bit RGB follows the editor's
  // established SDR interpretation; explicitly different/HDR tags stay out.
  if(video.codec_name==='ffv1'&&pixel==='bgra'&&['1:1','N/A',undefined].includes(video.sample_aspect_ratio)&&!Number(video.side_data_list?.find(s=>s.rotation!==undefined)?.rotation??video.tags?.rotate??0)&&[undefined,'unknown','bt709'].includes(video.color_primaries)&&[undefined,'unknown','iec61966-2-1'].includes(video.color_transfer)&&[undefined,'unknown','pc'].includes(video.color_range)){
    if(!Number.isInteger(video.width)||!Number.isInteger(video.height)||video.width<1||video.height<1||video.width>16384||video.height>16384)throw new Error('역재생 영상 크기가 지원 범위를 벗어났습니다.');
    return {filter:'format=bgra,setsar=1',format:'bgra',cudaEligible:false,cudaFilter:'',cudaFrameBytes:0,frameBytes:video.width*video.height*4,tags:['-colorspace','rgb','-color_range','pc','-color_primaries','bt709','-color_trc','iec61966-2-1']};
  }
  if(/^(?:yuva|gbrap|rgba|bgra|argb|abgr|ya|pal8)/i.test(pixel)||video.tags?.alpha_mode==='1'||video.tags?.ALPHA_MODE==='1')throw new Error('투명 영상의 역재생은 아직 지원하지 않습니다.');
  if(Number(video.bits_per_raw_sample)>8||!/^(?:yuvj?(?:410|411|420|422|440|444)p|nv12|nv21|nv16|nv24|nv42|yuyv422|uyvy422|yvyu422|gray|gray8|rgb24|bgr24|gbrp|rgb0|bgr0|0rgb|0bgr)$/.test(pixel)||['smpte2084','arib-std-b67'].includes(video.color_transfer||'')||['bt2020','smpte431','smpte432'].includes(video.color_primaries||'')||['bt2020nc','bt2020c','ictcp'].includes(video.color_space||''))throw new Error('현재 역재생 영상은 8비트 SDR만 지원합니다. HDR·고비트 영상을 자동 변환하지 않습니다.');
  const color=previewVideoColor(video),rgb=/^(?:gbr|rgb|bgr)/.test(pixel),format=/444|gbr|rgb|bgr/.test(pixel)?'yuv444p':/422/.test(pixel)?'yuv422p':'yuv420p',known=(v?:string)=>!!v&&!['unknown','unspecified','reserved'].includes(v),retain=known(video.color_space)&&known(video.color_primaries)&&known(video.color_transfer)||['vp9','av1'].includes(video.codec_name||'');
  const matrix=rgb?'bt709':color.matrix==='bt601'?'smpte170m':color.matrix,range=rgb?'tv':color.range,primaries=retain&&known(video.color_primaries)?video.color_primaries!:matrix==='smpte170m'?'smpte170m':'bt709',transfer=retain&&known(video.color_transfer)?video.color_transfer!:matrix==='smpte170m'?'smpte170m':'bt709';
  const sar=(video.sample_aspect_ratio||'1:1').split(':').map(Number),ratio=sar[0]>0&&sar[1]>0?sar[0]/sar[1]:1,w=Math.ceil(video.width*Math.max(ratio,1)/2)*2,h=Math.ceil(video.height*Math.max(1/ratio,1)/2)*2;
  if(!w||!h||w>16384||h>16384)throw new Error('역재생 영상 크기가 지원 범위를 벗어났습니다.');
  const filter=`${previewColorPrefix(video)}scale=w='ceil(iw*max(sar,1)/2)*2':h='ceil(ih*max(1/sar,1)/2)*2':flags=lanczos${rgb?'':`:in_color_matrix=${color.matrix}:in_range=${color.range}`}:out_color_matrix=${matrix==='smpte170m'?'bt601':matrix}:out_range=${range},setsar=1,format=${format},setparams=range=${range==='pc'?'full':'limited'}:colorspace=${matrix}:color_primaries=${primaries}:color_trc=${transfer}`;
  const rotation=Number(video.side_data_list?.find(s=>s.rotation!==undefined)?.rotation??video.tags?.rotate??0),cudaEligible=format==='yuv420p'&&ratio===1&&video.width%2===0&&video.height%2===0&&rotation===0&&['h264','hevc','vp9','av1'].includes(video.codec_name||'')&&['yuv420p','yuvj420p','nv12'].includes(pixel),cudaFilter=`scale_cuda=passthrough=0,setsar=1,setparams=range=${range==='pc'?'full':'limited'}:colorspace=${matrix}:color_primaries=${primaries}:color_trc=${transfer}`;
  // CUDA frames include aligned rows. This budgets the reorder payload;
  // decoder reference frames, encoder surfaces and driver allocations are extra.
  return {filter,format,cudaEligible,cudaFilter,cudaFrameBytes:Math.ceil(w/512)*512*Math.ceil(h/32)*32*1.5,frameBytes:w*h*(format==='yuv444p'?3:format==='yuv422p'?2:1.5),tags:['-colorspace',matrix,'-color_range',range,'-color_primaries',primaries,'-color_trc',transfer]};
}

/** Reverse display intervals in bounded decoded-frame chunks. Encoded chunks
 * are remuxed once; video is not encoded a second time at their boundaries. */
export async function reverseMedia(media:MediaAsset,options:ReverseOptions,ctx:ReverseContext,progress?:ProgressCallback,signal?:AbortSignal):Promise<MediaAsset>{
  const abort=()=>{if(signal?.aborted)throw new CancelledError();};abort();
  if(!['video','audio'].includes(media.kind)||!localFilePath(media.path))throw new Error('역재생에는 로컬 영상 또는 오디오 클립이 필요합니다.');normalizeReverseOptions(options,media.duration);
  const revision=await requireSourceRevision(media.path,media.sourceRevision),unchanged=async()=>{abort();await requireSourceRevision(media.path,revision);};
  const data=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-protocol_whitelist','file,pipe','-show_format','-show_streams','-of','json',media.path],{signal,timeoutMs:60000})).stdout.toString());
  const video=data.streams.find((s:Stream)=>s.codec_type==='video'&&!s.disposition?.attached_pic) as Stream|undefined,audio=data.streams.filter((s:Stream)=>s.codec_type==='audio') as Stream[],clock=mediaTimingFromProbe(data),settings=normalizeReverseOptions(options,clock.duration),at=Math.round((clock.timing.origin+settings.start)*1e6),until=Math.round((clock.timing.origin+settings.start+settings.duration)*1e6);
  if(!video&&!audio.length)throw new Error('역재생할 영상이나 오디오가 없습니다.');if(audio.length>32)throw new Error('역재생 오디오 스트림은 32개까지 지원합니다.');const plan=video?videoPlan(video):undefined;
  const directory=path.resolve(ctx.derivedDir||path.join(ctx.cacheDir,'derived'));if(!localFilePath(directory))throw new Error('역재생 저장 폴더가 올바르지 않습니다.');await fs.mkdir(directory,{recursive:true});
  const work=await fs.mkdtemp(path.join(directory,'.reverse-')),label=path.parse(media.path).name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,70)||'media',extension=video||audio.length>1?'mov':'wav',target=path.join(directory,`${label}-reverse-${randomUUID()}.${extension}`),temporary=path.join(work,`output.${extension}`);
  let published=false,complete=false,lastProgress=0;const notify=(value:number,message:string)=>{lastProgress=Math.max(lastProgress,Math.min(1,Math.max(0,value)));try{progress?.(lastProgress,message);}catch{}},diagnostic=(event:Record<string,unknown>)=>{try{ctx.diagnostics?.(event);}catch{}};
  const threads=Math.max(1,Math.min(8,availableParallelism()-1));
  const process=async(args:string[],phase:string,update?:(values:Record<string,string>)=>void)=>{
    const control=new AbortController(),combined=signal?AbortSignal.any([signal,control.signal]):control.signal;let idle:ReturnType<typeof setTimeout>|undefined,timedOut=false,pending='',values:Record<string,string>={};const reset=()=>{if(idle)clearTimeout(idle);idle=setTimeout(()=>{timedOut=true;control.abort();},sizeScaledTimeout(180000,Number(values.total_size)));idle.unref();};reset();
    try{await runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','warning','-nostdin','-y','-stats_period','0.25','-progress','pipe:1',...args],{cwd:work,signal:combined,captureStdout:false,onSpawn:pid=>{try{setPriority(pid,constants.priority.PRIORITY_BELOW_NORMAL);}catch{}queueMicrotask(()=>diagnostic({event:'reverse-process',phase,pid}));},onStderr:reset,onStdout:chunk=>{reset();pending+=chunk.toString();const lines=pending.split(/\r?\n/);pending=lines.pop()||'';for(const line of lines){const at=line.indexOf('=');if(at<0)continue;values[line.slice(0,at)]=line.slice(at+1);if(line.startsWith('progress='))update?.(values);}}});return values;}
    catch(error){if(timedOut&&!signal?.aborted)throw new Error('역재생 프로세스가 오랫동안 응답하지 않아 중단했습니다.');throw error;}finally{if(idle)clearTimeout(idle);}
  };
  try{
    await assertOutputNotSource(target,[media.path]);await assertOutputNotSource(temporary,[media.path]);await unchanged();
    let frameCount=0,lastDuration=0;
    if(video&&plan){
      if(ctx.reverseBufferBytes!==undefined&&(!Number.isFinite(ctx.reverseBufferBytes)||ctx.reverseBufferBytes<1||ctx.reverseBufferBytes>256*1024*1024))throw new Error('역재생 프레임 버퍼 설정이 올바르지 않습니다.');
      notify(0,'원본 프레임 시각 분석 중');const gpu=ctx.reverseEncoder!=='cpu'&&plan.format!=='yuv422p'&&plan.format!=='bgra'&&(await detectEncoders(ctx,signal)).includes('h264_nvenc');
      let cuda=gpu&&plan.cudaEligible&&ctx.reverseDecoder!=='cpu';const metadata=path.join(work,'frames.bin');
      const scan=()=>spoolReverseFrames(media.path,video.index,clock.timing.origin,at,until,metadata,ctx,signal,cuda?'cuda':'cpu');
      let frames;try{frames=await scan();}catch(error){abort();await unchanged();if(!cuda)throw error;cuda=false;diagnostic({event:'reverse-frame-decoder-fallback',error:String(error)});frames=await scan();}
      frameCount=frames.count;await unchanged();const handle=await fs.open(metadata,'r');
      const encode=async(encoder:'libx264'|'h264_nvenc'|'ffv1',cuda=false)=>{
        const budget=ctx.reverseBufferBytes??(cuda?256:128)*1024*1024,frameBytes=cuda?plan.cudaFrameBytes:plan.frameBytes,perChunk=Math.max(1,Math.min(600,Math.floor(budget/frameBytes)));
        diagnostic({event:'reverse-plan',decoder:cuda?'cuda':'cpu',encoder,frames:frameCount,frameBytes,bufferBytes:perChunk*frameBytes,budgetBytes:budget,framesPerChunk:perChunk,source:media.path,output:target});
        diagnostic({event:'reverse-encoding-start',encoder,decoder:cuda?'cuda':'cpu'});
        let parts=0;const manifest=await fs.open(path.join(work,'parts.txt'),'w');try{await manifest.writeFile('ffconcat version 1.0\n');for(let hi=frameCount;hi>0;hi-=perChunk){await unchanged();const lo=Math.max(0,hi-perChunk),number=hi-lo,length=number+(hi<frameCount?1:0),buffer=Buffer.allocUnsafe(length*8);let offset=0;while(offset<buffer.length){const read=await handle.read(buffer,offset,buffer.length-offset,lo*8+offset);if(!read.bytesRead)throw new Error('프레임 시각 목록이 손상되었습니다.');offset+=read.bytesRead;}
          const pts=Array.from({length},(_,i)=>buffer.readDoubleLE(i*8)),end=hi===frameCount?until:pts[number],start=lo===0?at:pts[0],outTimes=Array.from({length:number},(_,i)=>end-(i===0?end:pts[number-i])),duration=end-start,name=`video-${String(parts).padStart(8,'0')}.mov`,seek=Math.max(0,pts[0]/1e6-clock.timing.origin-1);
          if(lo===0)lastDuration=(number>1?pts[1]:end)-at;
          await fs.writeFile(path.join(work,'video-filter.txt'),`settb=AVTB,trim=start_pts=${pts[0]}:end_pts=${end},${cuda?plan.cudaFilter:plan.filter},reverse,setpts='${timestampExpression(outTimes)}'`);
          const result=await process(['-copyts','-threads',String(cuda?1:threads),...(cuda?['-hwaccel','cuda','-hwaccel_output_format','cuda','-extra_hw_frames','2']:[]),...(seek>0?['-ss',dec(seek),'-noaccurate_seek']:[]),'-protocol_whitelist','file,pipe','-i',media.path,'-map',`0:${video.index}`,'-an','-sn','-dn','-map_metadata','-1','-filter_threads','2','-/filter:v','video-filter.txt','-fps_mode','passthrough','-enc_time_base:v','filter','-frames:v',String(number),'-c:v',encoder,...(encoder==='ffv1'?['-level','3','-g','30']:[...(encoder==='libx264'?['-preset','fast','-crf','16']:['-preset','p5','-rc','constqp','-qp','16']),'-bf','0','-g','60']),'-threads',String(threads),'-pix_fmt',cuda?'cuda':plan.format,...plan.tags,'-video_track_timescale','1000000','-movie_timescale','1000000',name],'video',values=>notify(.05+.7*((frameCount-hi+Math.min(number,Number(values.frame)||0))/frameCount),'역재생 영상 생성 중'));
          if(Number(result.frame)!==number)throw new Error('역재생 영상의 프레임 수가 원본과 일치하지 않습니다.');await manifest.writeFile(`file '${name}'\nduration ${dec(duration/1e6)}\n`);parts++;
        }diagnostic({event:'reverse-encoded',encoder,decoder:cuda?'cuda':'cpu',parts,frames:frameCount});}finally{await manifest.close();}
      };
      try{
        if(gpu){
          try{
            if(cuda){try{await encode('h264_nvenc',true);}catch(error){abort();await unchanged();diagnostic({event:'reverse-decoder-fallback',error:String(error)});notify(lastProgress,'GPU 디코딩을 사용할 수 없어 다시 처리 중');await encode('h264_nvenc');}}
            else await encode('h264_nvenc');
          }catch(error){abort();await unchanged();diagnostic({event:'reverse-encoder-fallback',error:String(error)});notify(lastProgress,'GPU 인코더를 사용할 수 없어 CPU로 다시 처리 중');await encode('libx264');}
        }else await encode(plan.format==='bgra'?'ffv1':'libx264');
      }finally{await handle.close();}
    }
    const audioFiles:Array<{name:string;rate:number;channels:number;layout?:string;frames:number}>=[];
    for(let i=0;i<audio.length;i++){
      await unchanged();const stream=audio[i],rate=Number(stream.sample_rate),channels=stream.channels!;if(!Number.isInteger(rate)||rate<8000||rate>384000||!Number.isInteger(channels)||channels<1||channels>32)throw new Error('지원하지 않는 오디오 형식입니다.');
      const first=await runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','info','-nostdin','-copyts','-threads','1','-protocol_whitelist','file,pipe','-i',media.path,'-map',`0:${stream.index}`,'-vn','-map_metadata','-1','-map_chapters','-1','-af',`asettb=1/${rate},ashowinfo`,'-frames:a','1','-f','null','-'],{signal,timeoutMs:60000,onSpawn:pid=>queueMicrotask(()=>diagnostic({event:'reverse-process',phase:'audio-clock',pid}))});
      // pts_time is printed with limited precision. Read integer sample-clock
      // ticks instead, including sources whose timestamp origin is hours away.
      const match=first.stderr.match(/\bn:0\s+pts:([-+\d]+)\s+pts_time:/);if(!match)throw new Error('오디오의 첫 샘플 시각을 확인하지 못했습니다.');const firstSample=Number(match[1]);
      const from=Math.round(at*rate/1e6-firstSample),to=Math.round(until*rate/1e6-firstSample),total=to-from,before=Math.min(total,Math.max(0,-from)),plain=path.join(work,`audio-${i}.f32`),name=`reverse-audio-${i}.f32`;
      if(total<=0)throw new Error('선택 구간에 오디오 샘플이 없습니다.');notify(video ? .76 : 0,'오디오 샘플 준비 중');
      if(to<=0)await fs.writeFile(plain,Buffer.alloc(0));else await process(['-threads',String(threads),'-protocol_whitelist','file,pipe','-i',media.path,'-map',`0:${stream.index}`,'-vn','-sn','-dn','-af',`atrim=start_sample=${Math.max(0,from)}:end_sample=${to}`,'-c:a','pcm_f32le','-f','f32le',plain],'audio-decode');
      const bytes=(await fs.stat(plain)).size,actual=bytes/(channels*4);if(!Number.isInteger(actual)||actual>total-before)throw new Error('역재생 오디오 샘플 수가 올바르지 않습니다.');
      const count=await reversePcmFile(plain,path.join(work,name),channels,signal,p=>notify((video ? .76 : 0)+(video ? .17 : .9)*(i+p)/audio.length,'역재생 오디오 생성 중'),{before,after:total-before-actual});audioFiles.push({name,rate,channels,layout:stream.channel_layout,frames:count});await fs.unlink(plain);
    }
    await unchanged();notify(.94,'역재생 파일 정리 중');
    const inputs:string[]=[],maps:string[]=[];let nextInput=0;if(video){inputs.push('-f','concat','-safe','1','-protocol_whitelist','file,pipe','-i','parts.txt');maps.push('-map','0:v:0');nextInput++;}
    for(const audio of audioFiles){inputs.push('-f','f32le','-ar',String(audio.rate),'-ac',String(audio.channels),...(audio.layout&&audio.layout!=='unknown'?['-channel_layout',audio.layout]:[]),'-protocol_whitelist','file,pipe','-i',audio.name);maps.push('-map',`${nextInput++}:a:0`);}
    await process([...inputs,...maps,'-map_metadata','-1','-c:v','copy','-c:a','pcm_f32le',...(video?['-bsf:v',`setts=duration='if(eq(N,${frameCount-1}),${lastDuration},DURATION)'`,'-video_track_timescale','1000000']:[]),...(extension==='mov'?['-movie_timescale','1000000','-movflags','+faststart']:['-rf64','auto']),'-f',extension,temporary],'mux');
    await unchanged();const output=await probeMedia(temporary,ctx,signal,{derivatives:false});if(output.kind!==media.kind||!output.duration||Math.abs(output.duration-settings.duration)>.002||output.hasAudio!==Boolean(audio.length))throw new Error('역재생 결과의 길이 또는 형식이 원본과 일치하지 않습니다.');
    if(plan?.format==='bgra'&&!output.hasAlpha)throw new Error('역재생 영상의 투명도가 보존되지 않았습니다.');
    if(video){const count=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-count_packets','-select_streams','v:0','-show_entries','stream=nb_read_packets','-of','json',temporary],{signal,timeoutMs:await fileSizeTimeout(120000,temporary)})).stdout.toString()).streams?.[0]?.nb_read_packets;if(Number(count)!==frameCount)throw new Error('최종 역재생 영상의 프레임 수가 일치하지 않습니다.');}
    await unchanged();await fs.link(temporary,target);published=true;await unchanged();await fs.unlink(temporary);const result={...output,path:target,name:`${media.name} · 역재생`,sourceRevision:await readSourceRevision(target)};await unchanged();complete=true;notify(1,'역재생 완료');return result;
  }finally{
    if(published&&!complete)await fs.rm(target,{force:true}).catch(()=>{});const actualWork=await fs.realpath(work).catch(()=>undefined),actualDirectory=await fs.realpath(directory).catch(()=>undefined);if(actualWork&&actualDirectory&&insideDirectory(actualWork,actualDirectory))await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
  }
}
