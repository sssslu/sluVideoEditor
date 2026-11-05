import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newClip,newProject,projectDuration} from '../shared/project';
import {compileTransitions} from '../shared/transitions';
import {probeMedia,renderProjectDirect,runProcess,type EngineContext} from '../electron/media';
import type {ExportSettings,Transition} from '../shared/types';

const root=path.resolve('.test-artifacts/transitions/render'),width=160,height=90,bytes=width*height*1.5;
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{maxOutputBytes:32*1024*1024});
async function asset(name:string,color:[number,number,number,number]){const file=path.join(root,`${name}.png`),raw=Buffer.alloc(32*18*4);for(let i=0;i<32*18;i++)raw.set(color,i*4);const input=path.join(root,`${name}.rgba`);await fs.writeFile(input,raw);await ff(['-f','rawvideo','-pixel_format','rgba','-video_size','32x18','-i',input,'-frames:v','1',file]);return probeMedia(file,ctx,undefined,{derivatives:false});}
const settings=(name:string,fps=24):ExportSettings=>({outputPath:path.join(root,`${name}.mp4`),width,height,fps,format:'mp4',codec:'h264',encoder:'cpu',quality:'high'});
async function rawProject(project:ReturnType<typeof newProject>,name:string,window:number,fps=24){const parts:Buffer[]=[],total=Math.round(projectDuration(project)*fps),transitionPlan=compileTransitions(project);for(let start=0;start<total;start+=Math.round(window*fps)){const frames=Math.min(Math.round(window*fps),total-start),destination=path.join(root,`${name}-${start}.yuv`);await renderProjectDirect(project,settings(name,fps),ctx,undefined,undefined,{start:start/fps,duration:frames/fps,frames,destination,transitionPlan});parts.push(await fs.readFile(destination));}return Buffer.concat(parts);}

test('all four transition types keep original effect clocks, outside frames and1s/6s render-window parity',{timeout:60000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const media=await Promise.all([asset('background',[17,34,51,255]),asset('a',[225,40,70,180]),asset('b',[20,190,240,170])]);
  const p=newProject();p.width=width;p.height=height;p.fps=30;p.media=media;p.tracks.push({id:'video-2',name:'Top',type:'video',muted:false,hidden:false,locked:false});
  const background=newClip('video-1',media[0]);background.duration=4;const a=newClip('video-2',media[1],.137);a.duration=1.733;a.opacity=.75;a.fadeOut=1.4;a.scale=.9;a.rotation=12;a.x=-13;a.y=8;a.crop={left:.1,right:0,top:0,bottom:0};a.preset='warm';
  const b=newClip('video-2',media[2],a.start+a.duration);b.duration=1.9;b.fadeIn=1.4;b.sourceClipOffset=.4;b.sourceClipDuration=3;b.mask={type:'ellipse',x:.5,y:.5,width:.8,height:.8,feather:.05,invert:false};b.keyframes=[{time:0,x:10,y:-4,scale:.8,opacity:.65,rotation:-8,easing:'ease-in-out'},{time:b.duration,x:-10,y:5,scale:1.1,opacity:.9,rotation:7}];p.clips=[background,a,b];
  const stored=JSON.stringify(p.clips),baseline=await rawProject(p,'baseline',6),baselineChunks=await rawProject(p,'baseline-chunks',1),results=[];assert.ok(baselineChunks.equals(baseline),'Baseline effect windows changed before transitions');
  for(const kind of ['dissolve','wipe','slide','zoom'] as const){p.transitions=[{id:'pair',fromClipId:a.id,toClipId:b.id,kind,durationFrames:31,direction:'up',easing:'ease-in-out'}];const interval=compileTransitions(p).transitions[0];const whole=await rawProject(p,`${kind}-whole`,6),chunks=await rawProject(p,`${kind}-chunks`,1);assert.equal(whole.length,96*bytes);assert.ok(chunks.equals(whole),`${kind}: render windows changed pixels`);
    let unchanged=0;for(let frame=0;frame<96;frame++){const time=frame/24;if(time>=interval.start&&time<interval.end)continue;assert.ok(whole.subarray(frame*bytes,(frame+1)*bytes).equals(baseline.subarray(frame*bytes,(frame+1)*bytes)),`${kind}: frame ${frame} outside transition changed`);unchanged++;}
    assert.equal(JSON.stringify(p.clips),stored);results.push({kind,frames:96,outsideFramesUnchanged:unchanged,windowDifferences:0,start:interval.start,end:interval.end});
  }
  p.transitions=undefined;assert.ok((await rawProject(p,'removed',6)).equals(baseline));await fs.writeFile(path.join(root,'parity-results.json'),JSON.stringify(results,null,2));t.diagnostic(JSON.stringify(results));
});

test('one middle clip can feed two touching transition pairs without a seam or doubled layer',{timeout:30000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const media=await Promise.all([asset('red',[255,0,0,255]),asset('blue',[0,0,255,255]),asset('green',[0,255,0,255])]),p=newProject();p.width=width;p.height=height;p.fps=30;p.media=media;p.clips=media.map((m,i)=>({...newClip('video-1',m,i),duration:1}));p.transitions=[0,1].map(i=>({id:`pair${i}`,fromClipId:p.clips[i].id,toClipId:p.clips[i+1].id,kind:'dissolve',durationFrames:30}));
  const whole=await rawProject(p,'three-whole',6,30),chunks=await rawProject(p,'three-chunks',1,30);assert.ok(chunks.equals(whole));const input=path.join(root,'three.yuv');await fs.writeFile(input,whole);const rgb=(await ff(['-f','rawvideo','-pixel_format','yuv420p','-video_size',`${width}x${height}`,'-framerate','30','-i',input,'-vf','scale=in_color_matrix=bt709','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
  const center=(frame:number)=>[...rgb.subarray((frame*width*height+45*width+80)*3,(frame*width*height+45*width+80)*3+3)];const samples=[center(30),center(45),center(60)];assert.ok(samples[0][0]>120&&samples[0][2]>120&&samples[0][1]<4);assert.ok(samples[1][2]>248&&samples[1][0]<4&&samples[1][1]<4);assert.ok(samples[2][1]>120&&samples[2][2]>120&&samples[2][0]<4);t.diagnostic(JSON.stringify({samples,frames:90,sharedMiddleClip:true}));
});

test('real video handles and original variable-speed clocks are identical across fractional-cut render windows',{timeout:60000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const file=path.join(root,'moving.mp4');await ff(['-f','lavfi','-i','testsrc2=s=160x90:r=120:d=8','-c:v','libx264','-preset','ultrafast','-crf','0',file]);const media=await probeMedia(file,ctx,undefined,{derivatives:false});assert.equal(media.videoStart,0);assert.equal(media.videoEnd,8);
  const p=newProject();p.width=width;p.height=height;p.fps=30;p.media=[media];const a=newClip('video-1',media,.137);a.in=.8;a.duration=1.733;a.speedCurve=[{position:0,speed:.8},{position:.5,speed:1.4},{position:1,speed:.7}];const b=newClip('video-1',media,a.start+a.duration);b.in=3;b.duration=1.9;b.speed=1.2;p.clips=[a,b];p.transitions=[{id:'real-video',fromClipId:a.id,toClipId:b.id,kind:'slide',direction:'left',durationFrames:31,easing:'ease-out'}];const original=JSON.stringify(p.clips),whole=await rawProject(p,'video-whole',6),chunks=await rawProject(p,'video-chunks',1);assert.equal(whole.length,Math.round(projectDuration(p)*24)*bytes);assert.ok(chunks.equals(whole),'Video decode/curve/window boundaries changed frames');assert.equal(JSON.stringify(p.clips),original);const result={frames:whole.length/bytes,projectFps:30,exportFps:24,cut:b.start,windowDifferences:0,originalClocksPreserved:true};await fs.writeFile(path.join(root,'video-results.json'),JSON.stringify(result,null,2));t.diagnostic(JSON.stringify(result));
});
