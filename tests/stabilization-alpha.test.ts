import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,utimesSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {NutVideoStream} from '../electron/nut-video';
import {stabilizeMedia} from '../electron/stabilization';
import {shareAlphaTransforms} from '../electron/stabilization-alpha';
import {probeMedia,runProcess} from '../electron/media';
import type {MediaAsset} from '../shared/types';

const root=path.resolve('.test-artifacts/stabilization-alpha',Date.now().toString()),width=256,height=192,stride=width*height*4;
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),derivedDir:path.join(root,'derived')};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-filter_threads','2',...args],{timeoutMs:90000,maxOutputBytes:64*1024*1024});
const probe=async(file:string,args:string[]=[])=>JSON.parse((await runProcess(ctx.ffprobe,['-v','error',...args,'-of','json',file])).stdout.toString());
const raw=async(file:string)=>(await ff(['-i',file,'-map','0:v:0','-fps_mode','passthrough','-pix_fmt','bgra','-f','rawvideo','pipe:1'])).stdout;
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const pts=Array.from({length:40},(_,i)=>i*50000+(i>=12?150000:0)+(i>=24?200000:0));
const total=pts.at(-1)!+100000;
let source:MediaAsset,poison:MediaAsset,original:Buffer;
function frame(index:number,hidden:number){
  const data=Buffer.alloc(stride),dx=Math.round(8*Math.sin(index*2.1)+3*Math.sin(index*.73)),dy=Math.round(7*Math.cos(index*1.61)+2*Math.sin(index*.91));
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const sx=x-dx,sy=y-dy,at=(y*width+x)*4,edge=Math.min(sx-24,231-sx,sy-24,167-sy);
    if(edge<=0){data[at]=(hidden+x*13+index*41)%256;data[at+1]=(hidden+y*19)%256;data[at+2]=(hidden+index*37)%256;continue;}
    let seed=(Math.imul(sx,19349663)^Math.imul(sy,73856093))>>>0;seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const alpha=Math.round(Math.min(1,edge/10)*(sx%17<3||sy%13<3?255:65+(seed>>>24)%150));
    const marker=(Math.abs(sx-width/2)<3&&Math.abs(sy-height/2)<15)||(Math.abs(sx-width/2)<15&&Math.abs(sy-height/2)<3);
    data[at]=data[at+1]=marker?0:255;data[at+2]=255;data[at+3]=marker?255:alpha;
  }return data;
}
function positions(data:Buffer){
  const points=[];for(let f=0;f<data.length/stride;f++){let xSum=0,ySum=0,count=0;for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=f*stride+(y*width+x)*4;if(data[at]<50&&data[at+1]<50&&data[at+2]>200&&data[at+3]>200){xSum+=x;ySum+=y;count++;}}assert.ok(count>100);points.push({x:xSum/count,y:ySum/count});}
  const mx=points.reduce((s,p)=>s+p.x,0)/points.length,my=points.reduce((s,p)=>s+p.y,0)/points.length;
  return {points,variance:points.reduce((s,p)=>s+(p.x-mx)**2+(p.y-my)**2,0)/points.length};
}
before(async()=>{
  await fs.mkdir(root,{recursive:true});
  for(const [name,hidden] of [['source',17],['poison',203]] as const){
    const mux=new NutVideoStream(width,height),input=path.join(root,name+'.nut'),output=path.join(root,name+'.mov');
    const frames=pts.map((_,i)=>frame(i,hidden));if(name==='source')original=Buffer.concat(frames);
    await fs.writeFile(input,Buffer.concat([mux.header,...frames.flatMap((data,i)=>[...mux.frame(data,pts[i])])]));
    await ff(['-f','nut','-i',input,'-f','lavfi','-i',`aevalsrc=0.1*sin(2*PI*431*t)|0.05*cos(2*PI*719*t):s=48000:d=${total/1e6}`,'-map','0:v:0','-map','1:a:0','-fps_mode','passthrough','-enc_time_base:v','1:1000000','-c:v','ffv1','-level','3','-pix_fmt','bgra','-c:a','pcm_f32le','-bsf:v',`setts=duration='if(eq(N,39),100000,DURATION)'`,'-video_track_timescale','1000000','-movie_timescale','1000000',output]);
    const asset=await probeMedia(output,ctx,undefined,{derivatives:false});if(name==='source')source=asset;else poison=asset;
  }
});

test('alpha stabilization reduces measured shake, aligns color and alpha, ignores hidden RGB, and preserves VFR/PCM/selected duration',{timeout:120000},async()=>{
  const start=.137,duration=1.731,indices=pts.flatMap((t,i)=>i>=2&&t<(start+duration)*1e6?[i]:[]),before=positions(Buffer.concat(indices.map(i=>original.subarray(i*stride,(i+1)*stride))));
  const options={start,duration,smoothing:12,accuracy:15,crop:'black' as const},sourceHash=hash(await fs.readFile(source.path));
  const output=await stabilizeMedia(source,options,ctx),data=await raw(output.path),after=positions(data);
  assert.equal(output.hasAlpha,true);assert.equal(output.hasAudio,true);assert.equal(output.width,width);assert.equal(output.height,height);
  assert.ok(Math.abs(output.duration-duration)<1e-6);assert.equal(data.length,indices.length*stride);
  assert.ok(after.variance<before.variance*.2,`${before.variance} -> ${after.variance}`);
  let zero=0,soft=0,maxCompositeError=0;
  // Every visible source pixel has R=255, so red composited over any backdrop
  // has the independent oracle A + backdrop*(1-A). Compare visible error:
  // unpremultiplication amplifies one-byte rounding at tiny alpha values.
  for(let at=0;at<data.length;at+=4){const a=data[at+3];if(a===0)zero++;else{if(a<255)soft++;maxCompositeError=Math.max(maxCompositeError,Math.abs(a-data[at+2]*a/255));assert.equal(data[at],data[at+1],'identical foreground channels must remain aligned');}}
  assert.ok(zero>data.length/4*.1);assert.ok(soft>data.length/4*.2);assert.ok(maxCompositeError<=2,`RGB/alpha composite misalignment: ${maxCompositeError}`);
  const changedHidden=await stabilizeMedia(poison,options,ctx);assert.deepEqual(await raw(changedHidden.path),data,'RGB hidden under alpha=0 must not affect motion detection or edge colors');
  const report=await probe(output.path,['-show_frames','-show_streams']);
  assert.deepEqual(report.frames.filter((f:any)=>f.media_type==='video').map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*1e6)),indices.map(i=>Math.max(0,pts[i]-start*1e6)));
  const full=(await ff(['-i',source.path,'-map','0:a:0','-f','f32le','pipe:1'])).stdout,expected=full.subarray(Math.round(start*48000)*8,Math.round((start+duration)*48000)*8),actual=(await ff(['-i',output.path,'-map','0:a:0','-f','f32le','pipe:1'])).stdout;
  assert.deepEqual(actual,expected);assert.equal(hash(await fs.readFile(source.path)),sourceHash);
  await ff(['-i',output.path,'-vf','format=rgba','-frames:v','1',path.join(root,'after.png')]);
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({root,source,output,frames:indices.length,varianceBefore:before.variance,varianceAfter:after.variance,maxCompositeError,transparentPixels:zero,softPixels:soft,exactAudioBytes:actual.length,sourceUnchanged:true,hiddenRgbInvariant:true},null,2));
});

test('transparent stabilization cancels analysis, fit and render without leaving child processes or derived files',{timeout:120000},async()=>{
  await fs.mkdir(ctx.derivedDir,{recursive:true});const existing=(await fs.readdir(ctx.derivedDir)).sort();
  for(const phase of ['analyze','fit','transform']){
    const control=new AbortController(),pids:number[]=[];let reached=false;
    await assert.rejects(stabilizeMedia(source,{duration:1},{...ctx,diagnostics:event=>{if(typeof event.pid==='number')pids.push(event.pid);if(event.phase===phase){reached=true;control.abort();}}},undefined,control.signal),{name:'AbortError'});
    assert.equal(reached,true);for(const pid of pids)assert.throws(()=>process.kill(pid,0));assert.deepEqual((await fs.readdir(ctx.derivedDir)).sort(),existing);
  }
});

test('alpha identity preserves arbitrary translucent colors; square-pixel conversion, rotation and WebM alpha remain usable',{timeout:120000},async()=>{
  const identityData=Buffer.alloc(stride);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=(y*width+x)*4;identityData[at]=(x*7+y*11)%256;identityData[at+1]=(x*17+y*3)%256;identityData[at+2]=(x*23+y*5)%256;identityData[at+3]=x;}
  const input=path.join(root,'colors.bgra'),file=path.join(root,'colors.mov');await fs.writeFile(input,identityData);
  await ff(['-f','rawvideo','-pix_fmt','bgra','-s',`${width}x${height}`,'-r','10','-i',input,'-vf','loop=loop=3:size=1:start=0','-frames:v','4','-c:v','ffv1','-level','3','-pix_fmt','bgra',file]);
  const output=await stabilizeMedia(await probeMedia(file,ctx,undefined,{derivatives:false}),{smoothing:0,crop:'black',zoom:0},ctx),decoded=await raw(output.path);
  let maximum=0;for(let at=0;at<stride;at+=4){assert.equal(decoded[at+3],identityData[at+3]);for(let c=0;c<3;c++)maximum=Math.max(maximum,Math.abs(decoded[at+c]-identityData[at+c])*identityData[at+3]/255);}
  assert.ok(maximum<=1.5,`identity composite error ${maximum}`);
  const results=[];
  for(const [name,args,w,h] of [
    ['sar',['-vf','setsar=3/2','-c:v','ffv1','-pix_fmt','bgra'],384,192],
    ['rotated',['-c:v','copy'],192,256],
    ['vp9',['-vf','format=yuva420p','-c:v','libvpx-vp9','-lossless','1','-pix_fmt','yuva420p','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-color_range','tv'],256,192]
  ] as const){
    const variant=path.join(root,`${name}.${name==='vp9'?'webm':'mov'}`);await ff([...(name==='rotated'?['-display_rotation:v:0','90']:[]),'-i',source.path,'-an',...args,variant]);
    const media=await probeMedia(variant,ctx,undefined,{derivatives:false});assert.equal(media.hasAlpha,true,name);
    if(name==='rotated')assert.deepEqual([media.width,media.height],[192,256],'fixture must contain an actual display matrix');
    const processed=await stabilizeMedia(media,{start:0,duration:.8,smoothing:0,crop:'black'},ctx);assert.equal(processed.width,w,name);assert.equal(processed.height,h,name);assert.equal(processed.hasAlpha,true,name);
    const data=(await ff(['-i',processed.path,'-frames:v','1','-pix_fmt','bgra','-f','rawvideo','pipe:1'])).stdout;
    let transparent=0,soft=0;for(let i=3;i<data.length;i+=4){if(!data[i])transparent++;if(data[i]>0&&data[i]<255)soft++;}assert.ok(transparent>w*h*.2,name);assert.ok(soft>w*h*.2,name);
    const points=await probe(processed.path,['-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time']);assert.deepEqual(points.frames.map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*1e6)),pts.filter(t=>t<800000));
    if(name==='vp9'){
      const expected=(await ff(['-c:v','libvpx-vp9','-i',variant,'-vf','scale=iw:ih:flags=bilinear+full_chroma_int+accurate_rnd:in_color_matrix=bt709:in_range=tv:out_range=pc','-frames:v','1','-pix_fmt','bgra','-f','rawvideo','pipe:1'])).stdout;
      let max=0;for(let i=0;i<data.length;i+=4){assert.equal(data[i+3],expected[i+3]);for(let c=0;c<3;c++)max=Math.max(max,Math.abs(data[i+c]-expected[i+c])*expected[i+3]/255);}assert.ok(max<=1.5,`WebM composite color error ${max}`);
    }
    results.push({name,processed,transparent,soft});
  }
  await fs.writeFile(path.join(root,'format-results.json'),JSON.stringify({identityMaximumCompositeError:maximum,results},null,2));
});

test('transparent stabilization retains delayed starts and exact AAC samples when seeking, and refuses a changed source',{timeout:120000},async()=>{
  const reports=[];
  for(const name of ['aac-shifted','video-delayed']){
    const file=path.join(root,`${name}.mov`);
    if(name==='aac-shifted')await ff(['-itsoffset','2','-i',source.path,'-c:v','copy','-c:a','aac','-avoid_negative_ts','disabled',file]);
    else await ff(['-itsoffset','0.25','-i',source.path,'-i',source.path,'-map','0:v:0','-map','1:a:0','-c','copy','-avoid_negative_ts','disabled',file]);
    const media=await probeMedia(file,ctx,undefined,{derivatives:false}),start=name==='aac-shifted'?1.337:.137,duration=.731;
    const at=Math.round((media.timing!.origin+start)*1e6),until=at+Math.round(duration*1e6);
    const streamInfo=await probe(file,['-show_frames','-show_streams']),videoTimes=streamInfo.frames.filter((f:any)=>f.media_type==='video').map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*1e6)) as number[];
    const first=videoTimes.reduce((last,t,i)=>t<=at?i:last,0),selected=videoTimes.filter((t,i)=>i>=first&&t<until),output=await stabilizeMedia(media,{start,duration,smoothing:0,crop:'black'},ctx);
    const outputInfo=await probe(output.path,['-show_frames','-show_streams']);assert.deepEqual(outputInfo.frames.filter((f:any)=>f.media_type==='video').map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*1e6)),selected.map(t=>Math.max(0,t-at)));
    const firstAudio=streamInfo.frames.find((f:any)=>f.media_type==='audio'),audioOrigin=Number(firstAudio.best_effort_timestamp_time),full=(await ff(['-i',file,'-map','0:a:0','-f','f32le','pipe:1'])).stdout;
    const expected=full.subarray(Math.max(0,Math.round((at/1e6-audioOrigin)*48000))*8,Math.round((until/1e6-audioOrigin)*48000)*8),actual=(await ff(['-i',output.path,'-map','0:a:0','-f','f32le','pipe:1'])).stdout;
    assert.deepEqual(actual,expected,name);assert.ok(Math.abs(output.duration-duration)<1e-6,name);reports.push({name,media,output,exactAudioBytes:actual.length});
  }
  const changed=path.join(root,'changed.mov');await fs.copyFile(source.path,changed);const media=await probeMedia(changed,ctx,undefined,{derivatives:false}),existing=(await fs.readdir(ctx.derivedDir)).sort(),pids:number[]=[];let mutated=false;
  await assert.rejects(stabilizeMedia(media,{duration:1},{...ctx,diagnostics:event=>{if(typeof event.pid==='number')pids.push(event.pid);if(event.phase==='fit'){mutated=true;const future=new Date(Date.now()+10000);utimesSync(changed,future,future);}}}),/변경|원본/);
  assert.equal(mutated,true);for(const pid of pids)assert.throws(()=>process.kill(pid,0));assert.deepEqual((await fs.readdir(ctx.derivedDir)).sort(),existing);
  await fs.writeFile(path.join(root,'clock-results.json'),JSON.stringify({reports,changedSourceRejected:true},null,2));
});

test('shared alpha motion records reject truncation/nonfinite values and convert fitted zoom to rigid transforms',async()=>{
  const input=path.join(root,'debug.trf'),target=path.join(root,'rigid.trf');
  await fs.writeFile(input,'# no fields\n0 0 0 0 0 1\n0 1.25 -2.5 .001 -8.2 0\n');
  assert.equal(await shareAlphaTransforms(input,target),2);assert.equal(await fs.readFile(target,'utf8'),'1 0 0 0 0 1\n2 1.25 -2.5 0.001 0 0\n');
  for(const [i,bad] of ['0 1 2 3 4','0 NaN 2 3 4 0','0 1 2 Infinity 4 0','0 1 2 3 4 99','x'.repeat(100000),'# no records\n'].entries()){
    await fs.writeFile(input,bad);await assert.rejects(shareAlphaTransforms(input,path.join(root,`bad-${i}.trf`)));
  }
  const controller=new AbortController();controller.abort();await assert.rejects(shareAlphaTransforms(input,path.join(root,'cancelled.trf'),controller.signal),{name:'AbortError'});
});
