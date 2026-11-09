import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {probeMedia,renderProject,runProcess,exportAudioArguments,exportLimiter,type EngineContext} from '../electron/media';
import {newClip,newProject} from '../shared/project';
import type {ExportSettings} from '../shared/types';

const root=path.resolve('.test-artifacts/lossless-audio');
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{maxOutputBytes:256*1024*1024});
const samples=async(file:string)=>{const raw=(await ff(['-i',file,'-map','0:a:0','-f','f64le','-ac','2','pipe:1'])).stdout;return new Float64Array(raw.buffer,raw.byteOffset,raw.byteLength/8);};
const codec=async(file:string)=>JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-select_streams','a:0','-show_entries','stream=codec_name,sample_rate,bits_per_raw_sample,bits_per_sample','-of','json',file])).stdout.toString()).streams[0];

test('video and WAV exports reproduce a full-scale 48 kHz source bit for bit',{timeout:240000},async()=>{
  await fs.mkdir(root,{recursive:true});
  // Peaks at -0.09 dBFS: the old 0.97 limiter changed this audio; a lossless export must not.
  const source=path.join(root,'hot-source.mov');
  await ff(['-f','lavfi','-i','testsrc2=s=160x90:r=30:d=3','-f','lavfi','-i','aevalsrc=0.6*sin(2*PI*440*t)+0.39*sin(2*PI*1234*t)|0.5*sin(2*PI*660*t)+0.49*sin(2*PI*97*t):s=48000:d=3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','pcm_s16le','-shortest',source]);
  const media=await probeMedia(source,ctx),p=newProject();p.width=160;p.height=90;p.fps=30;p.media=[media];p.clips=[{...newClip('video-1',media),duration:3}];
  const reference=await samples(source);
  for(const [format,expected] of [['mov','pcm_s24le'],['mp4','flac'],['wav','pcm_s24le']] as const){
    const settings:ExportSettings={outputPath:path.join(root,`export.${format}`),width:160,height:90,fps:30,format,codec:'h264',encoder:'cpu',quality:'draft'};
    await renderProject(p,settings,ctx);
    const stream=await codec(settings.outputPath!);assert.equal(stream.codec_name,expected,format);assert.equal(Number(stream.sample_rate),48000);
    if(format==='mp4')assert.equal(Number(stream.bits_per_raw_sample),24);
    const output=await samples(settings.outputPath!),length=Math.min(output.length,reference.length);
    assert.ok(Math.abs(output.length-reference.length)<=2*2,`${format} length ${output.length} vs ${reference.length}`);
    let worst=0;for(let i=0;i<length;i++)worst=Math.max(worst,Math.abs(output[i]-reference[i]));
    assert.equal(worst,0,`${format} audio differs from the source by up to ${worst}`);
  }
});

test('lossless exports only limit real overs; MOV cannot carry AV1',async()=>{
  assert.deepEqual(exportAudioArguments('mov'),['-c:a','pcm_s24le']);assert.deepEqual(exportAudioArguments('gif'),[]);
  assert.match(exportLimiter('mov'),/limit=1:/);assert.match(exportLimiter('mp4'),/limit=1:/);assert.match(exportLimiter('wav'),/limit=1:/);assert.match(exportLimiter('webm'),/limit=0\.97:/);
  const p=newProject();p.clips=[{...newClip('text-1'),text:'x',duration:1}];
  await assert.rejects(renderProject(p,{outputPath:path.join(root,'av1.mov'),width:160,height:90,fps:30,format:'mov',codec:'av1',encoder:'cpu',quality:'draft'},ctx),/내보내기 설정이 올바르지 않습니다/);
});
