import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {probeMedia,renderProject,runProcess,type EngineContext} from '../electron/media';
import {newClip,newProject} from '../shared/project';
import {combinationProject} from '../shared/combine';
import type {ExportSettings,Project} from '../shared/types';

const root=path.resolve('.test-artifacts/combine-render');
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{maxOutputBytes:256*1024*1024});
const probe=async(file:string,stream:string,entries:string)=>JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-select_streams',stream,'-show_entries',`stream=${entries}`,'-of','json',file])).stdout.toString()).streams[0];
const samples=async(file:string)=>{const raw=(await ff(['-i',file,'-map','0:a:0','-f','f64le','-ac','2','pipe:1'])).stdout;return new Float64Array(raw.buffer,raw.byteOffset,raw.byteLength/8);};
const intermediate=(p:Project,file:string,format:'mov'|'wav'):ExportSettings=>({width:p.width,height:p.height,fps:p.fps,format,codec:'h264',encoder:'cpu',quality:'high',intermediate:true,outputPath:path.join(root,file)});

test('a combined render keeps transparency and every audio sample, without the project background',{timeout:240000},async()=>{
  await fs.mkdir(root,{recursive:true});
  const source=path.join(root,'source.mov');
  await ff(['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=2','-f','lavfi','-i','aevalsrc=0.6*sin(2*PI*440*t)+0.39*sin(2*PI*1234*t)|0.5*sin(2*PI*660*t):s=48000:d=2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','pcm_s16le','-shortest',source]);
  const media=await probeMedia(source,ctx),p=newProject();p.width=320;p.height=180;p.fps=30;p.background='#ff0000';p.media=[media];
  p.clips=[{...newClip('video-1',media),id:'picture',duration:2,scale:.5},{...newClip('text-1',undefined,.5),id:'caption',text:'합치기',duration:1}];
  const input=combinationProject(p,['picture','caption']);
  const output=await renderProject(input,intermediate(input,'combined.mov','mov'),ctx);
  const video=await probe(output,'v:0','codec_name,pix_fmt'),audio=await probe(output,'a:0','codec_name,sample_rate');
  assert.deepEqual([video.codec_name,video.pix_fmt],['ffv1','yuva444p']);assert.deepEqual([audio.codec_name,Number(audio.sample_rate)],['pcm_f32le',48000]);
  const imported=await probeMedia(output,ctx);assert.equal(imported.hasAlpha,true);assert.ok(Math.abs(imported.duration-2)<.05,String(imported.duration));
  // Frame 15 as RGBA: a corner outside the half-size picture is fully transparent, not red.
  const frame=(await ff(['-i',output,'-vf','select=eq(n\\,15)','-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'])).stdout;
  const pixel=(x:number,y:number)=>[...frame.subarray((y*320+x)*4,(y*320+x)*4+4)];
  assert.equal(pixel(3,3)[3],0,`corner ${pixel(3,3)}`);assert.equal(pixel(160,90)[3],255,`center ${pixel(160,90)}`);
  const reference=await samples(source),rendered=await samples(output);
  assert.ok(Math.abs(rendered.length-reference.length)<=4,`${rendered.length} vs ${reference.length}`);
  let worst=0;for(let i=0;i<Math.min(rendered.length,reference.length);i++)worst=Math.max(worst,Math.abs(rendered[i]-reference[i]));
  assert.equal(worst,0,`audio differs by up to ${worst}`);
});

test('an audio-only combination is float WAV that keeps a mix above full scale',{timeout:120000},async()=>{
  await fs.mkdir(root,{recursive:true});
  const tone=path.join(root,'tone.wav');
  await ff(['-f','lavfi','-i','aevalsrc=0.8*sin(2*PI*220*t)|0.8*sin(2*PI*220*t):s=48000:d=1','-c:a','pcm_s16le',tone]);
  const media=await probeMedia(tone,ctx),p=newProject();p.media=[media];
  p.tracks=[...p.tracks,{id:'audio-2',name:'A2',type:'audio',muted:false,hidden:false,locked:false}];
  p.clips=[{...newClip('audio-1',media),id:'one',duration:1},{...newClip('audio-2',media),id:'two',duration:1}];
  const input=combinationProject(p,['one','two']),output=await renderProject(input,intermediate(input,'combined.wav','wav'),ctx);
  assert.equal((await probe(output,'a:0','codec_name')).codec_name,'pcm_f32le');
  let peak=0;for(const v of await samples(output))peak=Math.max(peak,Math.abs(v));
  assert.ok(peak>1.5,`two 0.8 tones should sum to about 1.6, got ${peak}`);
});

test('a 5000% clip exports at its sped-up length',{timeout:240000},async()=>{
  await fs.mkdir(root,{recursive:true});
  const source=path.join(root,'long.mp4');
  await ff(['-f','lavfi','-i','testsrc2=s=160x90:r=30:d=10','-f','lavfi','-i','sine=frequency=500:sample_rate=48000:duration=10','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
  const media=await probeMedia(source,ctx),p=newProject();p.width=160;p.height=90;p.fps=30;p.media=[media];
  p.clips=[{...newClip('video-1',media),id:'fast',speed:50,duration:.2}];
  const output=await renderProject(p,{width:160,height:90,fps:30,format:'mov',codec:'h264',encoder:'cpu',quality:'draft',outputPath:path.join(root,'fast.mov')},ctx);
  const exported=await probeMedia(output,ctx);assert.ok(Math.abs(exported.duration-.2)<.05,String(exported.duration));assert.equal(exported.hasAudio,true);
});
