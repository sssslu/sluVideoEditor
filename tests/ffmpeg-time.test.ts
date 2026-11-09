import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newClip,newProject} from '../shared/project';
import {compileTransitions} from '../shared/transitions';
import {clipSourceTime} from '../shared/speed';
import {ffmpegSeconds,sizeScaledTimeout,fileSizeTimeout,MINIMUM_THROUGHPUT} from '../electron/ffmpeg-time';
import {TimelineAudioMixer} from '../electron/render-audio';
import {probeMedia,runProcess,type EngineContext} from '../electron/media';

const root=path.resolve('.test-artifacts/ffmpeg-time');
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),audioStretch:path.resolve('resources/bin/slu-audio-stretch.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false};
const seek=(value:string)=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-ss',value,'-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','0.01','-f','null','-'],{timeoutMs:30000});

test('ffmpeg time arguments never use exponent notation and collapse floating residue to zero',()=>{
  assert.equal(ffmpegSeconds(-5.551115123125783e-17),'0');assert.equal(ffmpegSeconds(5.551115123125783e-17),'0');assert.equal(ffmpegSeconds(-0),'0');
  assert.equal(ffmpegSeconds(7/30),'0.233333');assert.equal(ffmpegSeconds(2),'2');assert.equal(ffmpegSeconds(10),'10');assert.equal(ffmpegSeconds(600.5),'600.5');
  assert.equal(ffmpegSeconds(1/48000),'0.000021');assert.equal(ffmpegSeconds(1e-6),'0.000001');assert.equal(ffmpegSeconds(-.25),'-0.25');
  assert.equal(ffmpegSeconds(3e-7,9),'0.0000003');assert.equal(ffmpegSeconds(1234.5,9),'1234.5');assert.equal(ffmpegSeconds(-4e-10,9),'0');
  for(const value of [1e-7,2.220446049250313e-16,-1e-12,123456.0000001,1/3,86399.999999])for(const digits of [6,9])assert.match(ffmpegSeconds(value,digits),/^-?\d+(\.\d+)?$/);
  assert.throws(()=>ffmpegSeconds(Number.NaN));assert.throws(()=>ffmpegSeconds(Infinity));
});

test('whole-file process limits keep their base and add a 20 MB/s allowance',async()=>{
  assert.equal(sizeScaledTimeout(120000,0),120000);assert.equal(sizeScaledTimeout(120000,Number.NaN),120000);assert.equal(sizeScaledTimeout(180000,-1),180000);
  assert.equal(sizeScaledTimeout(120000,MINIMUM_THROUGHPUT*100),220000);assert.equal(sizeScaledTimeout(180000,64*1024**3),180000+Math.ceil(64*1024**3/MINIMUM_THROUGHPUT*1000));
  assert.equal(sizeScaledTimeout(0,1e30),2**31-1);
  await fs.mkdir(root,{recursive:true});const file=path.join(root,'size.bin');await fs.writeFile(file,Buffer.alloc(MINIMUM_THROUGHPUT/2));
  assert.equal(await fileSizeTimeout(1000,file,file,path.join(root,'missing.bin')),2000);
});

test('bundled FFmpeg rejects String() residue but accepts the fixed decimal form',{timeout:60000},async()=>{
  await assert.rejects(seek(String(-5.551115123125783e-17)),/Invalid duration/);
  await seek(ffmpegSeconds(-5.551115123125783e-17));await seek(ffmpegSeconds(2.220446049250313e-16));
});

test('30 fps dissolve into a clip trimmed by 7 frames decodes its audio handle',{timeout:60000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const file=path.join(root,'tone.mkv');
  await runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','color=black:s=32x18:r=30:d=5','-f','lavfi','-i','aevalsrc=0.2|0.4:s=48000:d=5','-c:v','libx264','-preset','ultrafast','-c:a','pcm_f32le',file]);
  const media=await probeMedia(file,ctx,undefined,{derivatives:false}),p=newProject();media.videoStart=0;media.videoEnd=5;p.fps=30;p.width=160;p.height=90;p.media=[media];
  const a=newClip('video-1',media);a.duration=2;const b=newClip('video-1',media,2);b.in=7/30;b.duration=2;p.clips=[a,b];
  p.transitions=[{id:'dissolve',fromClipId:a.id,toClipId:b.id,kind:'dissolve',durationFrames:15,audio:'linear'}];
  const seekTime=clipSourceTime(b,compileTransitions(p).byClip.get(b.id)!.audioFrom);t.diagnostic(`clip B decoder seek ${seekTime} -> ${ffmpegSeconds(seekTime)}`);
  const control=new AbortController(),mixer=new TimelineAudioMixer(p,ctx.ffmpeg,control.signal,undefined,ctx.audioStretch),total=4*48000;let peak=0;
  try{for(let at=0;at<total;at+=4096){const pcm=await mixer.mix(at,Math.min(4096,total-at));for(let i=0;i<pcm.length;i+=4)peak=Math.max(peak,Math.abs(pcm.readFloatLE(i)));}}
  finally{await mixer.close();}
  assert.ok(peak>.3&&peak<.5,`peak ${peak}`);
});
