import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {NutVideoStream} from '../electron/nut-video';
import {removePersonBackground,type PersonCutoutContext} from '../electron/matting';
import {probeMedia,createProxy,runProcess} from '../electron/media';
import type {MediaAsset} from '../shared/types';

// Keep artifacts from interrupted runs for diagnosis. Cleanup assertions apply
// to this invocation's directories, including every failed/cancelled operation.
const root=path.resolve('.test-artifacts/matting-pipeline',`${Date.now()}-${process.pid}`),times=[0,33333,66667,1000000,1800001,2500000],width=160,height=90;
const base={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const ff=(args:string[])=>runProcess(base.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:30000});
const probe=async(file:string)=>JSON.parse((await runProcess(base.ffprobe,['-v','error','-show_frames','-show_streams','-show_format','-of','json',file],{timeoutMs:30000})).stdout.toString());
let media:MediaAsset;
before(async()=>{
 await fs.mkdir(root,{recursive:true});const mux=new NutVideoStream(width,height),file=await fs.open(path.join(root,'input.nut'),'w');
 try{await file.write(mux.header);for(let i=0;i<times.length;i++){
  const pixels=Buffer.alloc(width*height*4);for(let p=0;p<width*height;p++){pixels[p*4]=40+i*17;pixels[p*4+1]=120;pixels[p*4+2]=200-i*13;pixels[p*4+3]=255;}
  for(const part of mux.frame(pixels,times[i]))await file.write(part);
 }}finally{await file.close();}
 const source=path.join(root,'source.mov');
 await ff(['-copyts','-i',path.join(root,'input.nut'),'-itsoffset','0.125','-f','lavfi','-i','aevalsrc=0.1*sin(2*PI*997*t)|0.05*sin(2*PI*701*t):s=48000:d=2.8','-map','0:v:0','-map','1:a:0','-fps_mode','passthrough','-enc_time_base:v','1:1000000','-c:v','ffv1','-pix_fmt','bgr0','-bsf:v',"setts=duration='if(eq(N,5),500000,DURATION)'",'-c:a','pcm_f32le','-video_track_timescale','1000000','-movie_timescale','1000000',source]);
 media=await probeMedia(source,base,undefined,{derivatives:false});assert.equal(media.hasAlpha,false);
});
function context(name:string,onFrame?:(n:number)=>void|Promise<void>){
 let count=0,closed=0;const diagnostics:Record<string,unknown>[]=[],pts:number[]=[];
 const ctx:PersonCutoutContext={...base,derivedDir:path.join(root,name),diagnostics:e=>diagnostics.push(e),createMatting:async()=>({backend:'cpu',async process(frame,time){
  pts.push(time);const out=new Uint8Array(frame.width*frame.height*4);
  for(let p=0;p<frame.width*frame.height;p++){out.set(frame.data.subarray(p*3,p*3+3),p*4);out[p*4+3]=(p%frame.width)<50?0:(p%frame.width)<100?128:(p%frame.width)<120?1:(p%frame.width)<140?254:255;}
  await onFrame?.(++count);return {width:frame.width,height:frame.height,pts:time,backend:'cpu',data:out};
 },async close(){closed++;}})};
 return {ctx,diagnostics,pts,get closed(){return closed;}};
}
const assertExited=(events:Record<string,unknown>[])=>{for(const event of events)if(event.event==='matting-encoder-start'||event.event==='tracking-decoder-start'||event.event==='matting-mux-start')assert.throws(()=>process.kill(Number(event.pid),0),{code:'ESRCH'});};

test('cutout preserves held VFR frames, every visible BGRA byte including alpha1, exact final duration and delayed audio; invisible RGB is zero',async()=>{
 const run=context('complete'),options={start:.02,duration:2.33},output=await removePersonBackground(media,options,run.ctx);
 assert.equal(output.hasAlpha,true);assert.equal(output.hasAudio,true);assert.equal(run.closed,1);assert.deepEqual(run.pts,times.slice(0,5));
 const info=await probe(output.path),video=info.frames.filter((f:any)=>f.media_type==='video');
 assert.deepEqual(video.map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*1e6)),[0,13333,46667,980000,1780001]);assert.equal(video[4].duration,549999);assert.equal(output.duration,2.33);
 const decoded=(await ff(['-i',output.path,'-map','0:v:0','-fps_mode','passthrough','-pix_fmt','bgra','-f','rawvideo','pipe:1'])).stdout;
 assert.equal(decoded.length,5*width*height*4);
 for(let i=0;i<5;i++)for(let p=0;p<width*height;p++){const x=p%width;assert.deepEqual([...decoded.subarray((i*width*height+p)*4,(i*width*height+p)*4+4)],x<50?[0,0,0,0]:[40+i*17,120,200-i*13,x<100?128:x<120?1:x<140?254:255]);}
 const expected=(await ff(['-copyts','-i',media.path,'-map','0:a:0','-af','atrim=start=0.02:end=2.35,asetpts=PTS-round(.02/TB)','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
 const actual=(await ff(['-i',output.path,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;assert.deepEqual(actual,expected);
 const firstAudio=info.frames.find((f:any)=>f.media_type==='audio');assert.equal(Number(firstAudio.best_effort_timestamp_time),.105);
 const proxy=await createProxy(output,run.ctx),alpha=(await ff(['-c:v','libvpx-vp9','-i',proxy.proxyPath!,'-frames:v','1','-vf','alphaextract','-f','rawvideo','pipe:1'])).stdout;
 for(const [x,wanted] of [[25,0],[75,128],[110,1],[130,254],[155,255]])assert.ok(Math.abs(alpha[45*width+x]-wanted)<=2);
 assertExited(run.diagnostics);assert.equal((await fs.readdir(run.ctx.derivedDir!)).filter(n=>n.startsWith('.cutout-')).length,0);
 await fs.writeFile(path.join(root,'result.json'),JSON.stringify({options,source:media,output,proxy,pts:video.map((f:any)=>f.best_effort_timestamp_time),audioBytes:actual.length,firstAudio:firstAudio.best_effort_timestamp_time},null,2));
});

test('cancelling a partially encoded sequence closes native resources and publishes no file',async()=>{
 const control=new AbortController(),run=context('cancel',n=>{if(n===2)control.abort();});
 await assert.rejects(removePersonBackground(media,{start:0,duration:2},run.ctx,undefined,control.signal),{name:'AbortError'});assert.equal(run.closed,1);
 assert.deepEqual(await fs.readdir(run.ctx.derivedDir!),[]);assertExited(run.diagnostics);
});

test('source replacement during processing prevents publication and cleans its temporary output',async()=>{
 const copy=path.join(root,'mutable.mov');await fs.copyFile(media.path,copy);const input=await probeMedia(copy,base,undefined,{derivatives:false});
 const run=context('source-changed',async n=>{if(n===2){const stat=await fs.stat(copy);await fs.utimes(copy,stat.atime,new Date(stat.mtimeMs+1000));}});
 await assert.rejects(removePersonBackground(input,{start:0,duration:2},run.ctx),/변경|바뀌/);assert.equal(run.closed,1);assert.deepEqual(await fs.readdir(run.ctx.derivedDir!),[]);assertExited(run.diagnostics);
});

test('early encoder death is contained and cannot leave a partial derived video',async()=>{
 const run=context('encoder-died');let killed=false;const observe=run.ctx.diagnostics;
 run.ctx.diagnostics=e=>{observe?.(e);if(e.event==='matting-encoder-start'){killed=true;process.kill(Number(e.pid));}};
 await assert.rejects(removePersonBackground(media,{start:0,duration:2},run.ctx));assert.equal(killed,true);assert.equal(run.closed,1);assert.deepEqual(await fs.readdir(run.ctx.derivedDir!),[]);assertExited(run.diagnostics);
});

test('range and unsupported transparent inputs fail before creating a derived file',async()=>{
 const run=context('invalid');for(const options of [{start:-1,duration:1},{start:0,duration:NaN},{start:2,duration:2}])await assert.rejects(removePersonBackground(media,options,run.ctx));
 const info=JSON.parse(await fs.readFile(path.join(root,'result.json'),'utf8'));await assert.rejects(removePersonBackground(info.output,{start:0,duration:1},run.ctx),/투명도/);
 assert.equal(run.closed,0);assert.equal(await fs.stat(run.ctx.derivedDir!).then(()=>true,()=>false),false);
});
