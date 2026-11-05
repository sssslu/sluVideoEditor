import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildAss, canUseNativeBase, createProxy, detectEncoders, keyframeExpression, probeMedia, renderProject, runProcess, validateProject, type EngineContext } from '../electron/media';
import { clipEnvelope, newClip, newProject, splitClip, trimClip } from '../shared/project';
import { assertProject } from '../shared/validation';
import type { ExportSettings } from '../shared/types';

const settings=(outputPath:string):ExportSettings=>({outputPath,width:320,height:180,fps:24,format:'mp4',codec:'h264',encoder:'cpu',quality:'draft'});

test('export validates source overwrite and numeric bounds before running tools',()=>{
  const p=newProject(),c=newClip('text-1');p.clips=[c];
  assert.throws(()=>validateProject(p,settings('relative.mp4')),/로컬/);
  c.start=NaN;assert.throws(()=>validateProject(p,settings(path.resolve('output.mp4'))),/시작 시간|클립 설정/);
  c.start=0;c.duration=2;c.text='hello';p.media=[{id:'source',path:path.resolve('input.mp4'),name:'input',kind:'video',duration:2,width:320,height:180,fps:24,hasAudio:true}];
  assert.throws(()=>validateProject(p,settings(path.resolve('input.mp4'))),/원본/);
});

test('keyframe interpolation emits finite expressions even with duplicate timestamps',()=>{
  const c=newClip('video-1');c.keyframes=[{time:1,x:2,y:0,scale:1,opacity:1,rotation:0},{time:1,x:7,y:0,scale:1,opacity:1,rotation:0},{time:2,x:17,y:0,scale:1,opacity:1,rotation:0}];
  const expression=keyframeExpression(c,'x');assert.ok(expression.includes('7'));assert.ok(!expression.includes('Infinity'));assert.ok(!expression.includes('NaN'));
});

test('ASS preserves Korean multiline text and prevents override injection',()=>{
  const p=newProject(),c=newClip('text-1');c.text='안녕하세요\n{\\pos(0,0)}';c.y=200;c.animation='pop';c.textStyle='neon';p.clips=[c];
  const ass=buildAss(p,settings(path.resolve('text.mp4')));assert.match(ass,/안녕하세요\\N/);assert.ok(!ass.includes('{\\pos(0,0)}'));assert.match(ass,/PlayResX: 320/);assert.match(ass,/Style: Text0,Malgun Gothic/);assert.ok(ass.includes('Dialogue:'));
});

test('splits and trims preserve original effect phase; envelope validation rejects broken intervals',()=>{
  const p=newProject(),c=newClip('text-1');c.duration=3;c.fadeIn=1;c.fadeOut=1;c.animation='pop';p.clips=[c];
  const [left,right]=splitClip(c,.5)!;assert.deepEqual(clipEnvelope(left,.4),clipEnvelope(c,.4));assert.deepEqual(clipEnvelope(right,.1),clipEnvelope(c,.6));assert.equal(right.fadeIn,1);assert.equal(left.fadeOut,1);
  const trimmed=trimClip(right,.1,2);assert.ok(Math.abs(clipEnvelope(trimmed,.3).time-clipEnvelope(c,.9).time)<1e-9);assert.equal(clipEnvelope(trimmed).duration,3);assert.equal(trimmed.duration,1.9);p.clips=[left,right];assert.doesNotThrow(()=>assertProject(p));
  assert.throws(()=>assertProject({...p,clips:[{...right,sourceClipDuration:1}]}),/효과/);assert.throws(()=>assertProject({...p,clips:[{...right,sourceClipOffset:undefined}]}),/효과/);
});

test('real FFmpeg: metadata, waveform, Korean text, layered transforms, GPU detection and proxy', {timeout:180000},async(t)=>{
  const ffmpeg=existsSync(path.resolve('resources/bin/ffmpeg.exe'))?path.resolve('resources/bin/ffmpeg.exe'):'ffmpeg';
  const ffprobe=existsSync(path.resolve('resources/bin/ffprobe.exe'))?path.resolve('resources/bin/ffprobe.exe'):'ffprobe';
  try{await runProcess(ffmpeg,['-version'],{timeoutMs:10000});}catch{t.skip('FFmpeg is not available in this environment');return;}
  const work=await fs.mkdtemp(path.join(os.tmpdir(),'slu-media-test-'));const ctx:EngineContext={ffmpeg,ffprobe,cacheDir:path.join(work,'cache')};
  try{
    const source=path.join(work,'한글 source.mp4');
    await runProcess(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=24:d=3','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
    const media=await probeMedia(source,ctx);assert.equal(media.kind,'video');assert.equal(media.width,320);assert.equal(media.height,180);assert.equal(media.hasAudio,true);assert.ok(media.thumbnail&&existsSync(media.thumbnail));assert.equal(media.waveform?.length,320);assert.ok(media.waveform!.some(x=>x>.1));
    const p=newProject();p.width=320;p.height=180;p.fps=24;p.media=[media];const a=newClip('video-1',media);a.duration=2;a.scale=.75;a.rotation=8;a.fadeIn=.2;a.fadeOut=.2;a.preset='warm';a.keyframes=[{time:0,x:-10,y:0,scale:.6,opacity:.3,rotation:-10},{time:2,x:20,y:5,scale:.9,opacity:1,rotation:15}];const c=newClip('text-1');c.text='안녕하세요\nSLU Studio';c.start=.2;c.duration=1.5;c.fontSize=23;c.y=38;c.animation='pop';c.textStyle='neon';p.clips=[a,c];
    const output=path.join(work,'검증 output.mp4');const progress:number[]=[];await renderProject(p,settings(output),ctx,value=>progress.push(value));
    const exported=await probeMedia(output,ctx);assert.equal(exported.width,320);assert.equal(exported.height,180);assert.ok(Math.abs(exported.duration-2)<.1);assert.ok(exported.hasAudio);assert.equal(progress.at(-1),1);
    const encoders=await detectEncoders(ctx);t.diagnostic(`Usable encoders: ${encoders.join(', ')}`);assert.ok(encoders.includes('libx264'));if(process.env.SLU_EXPECT_NVENC==='1')assert.ok(encoders.includes('h264_nvenc'),'This workstation must detect its NVIDIA encoder');const proxy=await createProxy(media,ctx);assert.ok(proxy.proxyPath&&existsSync(proxy.proxyPath));
    if(encoders.includes('h264_nvenc')){const gpu=path.join(work,'gpu.mp4');await renderProject(p,{...settings(gpu),encoder:'nvenc'},ctx);assert.ok((await fs.stat(gpu)).size>1000);t.diagnostic('Actual h264_nvenc export completed');}
    // A detached video clip on an audio track must not obscure the background.
    p.clips=[{...a,keyframes:[],trackId:'audio-1',duration:1}];p.background='#ff0000';const audioOnly=path.join(work,'audio-track.mp4');await renderProject(p,settings(audioOnly),ctx);
    const frame=await runProcess(ffmpeg,['-v','error','-ss','0.5','-i',audioOnly,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);assert.ok(frame.stdout[0]>200&&frame.stdout[1]<30&&frame.stdout[2]<30);
    // Dynamic scale must remain visible when rotate uses a fixed output buffer;
    // opacity and position must interpolate at the same local timeline time.
    const redFile=path.join(work,'red.mp4');await runProcess(ffmpeg,['-v','error','-f','lavfi','-i','color=red:s=320x180:r=24:d=2','-c:v','libx264','-preset','ultrafast',redFile]);const red=await probeMedia(redFile,ctx);const motion=newClip('video-1',red);motion.duration=2;motion.keyframes=[{time:0,x:-70,y:0,scale:.2,opacity:.3,rotation:1},{time:2,x:30,y:0,scale:.8,opacity:1,rotation:10}];p.media=[red];p.clips=[motion];p.background='#000000';const animated=path.join(work,'motion.mp4');await renderProject(p,settings(animated),ctx);
    const bounds=async(time:string)=>{const raw=await runProcess(ffmpeg,['-v','error','-ss',time,'-i',animated,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);let left=320,right=-1,top=180,bottom=-1,max=0;for(let y=0;y<180;y++)for(let x=0;x<320;x++){const off=(y*320+x)*3,r=raw.stdout[off],g=raw.stdout[off+1];max=Math.max(max,r);if(r>35&&r>g*2){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}}return {width:right-left+1,height:bottom-top+1,center:(left+right)/2,max};};
    const early=await bounds('0.1'),late=await bounds('1.8');assert.ok(late.width>210,`Later scale was clipped: ${JSON.stringify(late)}`);assert.ok(late.height>110);assert.ok(late.center-early.center>70);assert.ok(early.max<160&&late.max>210,`Opacity was not animated: ${JSON.stringify({early,late})}`);t.diagnostic(`Motion pixel bounds: ${JSON.stringify({early,late})}`);
    // Still images, RGB brightness and silent exports must work with no audio input.
    const stillFile=path.join(work,'gray.png');await runProcess(ffmpeg,['-v','error','-f','lavfi','-i','color=c=0x808080:s=64x64','-frames:v','1',stillFile]);const still=await probeMedia(stillFile,ctx);assert.equal(still.kind,'image');const photo=newClip('video-1',still);photo.duration=.5;photo.brightness=.5;p.media=[still];p.clips=[photo];const photoOutput=path.join(work,'photo.mp4');await renderProject(p,settings(photoOutput),ctx);const pixel=await runProcess(ffmpeg,['-v','error','-ss','0.2','-i',photoOutput,'-frames:v','1','-vf','crop=2:2:160:90,scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);assert.ok(pixel.stdout[0]>175&&pixel.stdout[0]<205,`CSS multiplicative brightness mismatch ${pixel.stdout[0]}`);
    const empty=newClip('text-1');empty.text='';empty.duration=.5;p.media=[];p.clips=[empty];const emptyOutput=path.join(work,'empty-text.mp4');await renderProject(p,settings(emptyOutput),ctx);assert.ok((await fs.stat(emptyOutput)).size>1000);
    // A split inside a fade and a text pop must leave the output unchanged.
    const fading=newClip('video-1',media);fading.duration=2;fading.fadeIn=1;fading.fadeOut=.7;const caption=newClip('text-1');caption.duration=2;caption.fontSize=24;caption.animation='pop';caption.text='자막 분할';p.media=[media];p.clips=[fading,caption];
    const before=path.join(work,'before-split.mp4');await renderProject(p,settings(before),ctx);const beforeWav=path.join(work,'before-split.wav');await renderProject(p,{...settings(beforeWav),format:'wav'},ctx);
    p.clips=[...splitClip(fading,.5)!,...splitClip(caption,.125)!];const after=path.join(work,'after-split.mp4');await renderProject(p,settings(after),ctx);const afterWav=path.join(work,'after-split.wav');await renderProject(p,{...settings(afterWav),format:'wav'},ctx);
    const readFrame=(file:string,time:string)=>runProcess(ffmpeg,['-v','error','-ss',time,'-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    for(const time of ['0.083333','0.208333','0.541667','1.5']){const [a,b]=await Promise.all([readFrame(before,time),readFrame(after,time)]);let error=0;for(let i=0;i<a.stdout.length;i++)error+=Math.abs(a.stdout[i]-b.stdout[i]);const mae=error/a.stdout.length;assert.ok(mae<5,`Split changed frame at ${time}s, mean RGB error=${mae}`);}
    const pcm=(file:string)=>runProcess(ffmpeg,['-v','error','-i',file,'-f','s16le','-ac','2','pipe:1']);const [beforePcm,afterPcm]=await Promise.all([pcm(beforeWav),pcm(afterWav)]);assert.equal(beforePcm.stdout.length,afterPcm.stdout.length);let squaredError=0;for(let i=0;i<beforePcm.stdout.length;i+=2){const delta=(beforePcm.stdout.readInt16LE(i)-afterPcm.stdout.readInt16LE(i))/32768;squaredError+=delta*delta;}const rmse=Math.sqrt(squaredError/(beforePcm.stdout.length/2));assert.ok(rmse<.003,`Split changed audio fade, RMS error=${rmse}`);t.diagnostic(`Split audio RMS error: ${rmse}`);
    // Native YUV base preserves display aspect for non-square pixels, project
    // padding, and later transparent overlays/captions.
    const sarFile=path.join(work,'sar.mp4');await runProcess(ffmpeg,['-v','error','-f','lavfi','-i','color=red:s=120x80:r=24:d=1','-vf','setsar=2','-c:v','libx264','-preset','ultrafast',sarFile]);const sar=await probeMedia(sarFile,ctx),plain=newClip('video-1',sar);plain.duration=1;p.media=[sar];p.clips=[plain];p.background='#0000ff';assert.equal(await canUseNativeBase(plain,sar,1,ctx),true);assert.equal(await canUseNativeBase({...plain,opacity:.5},sar,1,ctx),false);
    const native=path.join(work,'native-base.mp4');await renderProject(p,settings(native),ctx);const readNative=await readFrame(native,'0.5');const at=(x:number,y:number)=>Array.from(readNative.stdout.subarray((y*320+x)*3,(y*320+x)*3+3));assert.ok(at(160,5)[2]>200&&at(160,5)[0]<30,`Project background lost: ${at(160,5)}`);assert.ok(at(160,90)[0]>200&&at(160,90)[2]<30);assert.ok(at(160,155)[2]>200,'Display aspect ratio was not preserved');
    p.tracks.push({id:'overlay',name:'Overlay',type:'video',muted:true,hidden:false,locked:false});p.media.push(still);const overlay=newClip('overlay',still);overlay.duration=1;overlay.scale=.3;overlay.x=70;overlay.opacity=.5;overlay.keyframes=[{time:0,x:60,y:0,scale:.2,opacity:.5,rotation:0},{time:1,x:80,y:0,scale:.3,opacity:.7,rotation:10}];const onTop=newClip('text-1');onTop.duration=1;onTop.fontSize=20;onTop.text='YUV 위의 자막';onTop.y=65;p.clips.push(overlay,onTop);await renderProject(p,settings(path.join(work,'native-with-overlays.mp4')),ctx);
  }finally{await fs.rm(work,{recursive:true,force:true});}
});

test('optional 1080p codec benchmark', {skip:process.env.SLU_BENCHMARK!=='1',timeout:300000},async(t)=>{
  const root=path.resolve('.test-artifacts/media-benchmark');await fs.mkdir(root,{recursive:true});const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
  const source=path.join(root,'source1080.mp4');await runProcess(ctx.ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=s=1920x1080:r=30:d=3','-f','lavfi','-i','sine=f=440:r=48000:d=3','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
  const media=await probeMedia(source,ctx),p=newProject();p.media=[media];const c=newClip('video-1',media);c.duration=3;c.preset='cinematic';const title=newClip('text-1');title.duration=3;title.fontSize=64;title.y=300;title.text='SLU Studio · GPU 내보내기';title.textStyle='bold';title.animation='fade';p.clips=[c,title];
  const encoders=await detectEncoders(ctx),results:Array<Record<string,unknown>>=[];
  for(const encoder of ['cpu','nvenc'] as const)for(const codec of ['h264','hevc','av1'] as const){
    if(encoder==='nvenc'&&!encoders.includes(`${codec==='hevc'?'hevc':codec}_nvenc`)){t.diagnostic(`Unavailable: ${codec}_${encoder}`);continue;}
    const outputPath=path.join(root,`${codec}-${encoder}.mp4`),start=performance.now();await renderProject(p,{outputPath,width:1920,height:1080,fps:30,format:'mp4',codec,encoder,quality:'standard'},ctx);const elapsed=(performance.now()-start)/1000;
    const output=await probeMedia(outputPath,ctx);assert.equal(output.width,1920);assert.equal(output.height,1080);assert.ok(Math.abs(output.duration-3)<.1);assert.equal(output.codec,codec==='h264'?'h264':codec==='hevc'?'hevc':'av1');const result={codec,encoder,seconds:Number(elapsed.toFixed(3)),realtimeMultiple:Number((3/elapsed).toFixed(2)),outputBytes:(await fs.stat(outputPath)).size};results.push(result);t.diagnostic(JSON.stringify(result));
  }
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({date:new Date().toISOString(),fixture:'3 s / 1920×1080 / 30 fps / cinematic effect + Korean animated title + audio',encoders,results},null,2));
});

test('optional 4K 60 fps layered NVENC export', {skip:process.env.SLU_BENCHMARK4K!=='1',timeout:180000},async(t)=>{
  const root=path.resolve('.test-artifacts/media-benchmark');await fs.mkdir(root,{recursive:true});const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
  const source=path.join(root,'source1080.mp4');if(!existsSync(source))await runProcess(ctx.ffmpeg,['-v','error','-y','-f','lavfi','-i','testsrc2=s=1920x1080:r=30:d=3','-c:v','libx264','-preset','ultrafast',source]);
  const media=await probeMedia(source,ctx),p=newProject();p.media=[media];const base=newClip('video-1',media);base.duration=3;base.preset='cinematic';base.fadeIn=.2;base.fadeOut=.2;
  p.tracks.push({id:'pip',name:'Picture in picture',type:'video',muted:true,hidden:false,locked:false});const pip=newClip('pip',media);pip.duration=3;pip.volume=0;pip.scale=.25;pip.keyframes=[{time:0,x:550,y:-250,scale:.2,opacity:.8,rotation:-3},{time:3,x:500,y:-220,scale:.3,opacity:1,rotation:7}];const title=newClip('text-1');title.duration=3;title.text='4K 60 FPS · 한글 자막';title.fontSize=70;title.y=320;title.animation='slide';p.clips=[base,pip,title];
  const outputPath=path.join(root,'4k60-h264-nvenc.mp4'),start=performance.now();await renderProject(p,{outputPath,width:3840,height:2160,fps:60,format:'mp4',codec:'h264',encoder:'nvenc',quality:'standard'},ctx);const elapsed=(performance.now()-start)/1000;
  const metadata=await probeMedia(outputPath,ctx);assert.equal(metadata.width,3840);assert.equal(metadata.height,2160);assert.equal(metadata.fps,60);assert.equal(metadata.codec,'h264');assert.ok(Math.abs(metadata.duration-3)<.05);
  const frame=path.join(root,'4k60-frame.png');await runProcess(ctx.ffmpeg,['-v','error','-y','-ss','1.5','-i',outputPath,'-frames:v','1','-vf','scale=960:540',frame]);assert.ok((await fs.stat(frame)).size>1000);
  const result={date:new Date().toISOString(),fixture:'3 s / 3840×2160 / 60 fps / 30 fps source upsampled / cinematic base + animated PiP + Korean slide title + audio',width:metadata.width,height:metadata.height,fps:metadata.fps,duration:metadata.duration,codec:metadata.codec,encoder:'h264_nvenc',seconds:Number(elapsed.toFixed(3)),realtimeMultiple:Number((3/elapsed).toFixed(2)),outputBytes:(await fs.stat(outputPath)).size,decodedSampleFrame:frame};await fs.writeFile(path.join(root,'4k-results.json'),JSON.stringify(result,null,2));t.diagnostic(JSON.stringify(result));
});
