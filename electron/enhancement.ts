import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {EnhancementOptions,MediaAsset} from '../shared/types';
import {CancelledError,probeMedia,runProcess,type EngineContext,type ProgressCallback} from './media';
import {prepareTrackingInput} from './tracking-source';
import {verifyVideoSelection} from './video-selection';
import {decodeTrackingFrames} from './tracking-decode';
import {MattingVideoEncoder} from './matting-encode';
import {muxProcessedVideo} from './processed-mux';
import {requireSourceRevision,readSourceRevision} from './source-revision';
import {assertOutputNotSource,insideDirectory,localFilePath} from './file-policy';
import type {EnhancementBatch,EnhancementProcessOptions} from './enhancement-process';

export interface EnhancementEngine {
  readonly inputCapacity:number;
  process(inputFile:string|null,pts:number[],last:boolean):Promise<EnhancementBatch>;
  close():Promise<void>;
}
export type EnhancementEngineConfiguration=Pick<EnhancementProcessOptions,'jobDirectory'|'width'|'height'|'scale'|'maximumFrames'|'maximumBytes'>;
export interface EnhancementContext extends EngineContext {
  derivedDir?:string;
  createEnhancement:(config:EnhancementEngineConfiguration,signal?:AbortSignal,progress?:ProgressCallback)=>Promise<EnhancementEngine>;
}

export function validateEnhancementOptions(options:EnhancementOptions) {
  if(!options||typeof options!=='object'||Array.isArray(options)||
    !Number.isFinite(options.start)||options.start<0||
    !Number.isFinite(options.duration)||options.duration<.001||options.duration>86400||
    options.start+options.duration>864000||![2,4].includes(options.scale)||
    (options.preview!==undefined&&typeof options.preview!=='boolean')||
    (options.preview&&options.duration>2.000001)) {
    throw new Error('화질 향상 구간 또는 설정이 올바르지 않습니다.');
  }
}

/** Process native presentation frames in bounded temporal chunks. The output
 * is an opaque lossless source with original timing and decoded PCM audio. */
export async function enhanceMedia(
  media:MediaAsset,options:EnhancementOptions,ctx:EnhancementContext,
  progress?:ProgressCallback,signal?:AbortSignal,
):Promise<MediaAsset> {
  validateEnhancementOptions(options);
  options={...options};
  const abort=()=>{if(signal?.aborted)throw new CancelledError();};
  abort();
  const source=await prepareTrackingInput(media,4096,ctx,signal).catch(error=>{
    if(error instanceof Error)error.message=error.message.replaceAll('객체 추적','화질 향상').replaceAll('추적','화질 향상');
    throw error;
  });
  if(source.hasAlpha)throw new Error('AI 화질 향상에는 투명도가 없는 영상을 선택하세요.');
  const selection=await verifyVideoSelection({...source.plan,revision:source.revision,probe:source.probe},options.start,options.duration,ctx,signal);
  const {firstPts,startPts,endPts}=selection;
  const directory=path.resolve(ctx.derivedDir??path.join(ctx.cacheDir,'derived'));
  if(!localFilePath(directory))throw new Error('화질 향상 저장 폴더가 올바르지 않습니다.');
  await fs.mkdir(directory,{recursive:true});
  const work=await fs.mkdtemp(path.join(directory,'.enhance-'));
  const target=path.join(directory,'enhanced-'+randomUUID()+'.mov');
  const video=path.join(work,'video.nut'),temporary=path.join(work,'output.mov');
  let engine:EnhancementEngine|undefined,encoder:MattingVideoEncoder|undefined;
  let input:Awaited<ReturnType<typeof fs.open>>|undefined,inputFile:string|null=null;
  let inputFrames=0,outputFrames=0,lastPts=-1,width=0,height=0,pts:number[]=[];
  let published=false,complete=false,lastProgress=0;
  const notify=(value:number,message:string)=>{
    lastProgress=Math.max(lastProgress,Math.max(0,Math.min(1,value)));
    try{progress?.(lastProgress,message);}catch{}
  };
  const unchanged=async()=>{abort();await requireSourceRevision(media.path,source.revision);abort();};

  const consume=async(batch:EnhancementBatch)=>{
    if(batch.outputFirstFrame!==outputFrames||batch.width!==width*options.scale||batch.height!==height*options.scale)throw new Error('화질 향상 결과 프레임이 일치하지 않습니다.');
    if(!batch.frameCount)return;
    const file=path.join(work,batch.outputFile!);
    const handle=await fs.open(file,'r');
    try {
      const frame=Buffer.allocUnsafe(batch.width*batch.height*4);
      for(let index=0;index<batch.frameCount;index++) {
        abort();
        let filled=0;
        while(filled<frame.length) {
          const {bytesRead}=await handle.read(frame,filled,frame.length-filled,null);
          if(!bytesRead)throw new Error('화질 향상 결과 프레임이 불완전합니다.');
          filled+=bytesRead;
        }
        for(let offset=3;offset<frame.length;offset+=4)if(frame[offset]!==255)throw new Error('화질 향상 결과에 예상하지 않은 투명도가 있습니다.');
        await encoder!.frame(frame,batch.pts[index]);
        lastPts=batch.pts[index];outputFrames++;
        notify(.06+.8*lastPts/(endPts-startPts),'AI 화질 향상 중');
      }
    } finally {await handle.close();}
    await fs.unlink(file);
  };
  const processChunk=async(last:boolean)=>{
    await input?.close();input=undefined;
    const name=inputFile;
    const batch=await engine!.process(name,pts,last);
    if(name)await fs.unlink(path.join(work,name));
    inputFile=null;pts=[];
    await consume(batch);
    await unchanged();
  };

  try {
    await assertOutputNotSource(target,[media.path]);
    await assertOutputNotSource(temporary,[media.path]);
    await unchanged();notify(0,'AI 화질 향상 준비 중');
    for await(const frame of decodeTrackingFrames(source.plan,firstPts,endPts,ctx,signal)) {
      abort();
      if(frame.width!==frame.sourceWidth||frame.height!==frame.sourceHeight)throw new Error('화질 향상 원본 해상도가 지원 범위를 벗어났습니다.');
      if(!engine) {
        width=frame.width;height=frame.height;
        if(Math.max(width,height)*options.scale>7680||width*height*options.scale**2>33177600)throw new Error('화질 향상 결과는 최대 7680픽셀, 3,318만 화소까지 지원합니다.');
        const maximumFrames=Math.ceil(options.duration*1000)+1000;
        engine=await ctx.createEnhancement({
          jobDirectory:work,width,height,scale:options.scale,maximumFrames,
          maximumBytes:maximumFrames*width*height*3,
        },signal,()=>notify(lastProgress,'AI 화질 향상 중'));
        if(engine.inputCapacity!==5)throw new Error('화질 향상 엔진의 프레임 묶음 크기가 올바르지 않습니다.');
        encoder=new MattingVideoEncoder(width*options.scale,height*options.scale,video,ctx,signal,{
          opaque:true,maximumPixels:33177600,idleTimeoutMs:1800000,
        });
        await encoder.start();
      }
      if(!input) {
        inputFile='input-'+String(inputFrames).padStart(9,'0')+'.bgr';
        input=await fs.open(path.join(work,inputFile),'wx');
      }
      let written=0;
      while(written<frame.data.byteLength) {
        abort();
        const {bytesWritten}=await input.write(frame.data,written,frame.data.byteLength-written,null);
        if(!bytesWritten)throw new Error('화질 향상 입력 프레임을 저장하지 못했습니다.');
        written+=bytesWritten;
      }
      pts.push(Math.max(0,frame.pts-startPts));inputFrames++;
      if(pts.length===engine.inputCapacity)await processChunk(false);
    }
    if(!engine||!encoder||!inputFrames)throw new Error('화질 향상할 영상 프레임을 찾지 못했습니다.');
    await processChunk(true);
    if(outputFrames!==inputFrames||lastPts<0||lastPts>=endPts-startPts)throw new Error('화질 향상 결과의 프레임 수 또는 마지막 시각이 일치하지 않습니다.');
    await engine.close();engine=undefined;
    await encoder.finish();await encoder.close();encoder=undefined;
    await unchanged();notify(.88,'향상된 영상과 오디오 저장 중');
    const audioSamples=await muxProcessedVideo({
      video,source:media.path,output:temporary,startPts,endPts,lastPts,frameCount:outputFrames,
    },ctx,signal);
    await unchanged();
    const result=await probeMedia(temporary,ctx,signal,{derivatives:false});
    if(result.kind!=='video'||result.hasAlpha||result.width!==width*options.scale||result.height!==height*options.scale||
      Math.abs(result.duration-options.duration)>.002||result.hasAudio!==audioSamples)throw new Error('화질 향상 영상의 크기, 길이 또는 오디오가 원본과 일치하지 않습니다.');
    const count=JSON.parse((await runProcess(ctx.ffprobe,[
      '-v','error','-count_packets','-select_streams','v:0','-show_entries','stream=nb_read_packets','-of','json',temporary,
    ],{signal,timeoutMs:120000})).stdout.toString()).streams?.[0]?.nb_read_packets;
    if(Number(count)!==inputFrames)throw new Error('화질 향상 영상의 저장된 프레임 수가 일치하지 않습니다.');
    await unchanged();await fs.link(temporary,target);published=true;
    await unchanged();await fs.unlink(temporary);
    const output={...result,path:target,name:media.name+' · AI '+options.scale+'×',sourceRevision:await readSourceRevision(target)};
    await unchanged();complete=true;notify(1,'AI 화질 향상 완료');
    return output;
  } catch(error) {
    if(error instanceof Error)error.message=error.message.replaceAll('배경 제거','화질 향상').replaceAll('추적','화질 향상');
    throw error;
  } finally {
    await Promise.allSettled([input?.close(),engine?.close(),encoder?.close()]);
    if(published&&!complete)await fs.unlink(target).catch(()=>{});
    const canonical=await fs.realpath(work).catch(()=>undefined),parent=await fs.realpath(directory).catch(()=>undefined);
    if(canonical&&parent&&insideDirectory(canonical,parent))await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
  }
}
