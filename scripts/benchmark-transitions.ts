import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {detectEncoders,probeMedia,renderProject,runProcess,type EngineContext} from '../electron/media';
import type {ExportSettings} from '../shared/types';

const root=path.resolve('.test-artifacts/transitions/benchmark');await fs.mkdir(root,{recursive:true});
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{maxOutputBytes:64*1024*1024});
const files=[path.join(root,'a.png'),path.join(root,'b.png')];for(const [i,file] of files.entries())await ff(['-f','lavfi','-i',i?'testsrc2=s=960x540:r=1:d=1':'testsrc=s=960x540:r=1:d=1','-frames:v','1',file]);
const media=await Promise.all(files.map(file=>probeMedia(file,ctx,undefined,{derivatives:false}))),project=newProject();project.width=1920;project.height=1080;project.fps=30;project.media=media;project.background='#112233';
const a=newClip('video-1',media[0]);a.duration=2;a.scale=.85;a.rotation=-5;a.opacity=.7;a.mask={type:'ellipse',x:.5,y:.5,width:.9,height:.9,feather:.04,invert:false};const b=newClip('video-1',media[1],2);b.duration=2;b.scale=1.05;b.rotation=5;b.opacity=.8;project.clips=[a,b];project.transitions=[{id:'benchmark-pair',fromClipId:a.id,toClipId:b.id,kind:'dissolve',durationFrames:30,easing:'ease-in-out'}];
const kind=(process.argv.find(arg=>arg.startsWith('--kind='))?.slice(7)||'dissolve') as 'dissolve'|'wipe'|'slide'|'zoom';assert.ok(['dissolve','wipe','slide','zoom'].includes(kind));project.transitions[0].kind=kind;
const baseline=process.argv.includes('--baseline');if(baseline)project.transitions=undefined;
const available=await detectEncoders(ctx),encoder=available.includes('h264_nvenc')?'nvenc':'cpu',settings:ExportSettings={outputPath:path.join(root,'1080p-transition.mp4'),width:1920,height:1080,fps:30,format:'mp4',codec:'h264',encoder,quality:'high'};
if(baseline||kind!=='dissolve')settings.outputPath=path.join(root,`1080p-${baseline?'baseline':kind}.mp4`);
const events:Record<string,unknown>[]=[],started=performance.now();await renderProject(project,settings,{...ctx,diagnostics:event=>events.push(event)});const seconds=(performance.now()-started)/1000;
const probe=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-show_streams','-show_format','-of','json',settings.outputPath!])).stdout.toString()),video=probe.streams.find((stream:any)=>stream.codec_type==='video');assert.equal(video.width,1920);assert.equal(video.height,1080);assert.equal(video.nb_frames,'120');assert.equal(video.avg_frame_rate,'30/1');
const samples=[];for(const time of [.5,2,3.5]){const file=path.join(root,`${baseline?'baseline':kind}-sample-${time}.png`);await ff(['-ss',String(time),'-i',settings.outputPath!,'-frames:v','1',file]);samples.push(file);}
const gpuTransitions=events.some(event=>event.event==='gpu-processing'&&event.backend==='opencl-transitions');
const result={passed:true,recordedAt:new Date().toISOString(),kind:baseline?'none':kind,seconds,duration:4,transitionDuration:baseline?0:1,resolution:'1920x1080',fps:30,frames:Number(video.nb_frames),codec:video.codec_name,encoder,compositionBackend:gpuTransitions?'cpu-effects + opencl-transitions':'cpu',transitionBackend:gpuTransitions?'opencl-fp64-unorm16':'cpu',composition:'Ellipse mask, scale, rotation and opacity on CPU; premultiplied transition on '+(gpuTransitions?'OpenCL GPU':'CPU'),hardwareEncoding:encoder==='nvenc',maxVisualInputs:Math.max(...events.filter(event=>event.event==='window-start').map(event=>Number(event.visualInputs))),samples,streamMetrics:events.find(event=>event.event==='stream-metrics'),errors:[]};await fs.writeFile(path.join(root,`${baseline?'baseline':kind}-results.json`),JSON.stringify(result,null,2));if(!baseline&&kind==='dissolve')await fs.writeFile(path.join(root,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
