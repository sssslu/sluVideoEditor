import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {probeMedia,renderProject,renderProjectDirect,runProcess,enrichMedia,keyframeExpression,buildAss,type EngineContext} from '../electron/media';
import {planRenderWindows} from '../electron/render-plan';
import {newClip,newProject,splitClip,interpolate} from '../shared/project';
import type {ExportSettings,Project} from '../shared/types';

const root=path.resolve('.test-artifacts/render-v2');
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const settings=(file:string):ExportSettings=>({outputPath:path.join(root,file),width:320,height:180,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'high'});
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{maxOutputBytes:64*1024*1024});
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');

test('window planner opens timeline-local sources, supports 10k clip projects',()=>{
  const p=newProject();const media={id:'m',path:path.resolve('fixture.mp4'),name:'fixture',kind:'video' as const,duration:2,width:320,height:180,fps:30,hasAudio:false};p.media=[media];p.clips=Array.from({length:10000},(_,i)=>({...newClip('video-1',media,i*2),duration:2}));
  const windows=planRenderWindows(p,settings('plan.mp4'));assert.ok(windows.length>1000);assert.ok(windows.every(w=>w.visualInputs<=4));assert.equal(windows.reduce((n,w)=>n+w.frames,0),600000);
});

test('a 24-hour eased title generates only the active window ASS events',()=>{
  const p=newProject(),c=newClip('text-1');c.duration=86400;c.keyframes=[{time:0,x:0,y:0,scale:1,opacity:1,rotation:0,easing:'ease-in-out'},{time:86400,x:100,y:10,scale:1,opacity:1,rotation:0}];p.clips=[c];const ass=buildAss(p,settings('long-title.mp4'),{start:43200,end:43206});assert.ok(ass.length<200000);assert.ok(ass.split('Dialogue:').length<200);
  c.keyframes[0].easingStart=.5;c.keyframes[0].easingEnd=.5000001;const expression=keyframeExpression(c,'x');assert.ok(!expression.includes('/0)'));assert.ok(expression.includes('e-7'),'Restricted easing domain lost precision');
});

test('chunk boundary parity: nonaligned trim/speed, keyframes, captions and continuous audio', {timeout:120000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const source=path.join(root,'source12.mp4');await ff(['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=12','-f','lavfi','-i','sine=f=437:r=48000:d=12','-c:v','libx264','-preset','ultrafast','-c:a','aac','-shortest',source]);
  const metadata=await probeMedia(source,ctx,undefined,{derivatives:false});assert.equal(metadata.thumbnail,undefined);assert.equal(metadata.waveform,undefined);const enriched=await enrichMedia(metadata,ctx);assert.equal(enriched.id,metadata.id);assert.ok(enriched.thumbnail&&enriched.waveform?.length);
  const p=newProject();p.width=320;p.height=180;p.media=[enriched];const base=newClip('video-1',enriched);base.start=.137;base.in=.073;base.speed=1.27;base.duration=8.13;base.fadeIn=.7;base.fadeOut=.9;base.scale=.85;base.keyframes=[{time:0,x:-12,y:0,scale:.8,opacity:.8,rotation:-4,easing:'ease-in-out'},{time:8.13,x:14,y:2,scale:.95,opacity:1,rotation:8}];
  base.volume=7.5;const audio=newClip('audio-1',enriched,2.113);audio.in=1.273;audio.duration=4.37;audio.speed=.75;audio.volume=6;audio.fadeIn=.6;audio.fadeOut=.7;const caption=newClip('text-1');caption.start=.181;caption.duration=7.89;caption.text='구간 경계 테스트';caption.fontSize=22;caption.y=50;caption.animation='slide';caption.keyframes=[{time:0,x:-10,y:45,scale:.8,opacity:.5,rotation:0,easing:'ease-out'},{time:7.89,x:10,y:45,scale:1,opacity:1,rotation:0}];p.clips=[base,audio,caption];
  p.clips.push({...base,id:newClip('audio-1').id,trackId:'audio-1'});
  const diagnostics:Record<string,unknown>[]=[];await renderProject(p,settings('window6.mp4'),{...ctx,maxWindowSeconds:6,diagnostics:e=>diagnostics.push(e)});await renderProject(p,settings('window1.mp4'),{...ctx,maxWindowSeconds:1});
  const digest=async(file:string)=>{const r=await ff(['-i',path.join(root,file),'-map','0:v:0','-f','framemd5','pipe:1']);return r.stdout.toString().split('\n').filter(s=>s&&!s.startsWith('#')).map(s=>s.split(',').at(-1)?.trim());};
  const a=await digest('window6.mp4'),b=await digest('window1.mp4');assert.equal(a.length,Math.ceil(8.267*30));const mismatches=a.flatMap((v,i)=>v===b[i]?[]:[i]);t.diagnostic(`Window frame hash differences: ${mismatches.length}/${a.length}; ${mismatches.slice(0,40).join(',')}`);
  if(mismatches.length){const raw6=path.join(root,'raw6.yuv');await renderProjectDirect(p,settings('raw.mp4'),ctx,undefined,undefined,{start:0,duration:6,frames:180,destination:raw6});const whole=await fs.readFile(raw6),frameBytes=320*180*1.5;const rawDifferences:number[]=[];for(let second=0;second<6;second++){const raw1=path.join(root,`raw1-${second}.yuv`);await renderProjectDirect(p,settings('raw.mp4'),ctx,undefined,undefined,{start:second,duration:1,frames:30,destination:raw1});const piece=await fs.readFile(raw1);for(let frame=0;frame<30;frame++)if(!whole.subarray((second*30+frame)*frameBytes,(second*30+frame+1)*frameBytes).equals(piece.subarray(frame*frameBytes,(frame+1)*frameBytes)))rawDifferences.push(second*30+frame);}t.diagnostic(`Raw frame differences: ${rawDifferences.join(',')}`);}
  assert.equal(mismatches.length,0,'Changing window size changed composed frames');
  for(const size of [1,6])await renderProject(p,{...settings(`audio-window${size}.wav`),format:'wav'},{...ctx,maxWindowSeconds:size});const pcm=async(file:string)=>(await ff(['-i',path.join(root,file),'-f','s16le','pipe:1'])).stdout;const pcm1=await pcm('audio-window1.wav'),pcm6=await pcm('audio-window6.wav');assert.equal(pcm1.length,Math.round(8.267*48000)*4);assert.equal(hash(pcm1),hash(pcm6),'Changing windows restarted atempo or audio fades');let peak=0;for(let sample=0;sample<pcm1.length;sample+=2)peak=Math.max(peak,Math.abs(pcm1.readInt16LE(sample))/32768);assert.ok(peak>.95&&peak<=1,`Single final limiter peak ${peak}`);
  const metrics=diagnostics.find(e=>e.event==='stream-metrics');assert.ok(Number(metrics?.peakVideoBufferBytes)<1024*1024);assert.ok(Number(metrics?.peakAudioBufferBytes)<128*1024);t.diagnostic(JSON.stringify(metrics));
  await fs.writeFile(path.join(root,'boundary-results.json'),JSON.stringify({frames:a.length,frameDifferences:mismatches.length,audioSamples:pcm1.length/4,audioHash:hash(pcm1),metrics},null,2));
});

test('source crop, chroma before adjustments, feathered masks and solo tracks affect real output', {timeout:60000},async()=>{
  await fs.mkdir(root,{recursive:true});const green=path.join(root,'green.png'),white=path.join(root,'white.png');await ff(['-f','lavfi','-i','color=c=0x00ff00:s=160x90,drawbox=x=40:y=20:w=80:h=50:color=red:t=fill','-frames:v','1',green]);await ff(['-f','lavfi','-i','color=white:s=160x90','-frames:v','1',white]);
  const [greenAsset,whiteAsset]=await Promise.all([probeMedia(green,ctx),probeMedia(white,ctx)]);const p=newProject();p.width=320;p.height=180;p.background='#0000ff';p.media=[greenAsset,whiteAsset];const keyed=newClip('video-1',greenAsset);keyed.duration=1;keyed.chromaKey={enabled:true,color:'#00ff00',similarity:.02,smoothness:.02};keyed.brightness=-.5;p.clips=[keyed];
  const pixels=async(file:string)=>{await renderProject(p,settings(file),ctx);return (await ff(['-ss','0.5','-i',path.join(root,file),'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;};const pixel=(data:Buffer,x:number,y:number)=>Array.from(data.subarray((y*320+x)*3,(y*320+x)*3+3));
  let image=await pixels('keyed.mp4');assert.ok(pixel(image,20,20)[2]>220&&pixel(image,20,20)[1]<20);assert.ok(pixel(image,160,90)[0]>100&&pixel(image,160,90)[1]<20);
  const masked=newClip('video-1',whiteAsset);masked.duration=1;masked.mask={type:'rect',x:.5,y:.5,width:.5,height:.5,feather:.2,invert:false};p.clips=[masked];image=await pixels('masked.mp4');assert.ok(pixel(image,160,90)[0]>220);assert.ok(pixel(image,15,15)[2]>220&&pixel(image,15,15)[0]<20);assert.ok(pixel(image,80,90)[0]>90&&pixel(image,80,90)[0]<160);
  masked.mask={...masked.mask,type:'ellipse',invert:true};image=await pixels('ellipse-invert.mp4');assert.ok(pixel(image,160,90)[2]>220&&pixel(image,160,90)[0]<20);assert.ok(pixel(image,15,15)[0]>220);
  keyed.chromaKey=undefined;keyed.brightness=0;keyed.crop={left:0,top:0,right:.8,bottom:0};keyed.fit='cover';p.clips=[keyed];image=await pixels('crop.mp4');assert.ok(pixel(image,160,90)[1]>220&&pixel(image,160,90)[0]<20);
  p.tracks.push({id:'solo',name:'solo',type:'video',muted:false,hidden:false,locked:false,solo:true});const top=newClip('solo',whiteAsset);top.duration=1;p.clips.push(top);image=await pixels('solo.mp4');assert.ok(pixel(image,160,90)[0]>220&&pixel(image,160,90)[1]>220);
});

test('bounded export cancellation closes streams and removes temporary output', {timeout:30000},async()=>{
  const media=await probeMedia(path.join(root,'source12.mp4'),ctx,undefined,{derivatives:false}),p=newProject();p.width=640;p.height=360;p.media=[media];p.clips=Array.from({length:20},(_,i)=>({...newClip('video-1',media,i*3),duration:3}));const control=new AbortController(),output=settings('cancel-v2.mp4');await fs.rm(output.outputPath!,{force:true});
  await assert.rejects(renderProject(p,output,{...ctx,maxWindowSeconds:1,diagnostics:e=>{if(e.event==='window-start'&&e.index===2)control.abort();}},undefined,control.signal),error=>error instanceof Error&&error.name==='AbortError');assert.equal(await fs.stat(output.outputPath!).then(()=>true,()=>false),false);assert.equal((await fs.readdir(root)).filter(f=>f.includes('cancel-v2.mp4')&&f.includes('partial')).length,0);
});

test('fractional clip endpoints hold their last source frame until the timeline end', {timeout:30000},async()=>{
  const asset=await probeMedia(path.join(root,'white.png'),ctx),p=newProject();p.width=320;p.height=180;p.media=[asset];const c=newClip('video-1',asset,.137);c.duration=1.13;p.clips=[c];await renderProject(p,settings('fractional-end.mp4'),ctx);
  const data=(await ff(['-ss',String(38/30),'-i',path.join(root,'fractional-end.mp4'),'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;assert.equal(data.length,320*180*3);assert.ok(data[3*(90*320+160)]>230,'Final timeline frame unexpectedly turned black');
});

test('color conversion honors tagged HD601 and infers709 only for untagged HD', {timeout:60000},async(t)=>{
  const samples:Array<Record<string,unknown>>=[];
  for(const tag of ['smpte170m','bt709','unknown']){
    const file=path.join(root,`matrix-${tag}.mp4`),matrix=tag==='smpte170m'?'bt601':'bt709';
    await ff(['-f','lavfi','-i','testsrc2=s=1280x720:r=30:d=0.5',...(tag==='unknown'?[]:['-vf',`scale=in_color_matrix=bt601:out_color_matrix=${matrix},setparams=colorspace=${tag}:color_primaries=bt709:color_trc=bt709`]),'-c:v','libx264','-crf','10','-preset','ultrafast',file]);
    const asset=await probeMedia(file,ctx,undefined,{derivatives:false}),p=newProject();p.width=320;p.height=180;p.media=[asset];const c=newClip('video-1',asset);c.duration=.5;p.clips=[c];await renderProject(p,settings(`matrix-out-${tag}.mp4`),{...ctx,gpuProcessing:false});
    const raw=async(file:string,filter:string)=>(await ff(['-ss','0.2','-i',file,'-frames:v','1','-vf',filter,'-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
    const reference=await raw(file,`scale=320:180:in_color_matrix=${matrix}:out_color_matrix=bt709:flags=bilinear`),actual=await raw(path.join(root,`matrix-out-${tag}.mp4`),'null');let sum=0;for(let i=0;i<reference.length;i++)sum+=Math.abs(reference[i]-actual[i]);const mae=sum/reference.length;assert.ok(mae<4,`${tag} matrix changed colors, MAE ${mae}`);samples.push({tag,meanAbsoluteRgbError:mae});
  }
  t.diagnostic(JSON.stringify(samples));await fs.writeFile(path.join(root,'color-results.json'),JSON.stringify(samples,null,2));
});

test('export matches captured WebGL crop, chroma and mask fixtures', {skip:process.env.SLU_PREVIEW_COMPARE!=='1',timeout:60000},async(t)=>{
  const gpuRoot=path.resolve('.test-artifacts/gpu-preview'),media=await probeMedia(path.join(gpuRoot,'quadrants.png'),ctx),p=newProject();p.width=320;p.height=180;p.fps=30;p.background='#112233';p.media=[media];
  const variants:Record<string,Partial<ReturnType<typeof newClip>>>={baseline:{},flip:{flipH:true},rotation:{rotation:180},crop:{crop:{left:.5,top:0,right:0,bottom:0}},chroma:{chromaKey:{enabled:true,color:'#14e628',similarity:.02,smoothness:.05}},mask:{mask:{type:'ellipse',x:.5,y:.5,width:.7,height:.9,feather:.05,invert:false}},blur:{blur:8}};
  const report:Array<Record<string,unknown>>=[];
  for(const [name,overrides] of Object.entries(variants)){
    p.clips=[{...newClip('video-1',media),duration:.5,...overrides}];const output=settings(`preview-${name}.mp4`);await renderProject(p,output,ctx);
    const decode=async(file:string)=>(await ff(['-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;const expected=await decode(path.join(gpuRoot,`${name}.png`)),actual=await decode(output.outputPath!);assert.equal(actual.length,expected.length);let absolute=0,squared=0;for(let i=0;i<actual.length;i++){const diff=actual[i]-expected[i];absolute+=Math.abs(diff);squared+=diff*diff;}const mean=absolute/actual.length;assert.ok(mean<(name==='blur'?10:5),`${name}: WebGL/export RGB MAE ${mean}`);report.push({variant:name,meanAbsoluteRgbError:mean,rgbRmsError:Math.sqrt(squared/actual.length)});
  }
  await fs.writeFile(path.join(root,'preview-comparison.json'),JSON.stringify(report,null,2));t.diagnostic(JSON.stringify(report));
});

test('a full-length upper clip keeps one compositing path across render windows',{timeout:60000},async()=>{
  // A lower clip visible only in the first window must not let the upper clip
  // switch to the native YUV base later; odd heights would shift by a row.
  await fs.mkdir(root,{recursive:true});const bars=path.join(root,'bars-160x67.mp4'),under=path.join(root,'under-1s.mp4');
  await ff(['-f','lavfi','-i','smptebars=s=160x67:r=30:d=2','-c:v','libx264','-preset','ultrafast','-qp','0','-pix_fmt','yuv444p',bars]);
  await ff(['-f','lavfi','-i','color=red:s=160x90:r=30:d=1','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',under]);
  const a=await probeMedia(bars,ctx,undefined,{derivatives:false}),b=await probeMedia(under,ctx,undefined,{derivatives:false}),p=newProject();p.width=160;p.height=90;p.fps=30;p.media=[a,b];
  p.tracks=[{...p.tracks[0],id:'video-under',name:'영상 0'},...p.tracks];p.clips=[{...newClip('video-under',b),duration:1,opacity:0},{...newClip('video-1',a),duration:2}];
  const output={...settings('unused-path.mp4'),width:160,height:90},frame=160*90*1.5;
  const render=async(from:number,frames:number)=>{const file=path.join(root,`path-window-${from}-${frames}.yuv`);await renderProjectDirect(p,output,{...ctx,gpuProcessing:false},undefined,undefined,{start:from/30,duration:frames/30,frames,destination:file});return fs.readFile(file);};
  const first=await render(0,30),second=await render(30,30),whole=await render(0,60);
  assert.ok(first.subarray(29*frame).equals(second.subarray(0,frame)),'static clip moved at the window boundary');
  assert.ok(Buffer.concat([first,second]).equals(whole),'windowed output differs from one window');
});
