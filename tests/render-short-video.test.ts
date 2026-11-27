import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {probeMedia,renderProject,runProcess,type EngineContext} from '../electron/media';
import {newClip,newProject} from '../shared/project';
import type {ExportSettings} from '../shared/types';

// A camera or screen recording often has an audio track that runs a little longer than its video
// track. The file's duration (and so the longest a clip can be) follows the audio, so the end of
// such a clip has no video frames. The export must hold the last picture there, as the preview
// does, instead of failing with "렌더 구간이 불완전합니다".
const root=path.resolve('.test-artifacts/render-short-video');
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const settings=(file:string):ExportSettings=>({outputPath:path.join(root,file),width:320,height:180,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'high'});
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{maxOutputBytes:64*1024*1024});
const frames=async(file:string)=>{const out=await runProcess(ctx.ffprobe,['-v','error','-count_frames','-select_streams','v:0','-show_entries','stream=nb_read_frames','-of','csv=p=0',file]);return Number(String(out.stdout??out).trim());};
// Luma of one decoded output frame. The export is lossy, so a held picture is compared by how far
// it is from the last real frame, against how far two neighbouring real frames of testsrc2 are apart.
const luma=async(file:string,index:number)=>{const raw=path.join(root,`frame-${path.basename(file)}-${index}.gray`);await ff(['-i',file,'-vf',`select=eq(n\\,${index}),format=gray`,'-frames:v','1','-f','rawvideo',raw]);return fs.readFile(raw);};
const distance=(a:Buffer,b:Buffer)=>{assert.equal(a.length,b.length);let sum=0;for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);return sum/a.length;};
async function assertHeld(file:string,lastReal:number,held:number){
  const real=await luma(file,lastReal),before=await luma(file,lastReal-1),after=await luma(file,held);
  const moving=distance(before,real),still=distance(real,after);
  assert.ok(still<moving/4,`frame ${held} should repeat frame ${lastReal} (difference ${still.toFixed(2)}, neighbouring real frames ${moving.toFixed(2)})`);
}

async function source(name:string,videoSeconds:number,audioSeconds:number){
  await fs.mkdir(root,{recursive:true});const file=path.join(root,name);
  await ff(['-f','lavfi','-i',`testsrc2=s=320x180:r=30:d=${videoSeconds}`,'-f','lavfi','-i',`sine=f=440:r=48000:d=${audioSeconds}`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',file]);
  return probeMedia(file,ctx,undefined,{derivatives:false});
}

test('a clip that runs past the end of its video track exports with the last picture held',{timeout:180000},async()=>{
  // Video ends 0.1 s (3 frames) before the audio: the case reported from a lecture recording.
  const media=await source('short-tail.mp4',2,2.1);assert.ok(media.duration>2.05,`container duration follows audio (${media.duration})`);
  const p=newProject();p.width=320;p.height=180;p.media=[media];p.tracks=p.tracks.filter(t=>t.type!=='text');
  const clip=newClip('video-1',media,0);clip.duration=media.duration;p.clips=[clip];
  const events:Record<string,unknown>[]=[];
  const output=await renderProject(p,settings('short-tail-out.mp4'),{...ctx,diagnostics:event=>events.push(event)});
  const expected=Math.ceil(media.duration*30-1e-7);
  assert.equal(await frames(output),expected);
  await assertHeld(output,59,expected-1);
  assert.ok(!events.some(e=>e.event==='window-padded'),'the renderer itself holds the last frame; the stream safety net is not needed');
});

test('a window with no video frames left at all is filled from the previous window',{timeout:180000},async()=>{
  // Video stops after 1 s, audio runs for 8 s: the second 6-second render window has no source frames.
  const media=await source('long-gap.mp4',1,8);
  const p=newProject();p.width=320;p.height=180;p.media=[media];p.tracks=p.tracks.filter(t=>t.type!=='text');
  const clip=newClip('video-1',media,0);clip.duration=media.duration;p.clips=[clip];
  const events:Record<string,unknown>[]=[];
  const output=await renderProject(p,settings('long-gap-out.mp4'),{...ctx,diagnostics:event=>events.push(event)});
  const expected=Math.ceil(media.duration*30-1e-7);
  assert.equal(await frames(output),expected);
  await assertHeld(output,29,expected-1);
  assert.ok(events.some(e=>e.event==='window-padded'),'the missing window is reported in diagnostics');
});
