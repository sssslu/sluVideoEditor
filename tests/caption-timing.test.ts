import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {buildAss,renderProject,renderProjectDirect,runProcess,type EngineContext} from '../electron/media';
import {newClip,newProject} from '../shared/project';
import {clipState} from '../src/preview/math';
import type {ExportSettings} from '../shared/types';

const root=path.resolve('.test-artifacts/caption-timing');
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false};
const settings=(fps:number,name:string):ExportSettings=>({outputPath:path.join(root,name),width:320,height:180,fps,format:'mp4',codec:'h264',encoder:'cpu',quality:'high'});
function centiseconds(time:string){const [h,m,s]=time.split(':').map(Number);return Math.round((h*3600+m*60+s)*100);}
function events(ass:string){return ass.split('\n').filter(line=>line.startsWith('Dialogue:')).map(line=>{const fields=line.split(',');return {start:centiseconds(fields[1]),end:centiseconds(fields[2]),line};});}
function fixture(fps:number,duration=1,start=0){const p=newProject();p.width=320;p.height=180;p.fps=fps;p.background='#000000';const c=newClip('text-1');c.text='자막 TIMING';c.start=start;c.duration=duration;c.fontSize=30;c.y=0;c.animation='none';c.keyframes=[{time:0,x:-35,y:0,scale:.9,opacity:1,rotation:0,easing:'ease-in-out'},{time:duration,x:35,y:0,scale:1.1,opacity:1,rotation:0}];p.clips=[c];return p;}

test('ASS quantization emits contiguous positive intervals at 30, 60 and 120 fps',()=>{
  for(const fps of [30,60,120])for(const [start,duration] of [[0,1],[.003,1.017],[.004,.01],[.009,.011]]){
    const p=fixture(fps,duration,start),e=events(buildAss(p,settings(fps,'coverage.mp4')));
    assert.ok(e.length,`No events at ${fps} fps, ${start}+${duration}`);
    assert.equal(e[0].start,Math.round(start*100));assert.equal(e.at(-1)!.end,Math.round((start+duration)*100));
    for(let i=0;i<e.length;i++){assert.ok(e[i].end>e[i].start,'Zero or negative ASS event');if(i)assert.equal(e[i-1].end,e[i].start,'Gap or overlapping ASS events');}
    assert.equal(e.reduce((n,event)=>n+event.end-event.start,0),Math.round((start+duration)*100)-Math.round(start*100));
  }
});

test('quantized event states retain the original nonaligned animation and inherited fade clock',()=>{
  const p=fixture(120,.411,.003),c=p.clips[0];c.animation='pop';c.fadeIn=.7;c.fadeOut=.3;c.sourceClipOffset=.121;c.sourceClipDuration=1.5;
  for(const event of events(buildAss(p,settings(120,'phase.mp4')))){
    const state=clipState(c,event.start/100),alpha=Math.round((1-state.opacity)*255),scale=state.scale*100;
    const actualAlpha=parseInt(event.line.match(/\\alpha&H([\dA-F]+)&/)![1],16),actualScale=Number(event.line.match(/\\fscx([\d.]+)/)![1]);
    assert.equal(actualAlpha,alpha,`Fade phase changed at ${event.start} cs`);assert.ok(Math.abs(actualScale-scale)<.00001,`Pop phase changed at ${event.start} cs`);
    assert.ok(event.line.includes(`\\t(0,${(event.end-event.start)*10},`),'Transform duration does not match emitted ASS interval');
  }
});

test('real caption pixels remain visible at 30, 60 and 120 fps', {timeout:60000},async()=>{
  await fs.mkdir(root,{recursive:true});
  for(const fps of [30,60,120]){
    const p=fixture(fps,1.003,.003),destination=path.join(root,`presence-${fps}.yuv`),frames=fps;
    await renderProjectDirect(p,settings(fps,`presence-${fps}.mp4`),ctx,undefined,undefined,{start:0,duration:1,frames,destination});
    const raw=await fs.readFile(destination),frameBytes=320*180*3/2;assert.equal(raw.length,frames*frameBytes);
    for(let frame=1;frame<frames;frame++){const y=raw.subarray(frame*frameBytes,frame*frameBytes+320*180);let bright=0;for(const pixel of y)if(pixel>100)bright++;assert.ok(bright>150,`Caption missing at ${fps} fps, frame ${frame}: ${bright} bright pixels`);}
  }
});

test('120 fps eased captions have identical actual frames across one- and six-second export windows', {timeout:120000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const p=fixture(120,6.123,.003),c=p.clips[0];c.animation='pop';c.fadeIn=.1;c.fadeOut=.12;
  const frames:Buffer[]=[];
  for(const windowSize of [1,6]){const output=settings(120,`window-${windowSize}.mp4`);await renderProject(p,output,{...ctx,maxWindowSeconds:windowSize});frames.push((await runProcess(ctx.ffmpeg,['-v','error','-i',output.outputPath!,'-map','0:v:0','-pix_fmt','gray','-f','rawvideo','pipe:1'],{maxOutputBytes:80*1024*1024})).stdout);}
  const frameBytes=320*180,total=Math.ceil((c.start+c.duration)*120);assert.equal(frames[0].length,total*frameBytes);assert.equal(frames[1].length,frames[0].length);
  const mismatches:number[]=[];for(let i=0;i<total;i++)if(!frames[0].subarray(i*frameBytes,(i+1)*frameBytes).equals(frames[1].subarray(i*frameBytes,(i+1)*frameBytes)))mismatches.push(i);
  assert.deepEqual(mismatches,[],'Changing export windows changed caption pixels');
  for(const i of [119,120,121,719,720,721]){let bright=0;for(const pixel of frames[0].subarray(i*frameBytes,(i+1)*frameBytes))if(pixel>70)bright++;assert.ok(bright>100,`Caption disappeared around a window boundary: frame ${i}`);}
  const report={date:new Date().toISOString(),fps:120,frames:total,windowSizes:[1,6],frameDifferences:mismatches.length,boundaryFrames:[119,120,121,719,720,721]};await fs.writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));t.diagnostic(JSON.stringify(report));
});
