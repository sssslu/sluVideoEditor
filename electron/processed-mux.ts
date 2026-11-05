import {runProcess,type EngineContext} from './media';

export interface ProcessedMuxOptions {
  video:string;source:string;output:string;
  startPts:number;endPts:number;lastPts:number;frameCount:number;
}

/** Retain native video timestamps, the last held frame and every original
 * audio track. PCM trimming preserves decoded samples and track ordinals. */
export async function muxProcessedVideo(options:ProcessedMuxOptions,ctx:EngineContext,signal?:AbortSignal):Promise<boolean> {
  const {video,source:sourcePath,output:temporary,startPts:at,endPts:until,lastPts:last,frameCount}=options;
  if(![at,until,last,frameCount].every(Number.isSafeInteger)||until<=at||last<0||last>=until-at||frameCount<1)throw new Error('처리 영상의 프레임 구간이 올바르지 않습니다.');
  let audioPending='',audioSamples=false,invalidAudioStats=false;
  const observeAudio=(line:string)=>{
    if(!line)return;
    const match=/^cutout_audio=(\d+)$/.exec(line);
    if(!match||!Number.isSafeInteger(Number(match[1]))){invalidAudioStats=true;return;}
    if(Number(match[1])>0)audioSamples=true;
  };
  const muxed=await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-copyts','-i',video,'-threads','2','-protocol_whitelist','file,pipe','-i',sourcePath,'-map','0:v:0','-map','1:a?','-sn','-dn','-map_metadata','-1','-map_chapters','-1','-c:v','copy','-bsf:v',`setts=duration='if(eq(N,${frameCount-1}),${until-at-last},DURATION)'`,'-af',`atrim=start=${at/1e6}:end=${until/1e6},asetpts=PTS-round(${at/1e6}/TB),apad=whole_len=1`,'-c:a','pcm_f32le','-stats_enc_pre:a','pipe:1','-stats_enc_pre_fmt:a','cutout_audio={samp}','-video_track_timescale','1000000','-movie_timescale','1000000','-movflags','+faststart','-f','mov',temporary],{
    signal,timeoutMs:180000,captureStdout:false,
    onSpawn:pid=>{try{ctx.diagnostics?.({event:'matting-mux-start',pid});}catch{}},
    onStdout:data=>{
      audioPending+=data.toString();
      const lines=audioPending.split(/\r?\n/);audioPending=lines.pop()||'';
      for(const line of lines)observeAudio(line);
      if(audioPending.length>128){invalidAudioStats=true;audioPending='';}
    },
  });
  if(muxed.stderr.trim())throw new Error(`배경 제거 영상의 오디오 처리 중 오류가 발생했습니다.\n${muxed.stderr.trim()}`);
  observeAudio(audioPending);
  if(invalidAudioStats)throw new Error('배경 제거 영상의 오디오 샘플 기록을 확인하지 못했습니다.');
  return audioSamples;
}
