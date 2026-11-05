import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {probeMedia,createProxy,renderProject,runProcess} from '../electron/media';
import {freezeFrame} from '../electron/freeze-frame';
import {alphaSpatialFilters} from '../electron/alpha-filters';
import {newProject,newClip} from '../shared/project';
import type {MediaAsset,Clip} from '../shared/types';
const root=path.resolve('.test-artifacts/alpha-resampling',Date.now().toString()),ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-filter_threads','2',...args],{timeoutMs:90000,maxOutputBytes:32*1024*1024});
const assets:Record<string,MediaAsset>={};
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const pixels=async(file:string,alpha=false)=>(await ff([...(alpha?['-c:v','libvpx-vp9']:[]),'-i',file,'-frames:v','1','-pix_fmt',alpha?'bgra':'rgb24','-f','rawvideo','pipe:1'])).stdout;
before(async()=>{
 await fs.mkdir(root,{recursive:true});
 for(const name of ['poison','zero']){
  const frame=Buffer.alloc(96*64*4);for(let y=0;y<64;y++)for(let x=0;x<96;x++){const i=(y*96+x)*4,edge=Math.min(x-13,82-x,y-11,52-y),a=edge<0?0:edge===0?32:edge===1?128:255;frame[i]=a?255:name==='poison'?13:0;frame[i+1]=a?255:name==='poison'?233:0;frame[i+2]=a?255:name==='poison'?87:0;frame[i+3]=a;}
  const raw=path.join(root,name+'.bgra'),file=path.join(root,name+'.mov');await fs.writeFile(raw,frame);await ff(['-f','rawvideo','-pix_fmt','bgra','-s','96x64','-r','30','-i',raw,'-vf','loop=loop=5:size=1:start=0','-frames:v','6','-c:v','ffv1','-level','3','-pix_fmt','bgra',file]);assets[name]=await probeMedia(file,ctx,undefined,{derivatives:false});
 }
 await fs.writeFile(path.join(root,'fixtures.json'),JSON.stringify({root,assets},null,2));
});
test('transparent resize, transform, blur and grading ignore hidden RGB and retain bright alpha edges in final exports',{timeout:120000},async()=>{
 const reports=[];
 for(const [label,edit,oracle] of [['resize',{},true],['rotate',{scale:.87,rotation:17,x:.3,y:-.2},true],['blur',{blur:2,scale:.87,rotation:17},true],['grade',{contrast:.9,saturation:.7,scale:.87,rotation:17},false]] as Array<[string,Partial<Clip>,boolean]>){
  const outputs:Buffer[]=[];
  for(const name of ['poison','zero']){const media=assets[name],p=newProject();p.width=160;p.height=120;p.background='#ff0000';p.media=[media];p.clips=[{...newClip('video-1',media),duration:.2,...edit}];const output=path.join(root,`${label}-${name}.mp4`);await renderProject(p,{width:160,height:120,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'high',outputPath:output},ctx);outputs.push(await pixels(output));}
  assert.equal(sha(outputs[0]),sha(outputs[1]),`${label}: hidden RGB changed visible export`);
  let deficit=0;for(let i=0;i<outputs[0].length;i+=3)deficit=Math.max(deficit,255-outputs[0][i]);
  // White foreground over red has R=255 at every alpha. Check this in the
  // actual GIF output (RGB windows), before final video4:2:0 conversion can
  // introduce color ringing. Both formats exercise the full window pipeline.
  let gifDeficit:number|undefined;
  if(oracle){const media=assets.zero,p=newProject();p.width=160;p.height=120;p.background='#ff0000';p.media=[media];p.clips=[{...newClip('video-1',media),duration:.2,...edit}];const output=path.join(root,`${label}-oracle.gif`);await renderProject(p,{width:160,height:120,fps:30,format:'gif',codec:'h264',encoder:'cpu',quality:'high',outputPath:output},ctx);const raw=await pixels(output);gifDeficit=0;for(let i=0;i<raw.length;i+=3)gifDeficit=Math.max(gifDeficit,255-raw[i]);assert.ok(gifDeficit<=6,`${label}: compositor red deficit ${gifDeficit}`);}
  reports.push({label,sha256:sha(outputs[0]),maxRedDeficit:deficit,gifRedDeficit:gifDeficit});
 }
 await fs.writeFile(path.join(root,'export-results.json'),JSON.stringify(reports,null,2));
});
test('transparent proxy normalization is independent of hidden RGB',{timeout:120000},async()=>{
 const proxies=await Promise.all(Object.values(assets).map(media=>createProxy(media,ctx))),raw=await Promise.all(proxies.map(p=>pixels(p.proxyPath!,true)));
 assert.deepEqual(raw[0],raw[1],'hidden colors must not change proxy edge pixels');
 await fs.writeFile(path.join(root,'proxy-results.json'),JSON.stringify({proxies,sha256:sha(raw[0])},null,2));
});

test('thumbnails and non-square-pixel freeze frames retain clean transparent edges',{timeout:120000},async()=>{
 const reports=[];
 for(const kind of ['thumbnail','freeze']){
  const decoded:Buffer[]=[];
  for(const name of ['poison','zero']){
   let result:MediaAsset;
   if(kind==='thumbnail')result=await probeMedia(assets[name].path,ctx);
   else{
    const file=path.join(root,`${name}-sar.mov`);
    await ff(['-i',assets[name].path,'-vf','setsar=3/2','-c:v','ffv1','-level','3','-pix_fmt','bgra',file]);
    const source=await probeMedia(file,ctx,undefined,{derivatives:false});
    result=await freezeFrame(source,.1,{...ctx,derivedDir:path.join(root,'freeze')});
    assert.deepEqual([result.width,result.height],[144,64]);
   }
   const file=kind==='thumbnail'?result.thumbnail:result.path;assert.ok(file);
   decoded.push((await ff(['-i',file,'-frames:v','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout);
  }
  assert.deepEqual(decoded[0],decoded[1],`${kind}: hidden RGB changed visible edge pixels`);
  let maxDeficit=0,foreground=0,partial=0;
  for(let i=0;i<decoded[0].length;i+=4){const a=decoded[0][i+3];maxDeficit=Math.max(maxDeficit,(255-decoded[0][i])*a/255);if(a>0)foreground++;if(a>0&&a<255)partial++;}
  assert.ok(foreground>1000,`${kind}: missing foreground`);assert.ok(partial>100,`${kind}: missing soft alpha edges`);
  assert.ok(maxDeficit<=1,`${kind}: white-over-red composite deficit ${maxDeficit}`);
  reports.push({kind,sha256:sha(decoded[0]),maxDeficit,foreground,partial});
 }
 await fs.writeFile(path.join(root,'derivative-results.json'),JSON.stringify(reports,null,2));
});

test('repeated identity alpha resampling preserves all 256 opacity levels and visible colors',async()=>{
 const raw=Buffer.alloc(256*16*4);
 for(let y=0;y<16;y++)for(let a=0;a<256;a++){const i=(y*256+a)*4;raw[i]=(y*37)%256;raw[i+1]=(y*13+57)%256;raw[i+2]=(y*71+217)%256;raw[i+3]=a;}
 const file=path.join(root,'alpha-ramp.rgba');await fs.writeFile(file,raw);
 const graph=Array.from({length:3},()=>alphaSpatialFilters(['scale=iw:ih:flags=bilinear+accurate_rnd'])).flat().join(',');
 const result=(await ff(['-f','rawvideo','-pix_fmt','rgba','-s','256x16','-i',file,'-vf',graph,'-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout;
 assert.equal(result.length,raw.length);
 for(let i=0;i<raw.length;i+=4){assert.equal(result[i+3],raw[i+3],`opacity at pixel ${i/4}`);if(raw[i+3])for(let c=0;c<3;c++)assert.ok(Math.abs(result[i+c]-raw[i+c])<=1,`visible channel ${i+c}: ${result[i+c]} != ${raw[i+c]}`);}
});

test('RGB GIF streaming preserves moving transparent layers across render windows',{timeout:120000},async()=>{
 const image=path.join(root,'window-source.png');await ff(['-i',assets.zero.path,'-frames:v','1',image]);
 const media=await probeMedia(image,ctx,undefined,{derivatives:false}),p=newProject();p.width=160;p.height=120;p.background='#ff0000';p.media=[media];
 const clip={...newClip('video-1',media),duration:1.3,scale:.6,rotation:17,blur:1};
 clip.keyframes=[{time:0,x:-30,y:0,scale:.6,opacity:1,rotation:17},{time:1.3,x:30,y:0,scale:.6,opacity:1,rotation:17}];p.clips=[clip];
 const decoded:Buffer[]=[];
 for(const windowSize of [.3,6]){
  const outputPath=path.join(root,`window-${windowSize}.gif`),windows:number[]=[];
  await renderProject(p,{width:160,height:120,fps:20,format:'gif',codec:'h264',encoder:'cpu',quality:'high',outputPath},{...ctx,maxWindowSeconds:windowSize,diagnostics:event=>{if(event.event==='window-end')windows.push(Number(event.videoBytes));}});
  assert.equal(windows.at(-1),160*120*3*26,'Producer byte count must match all RGB frames');assert.equal(windows.length,windowSize<1?5:1);
  const raw=(await ff(['-i',outputPath,'-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;assert.equal(raw.length,160*120*3*26);decoded.push(raw);
 }
 assert.deepEqual(decoded[0],decoded[1],'Changing render windows changed GIF frames');
 const centroids=[];for(let frame=0;frame<26;frame++){let sum=0,count=0;for(let pixel=0;pixel<160*120;pixel++){const i=(frame*160*120+pixel)*3;assert.ok(decoded[0][i]>=249,`Dark fringe at frame ${frame}`);if(decoded[0][i+1]>150){sum+=pixel%160;count++;}}assert.ok(count>500,`Foreground missing at frame ${frame}`);centroids.push(sum/count);}
 assert.ok(centroids.at(-1)!-centroids[0]>45,'Movement was lost or frozen');
});
