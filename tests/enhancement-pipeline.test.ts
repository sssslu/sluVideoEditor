import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {NutVideoStream} from '../electron/nut-video';
import {enhanceMedia,type EnhancementContext} from '../electron/enhancement';
import {probeMedia,runProcess,CancelledError} from '../electron/media';
import type {MediaAsset} from '../shared/types';

const root=path.resolve('.test-artifacts/enhancement-pipeline',`${Date.now()}-${process.pid}`),width=32,height=24;
const base={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const ff=(args:string[])=>runProcess(base.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:60000,maxOutputBytes:16*1024*1024});
const probe=async(file:string)=>JSON.parse((await runProcess(base.ffprobe,['-v','error','-show_frames','-show_streams','-show_format','-of','json',file],{timeoutMs:60000})).stdout.toString());
const vfrTimes=[0,33333,66667,1000000,1800001,2500000];
let vfr:MediaAsset,cfr:MediaAsset,negative:MediaAsset,multipleAudio:MediaAsset,alpha:MediaAsset,hdr:MediaAsset;

async function rawSource(name:string,times:number[]){
  const mux=new NutVideoStream(width,height),file=path.join(root,name+'.nut'),handle=await fs.open(file,'wx');
  try{await handle.write(mux.header);for(let n=0;n<times.length;n++){
    const pixels=Buffer.alloc(width*height*4);
    for(let p=0;p<width*height;p++){pixels[p*4]=30+n*11+(p%width)%4;pixels[p*4+1]=110+Math.floor(p/width)%5;pixels[p*4+2]=190-n*7;pixels[p*4+3]=255;}
    for(const part of mux.frame(pixels,times[n]))await handle.write(part);
  }}finally{await handle.close();}
  return file;
}
before(async()=>{
  await fs.mkdir(root,{recursive:true});
  const sparse=await rawSource('vfr',vfrTimes),regular=await rawSource('cfr',Array.from({length:10},(_,n)=>n*100000));
  const opaque=['-fps_mode','passthrough','-enc_time_base:v','1:1000000','-c:v','ffv1','-pix_fmt','bgr0','-video_track_timescale','1000000','-movie_timescale','1000000'];
  const vfrFile=path.join(root,'vfr.mov'),cfrFile=path.join(root,'cfr.mov');
  await ff(['-copyts','-i',sparse,'-itsoffset','0.125','-f','lavfi','-i','aevalsrc=0.1*sin(2*PI*997*t)|0.05*sin(2*PI*701*t):s=48000:d=2.8','-map','0:v:0','-map','1:a:0',...opaque,'-bsf:v',"setts=duration='if(eq(N,5),500000,DURATION)'",'-c:a','pcm_f32le',vfrFile]);
  await ff(['-copyts','-i',regular,'-an',...opaque,'-bsf:v',"setts=duration='if(eq(N,9),100000,DURATION)'",cfrFile]);
  const multiple=path.join(root,'multiple.mov');
  await ff(['-i',vfrFile,'-itsoffset','2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-f','lavfi','-i','sine=frequency=997:sample_rate=48000:duration=3','-map','0:v:0','-map','1:a:0','-map','2:a:0','-c:v','copy','-c:a','pcm_f32le','-video_track_timescale','1000000','-movie_timescale','1000000',multiple]);
  const neg=path.join(root,'negative.ts');
  await ff(['-copyts','-itsoffset','-2','-i',vfrFile,'-map','0:v:0','-map','0:a:0','-fps_mode','passthrough','-c:v','libx264','-preset','ultrafast','-threads','1','-bf','0','-c:a','aac','-avoid_negative_ts','disabled','-mpegts_copyts','1','-muxdelay','0',neg]);
  const transparent=path.join(root,'alpha.mov'),hdrFile=path.join(root,'hdr.mkv');
  await ff(['-i',cfrFile,'-vf','format=bgra,colorchannelmixer=aa=0.5','-c:v','ffv1','-pix_fmt','bgra',transparent]);
  await ff(['-i',cfrFile,'-vf','format=yuv420p10le','-c:v','ffv1','-color_primaries','bt2020','-colorspace','bt2020nc','-color_trc','smpte2084',hdrFile]);
  [vfr,cfr,negative,multipleAudio,alpha,hdr]=await Promise.all([vfrFile,cfrFile,neg,multiple,transparent,hdrFile].map(file=>probeMedia(file,base,undefined,{derivatives:false})));
  assert.equal(vfr.hasAlpha,false);assert.equal(alpha.hasAlpha,true);assert.ok((negative.timing?.origin??0)<0);
});

function context(name:string,onChunk?:(index:number)=>void|Promise<void>){
  const events:Record<string,unknown>[]=[],calls:{input:string|null;count:number;last:boolean}[]=[],inputs:{pts:number;data:Buffer}[]=[];
  let closed=0,created=0;
  const ctx:EnhancementContext={...base,derivedDir:path.join(root,name),diagnostics:event=>events.push(event),createEnhancement:async(config,signal)=>{
    created++;let received=0,emitted=0,finished=false;const pending:{pts:number;data:Buffer}[]=[];
    return {inputCapacity:5,async process(input,pts,last){
      assert.equal(finished,false);assert.ok(pts.length<=5);assert.ok(last||pts.length===5);
      assert.equal(input,pts.length?'input-'+String(received).padStart(9,'0')+'.bgr':null);
      const bytes=input?await fs.readFile(path.join(config.jobDirectory,input)):Buffer.alloc(0);
      assert.equal(bytes.length,pts.length*config.width*config.height*3);
      for(let n=0;n<pts.length;n++){
        const frame={pts:pts[n],data:Buffer.from(bytes.subarray(n*width*height*3,(n+1)*width*height*3))};pending.push(frame);inputs.push(frame);
      }
      received+=pts.length;calls.push({input,count:pts.length,last});await onChunk?.(calls.length);
      if(signal?.aborted)throw new CancelledError();
      const count=last?pending.length:Math.max(0,pending.length-4),outWidth=config.width*config.scale,outHeight=config.height*config.scale,output=Buffer.alloc(count*outWidth*outHeight*4);
      for(let n=0;n<count;n++)for(let y=0;y<outHeight;y++)for(let x=0;x<outWidth;x++){
        const original=(Math.floor(y/config.scale)*config.width+Math.floor(x/config.scale))*3,offset=(n*outWidth*outHeight+y*outWidth+x)*4;
        pending[n].data.copy(output,offset,original,original+3);output[offset+3]=255;
      }
      const outputFile=count?'output-'+String(emitted).padStart(9,'0')+'.bgra':null;
      if(outputFile)await fs.writeFile(path.join(config.jobDirectory,outputFile),output,{flag:'wx'});
      const result={outputFirstFrame:emitted,frameCount:count,pts:pending.splice(0,count).map(frame=>frame.pts),outputFile,bytes:output.length,sha256:count?createHash('sha256').update(output).digest('hex'):null,width:outWidth,height:outHeight,complete:last};
      emitted+=count;finished=last;return result;
    },async close(){closed++;}};
  }};
  return {ctx,events,calls,inputs,get closed(){return closed;},get created(){return created;}};
}
function exited(events:Record<string,unknown>[]){
  for(const event of events)if(['matting-encoder-start','tracking-decoder-start','matting-mux-start'].includes(String(event.event)))assert.throws(()=>process.kill(Number(event.pid),0),{code:'ESRCH'});
}
async function clean(run:ReturnType<typeof context>,expectOutput=false){
  exited(run.events);const files=await fs.readdir(run.ctx.derivedDir!).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error));
  assert.equal(files.length,expectOutput?1:0);assert.ok(files.every(file=>/^enhanced-[\da-f-]+\.mov$/.test(file)));
}
async function exactPixels(output:MediaAsset,inputs:{pts:number;data:Buffer}[],scale:2|4){
  const decoded=(await ff(['-i',output.path,'-map','0:v:0','-fps_mode','passthrough','-pix_fmt','bgra','-f','rawvideo','pipe:1'])).stdout;
  assert.equal(decoded.length,inputs.length*width*height*scale*scale*4);
  for(let n=0;n<inputs.length;n++)for(let y=0;y<height*scale;y++)for(let x=0;x<width*scale;x++){
    const from=(Math.floor(y/scale)*width+Math.floor(x/scale))*3,at=(n*width*height*scale*scale+y*width*scale+x)*4;
    assert.deepEqual(decoded.subarray(at,at+3),inputs[n].data.subarray(from,from+3));assert.equal(decoded[at+3],255);
  }
}

test('2x and4x retain exact opaque pixels, VFR held trim, final duration and delayed PCM audio',{timeout:120000},async()=>{
  for(const scale of [2,4] as const){
    const run=context('vfr-'+scale),output=await enhanceMedia(vfr,{start:.02,duration:2.33,scale},run.ctx),info=await probe(output.path),video=info.frames.filter((frame:any)=>frame.media_type==='video');
    assert.equal(output.hasAlpha,false);assert.equal(output.hasAudio,true);assert.equal(output.width,width*scale);assert.equal(output.height,height*scale);assert.equal(output.duration,2.33);
    const expected=[0,13333,46667,980000,1780001];assert.deepEqual(run.inputs.map(frame=>frame.pts),expected);assert.deepEqual(video.map((frame:any)=>Math.round(Number(frame.best_effort_timestamp_time)*1e6)),expected);assert.equal(video.at(-1).duration,549999);
    assert.deepEqual(run.calls.map(call=>[call.count,call.last]),[[5,false],[0,true]]);assert.equal(run.closed,1);await exactPixels(output,run.inputs,scale);
    const expectedAudio=(await ff(['-copyts','-i',vfr.path,'-map','0:a:0','-af','atrim=start=0.02:end=2.35,asetpts=PTS-round(.02/TB)','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
    const actualAudio=(await ff(['-i',output.path,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;assert.deepEqual(actualAudio,expectedAudio);assert.equal(Number(info.frames.find((frame:any)=>frame.media_type==='audio').best_effort_timestamp_time),.105);
    await clean(run,true);await fs.writeFile(path.join(root,'vfr-'+scale+'.json'),JSON.stringify({output,pts:expected,calls:run.calls,audioBytes:actualAudio.length,events:run.events},null,2));
  }
});

test('exact10 frames use two chunks and an empty final flush without dropping delayed frames',{timeout:60000},async()=>{
  const run=context('ten'),output=await enhanceMedia(cfr,{start:0,duration:1,scale:2},run.ctx);
  assert.deepEqual(run.calls.map(call=>[call.count,call.last]),[[5,false],[5,false],[0,true]]);assert.equal(run.inputs.length,10);assert.equal(output.hasAudio,false);assert.equal(run.closed,1);await exactPixels(output,run.inputs,2);await clean(run,true);
});

test('negative absolute origin preserves normalized video PTS and exact decoded AAC samples',{timeout:60000},async()=>{
  const run=context('negative'),start=.137,duration=1.2,output=await enhanceMedia(negative,{start,duration,scale:2},run.ctx),info=await probe(output.path);
  const at=Math.round(((negative.timing?.origin??0)+start)*1e6)/1e6,end=at+duration;
  const expected=(await ff(['-copyts','-i',negative.path,'-map','0:a:0','-af',`atrim=start=${at}:end=${end},asetpts=PTS-round(${at}/TB)`,'-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
  const actual=(await ff(['-i',output.path,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;assert.ok(expected.length>0);assert.deepEqual(actual,expected);
  assert.deepEqual(info.frames.filter((frame:any)=>frame.media_type==='video').map((frame:any)=>Math.round(Number(frame.best_effort_timestamp_time)*1e6)),run.inputs.map(frame=>frame.pts));assert.equal(run.inputs[0].pts,0);assert.ok(Math.abs(output.duration-duration)<.000002);await exactPixels(output,run.inputs,2);await clean(run,true);
});

test('an empty first audio track retains its ordinal while the second retains all source samples',{timeout:60000},async()=>{
  const run=context('audio-ordinals'),output=await enhanceMedia(multipleAudio,{start:.02,duration:1.1,scale:2},run.ctx),info=await probe(output.path);
  assert.equal(info.streams.filter((stream:any)=>stream.codec_type==='audio').length,2);
  const empty=(await ff(['-i',output.path,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;assert.deepEqual(empty,Buffer.alloc(4));
  const expected=(await ff(['-copyts','-i',multipleAudio.path,'-map','0:a:1','-af','atrim=start=0.02:end=1.12,asetpts=PTS-round(.02/TB)','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
  const actual=(await ff(['-i',output.path,'-map','0:a:1','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;assert.deepEqual(actual,expected);await clean(run,true);
});

test('abort in the second chunk closes encoder/decoder and publishes no derived file',{timeout:60000},async()=>{
  const controller=new AbortController(),run=context('cancel',index=>{if(index===2)controller.abort();});
  await assert.rejects(enhanceMedia(cfr,{start:0,duration:1,scale:2},run.ctx,undefined,controller.signal),{name:'AbortError'});assert.equal(run.closed,1);assert.equal(run.calls.length,2);await clean(run);
});

test('changing the source after an encoded chunk prevents publication and cleans all intermediates',{timeout:60000},async()=>{
  const file=path.join(root,'mutable.mov');await fs.copyFile(cfr.path,file);const source=await probeMedia(file,base,undefined,{derivatives:false});
  const run=context('source-change',async index=>{if(index===2){const stat=await fs.stat(file);await fs.utimes(file,stat.atime,new Date(stat.mtimeMs+1000));}});
  await assert.rejects(enhanceMedia(source,{start:0,duration:1,scale:2},run.ctx),/변경|바뀌/);assert.equal(run.closed,1);await clean(run);
});

test('native encoder death is contained before publishing a partial enhancement',{timeout:60000},async()=>{
  const run=context('encoder-death'),observe=run.ctx.diagnostics;let killed=false;
  run.ctx.diagnostics=event=>{observe?.(event);if(event.event==='matting-encoder-start'){killed=true;process.kill(Number(event.pid));}};
  await assert.rejects(enhanceMedia(cfr,{start:0,duration:1,scale:2},run.ctx));assert.equal(killed,true);assert.equal(run.closed,1);await clean(run);
});

test('transparent, HDR, invalid preview ranges and out-of-source intervals fail before engine creation',{timeout:60000},async()=>{
  const run=context('unsupported');
  await assert.rejects(enhanceMedia(alpha,{start:0,duration:.5,scale:2},run.ctx),/투명/);
  await assert.rejects(enhanceMedia(hdr,{start:0,duration:.5,scale:2},run.ctx),/HDR|SDR/);
  for(const options of [{start:-1,duration:1,scale:2},{start:0,duration:NaN,scale:2},{start:0,duration:3,scale:2,preview:true},{start:.9,duration:1,scale:4}])await assert.rejects(enhanceMedia(cfr,options as Parameters<typeof enhanceMedia>[1],run.ctx));
  assert.equal(run.created,0);assert.equal(run.closed,0);await clean(run);
});
