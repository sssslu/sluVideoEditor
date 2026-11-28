import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {probeMedia,renderProject,runProcess,exportRetry,type EngineContext} from '../electron/media';
import {RawStreamBridge} from '../electron/render-stream';
import {newClip,newProject} from '../shared/project';
import type {Clip,ExportSettings,MediaAsset,Project} from '../shared/types';

// Steady video clips (plain cuts, a fixed zoom or position) are drawn as opaque YUV layers with one
// resize instead of going through the RGBA layer path. These tests pin two things: which clips take
// which path, and that the fast path frames the picture exactly where the layer path does.
const root=path.resolve('.test-artifacts/render-opaque');
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const W=320,H=180;
const settings=(file:string):ExportSettings=>({outputPath:path.join(root,file),width:W,height:H,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'high'});
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{maxOutputBytes:64*1024*1024});
const luma=async(file:string,index:number)=>{const raw=`${file}.${index}.gray`;await ff(['-i',file,'-vf',`select=eq(n\\,${index}),format=gray`,'-frames:v','1','-f','rawvideo',raw]);return fs.readFile(raw);};
/** Mean absolute luma difference with `b` moved by (dx,dy), over the area both cover. */
function distance(a:Buffer,b:Buffer,dx=0,dy=0){let sum=0,n=0;for(let y=4;y<H-4;y++)for(let x=4;x<W-4;x++){sum+=Math.abs(a[y*W+x]-b[(y+dy)*W+x+dx]);n++;}return sum/n;}
async function source(name:string,size:string){
  await fs.mkdir(root,{recursive:true});const file=path.join(root,name);
  await ff(['-f','lavfi','-i',`testsrc2=s=${size}:r=30:d=4`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',file]);
  return probeMedia(file,ctx,undefined,{derivatives:false});
}
type Layers={nativeBase:boolean;opaque:number;rgba:number};
async function render(project:Project,file:string){
  const layers:Layers[]=[],messages:(string|undefined)[]=[];
  const output=await renderProject(project,settings(file),{...ctx,diagnostics:event=>{if(event.event==='window-layers')layers.push(event as unknown as Layers);}},(value,message)=>{if(value<1)messages.push(message);});
  return {output,layers,messages};
}
/** Two cuts of one source, so no clip spans the whole timeline (that case is the native base). */
function cuts(media:MediaAsset,change:(clip:Clip)=>void):Project{
  const p=newProject();p.width=W;p.height=H;p.media=[media];p.tracks=p.tracks.filter(t=>t.type!=='text');
  p.clips=[0,2].map(start=>{const c=newClip('video-1',media,start);c.in=start;c.duration=2;change(c);return c;});
  return p;
}
/** The same picture, but with two identical keyframes: that keeps the clip on the RGBA layer path. */
const pinned=(c:Clip)=>{c.keyframes=[0,c.duration].map(time=>({time,x:c.x,y:c.y,scale:c.scale,opacity:1,rotation:0}));};

const cases:[string,string,(c:Clip)=>void][]=[
  ['plain cuts','wide',()=>{}],
  ['zoom 1.5 moved right and up','wide',c=>{c.scale=1.5;c.x=20;c.y=-10;}],
  ['shrunk to half, off centre','wide',c=>{c.scale=.5;c.x=-40;c.y=30;}],
  ['4:3 picture contained','narrow',()=>{}],
  ['4:3 picture covering','narrow',c=>{c.fit='cover';}],
  ['4:3 picture covering, zoomed','narrow',c=>{c.fit='cover';c.scale=1.25;c.x=-12;c.y=8;}],
];

test('steady clips take the opaque path and land exactly where the layer path puts them',{timeout:300000},async()=>{
  const media={wide:await source('wide.mp4','320x180'),narrow:await source('narrow.mp4','240x180')};
  for(const [name,kind,change] of cases){
    const slug=name.replace(/\W+/g,'-'),asset=media[kind as 'wide'|'narrow'];
    const fast=await render(cuts(asset,change),`${slug}-fast.mp4`),slow=await render(cuts(asset,c=>{change(c);pinned(c);}),`${slug}-layer.mp4`);
    assert.ok(fast.layers.length&&fast.layers.every(l=>!l.nativeBase&&l.rgba===0&&l.opaque>0),`${name}: steady clips are opaque layers ${JSON.stringify(fast.layers)}`);
    assert.ok(slow.layers.length&&slow.layers.every(l=>l.opaque===0&&l.rgba>0),`${name}: keyframed clips stay on the layer path ${JSON.stringify(slow.layers)}`);
    for(const frame of [10,75,119]){
      const a=await luma(fast.output,frame),b=await luma(slow.output,frame),same=distance(a,b);
      // The layer path resizes twice, so the pictures differ a little in sharpness but not in place:
      // moving one of them by a pixel in any direction must make the match worse.
      const moved=Math.min(...[[1,0],[-1,0],[0,1],[0,-1]].map(([dx,dy])=>distance(a,b,dx,dy)));
      assert.ok(same<moved,`${name} frame ${frame}: best match is unshifted (${same.toFixed(2)} vs ${moved.toFixed(2)} one pixel away)`);
      assert.ok(same<6,`${name} frame ${frame}: pictures agree (${same.toFixed(2)})`);
    }
    // Once a stage has been announced, percent-only updates keep its text.
    const first=fast.messages.findIndex(Boolean);assert.ok(first>=0&&fast.messages.slice(first).every(message=>typeof message==='string'&&message.length>0),`${name}: progress lines keep their stage text`);
  }
});

test('a faded clip and a half-transparent clip keep the layer path',{timeout:120000},async()=>{
  const asset=await source('wide.mp4','320x180');
  const faded=await render(cuts(asset,c=>{c.fadeIn=.5;}),'faded.mp4');
  assert.ok(faded.layers.every(l=>l.opaque===0&&l.rgba>0),JSON.stringify(faded.layers));
  const mixed=cuts(asset,()=>{});mixed.clips[1].opacity=.5;
  const result=await render(mixed,'mixed.mp4');
  assert.ok(result.layers.some(l=>l.opaque===1)&&result.layers.some(l=>l.rgba===1),`one opaque and one layered clip ${JSON.stringify(result.layers)}`);
});

test('only an encoder or GPU-processing fault restarts an export',async()=>{
  const fault=(exportFault:string)=>Object.assign(new Error('x'),{exportFault});
  const gpu={usedGpuProcessing:true,encoder:'h264_nvenc',automaticEncoder:true};
  assert.equal(exportRetry(fault('window'),gpu),'cpu-processing');
  assert.equal(exportRetry(fault('window'),{...gpu,usedGpuProcessing:false}),undefined,'a failed window without GPU processing would fail again');
  assert.equal(exportRetry(fault('encoder'),gpu),'cpu-encoder');
  assert.equal(exportRetry(fault('encoder'),{...gpu,automaticEncoder:false}),undefined,'a chosen encoder is not replaced');
  assert.equal(exportRetry(fault('encoder'),{...gpu,encoder:'libx264'}),undefined);
  assert.equal(exportRetry(new Error('렌더 구간이 불완전합니다 (1/2 바이트).'),gpu),undefined,'an unclassified failure is reported, not retried');
  assert.equal(exportRetry(Object.assign(fault('encoder'),{name:'AbortError'}),gpu),undefined);
  // Losing the reader of a bridge (the encoder) is reported as an encoder fault.
  const failures:Error[]=[],bridge=await new RawStreamBridge(error=>failures.push(error)).open();
  const {port}=new URL(bridge.consumerUrl.replace('tcp://','http://'));
  const reader=net.connect(Number(port),'127.0.0.1');await new Promise<void>(resolve=>reader.once('connect',()=>resolve()));
  await new Promise(resolve=>setTimeout(resolve,50));reader.destroy();
  for(let i=0;i<100&&!failures.length;i++)await new Promise(resolve=>setTimeout(resolve,20));
  bridge.close();
  assert.equal(failures.length,1);assert.equal((failures[0] as Error&{exportFault?:string}).exportFault,'encoder');
});
