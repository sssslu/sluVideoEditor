import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createProxy,detectEncoders,enrichMedia,probeMedia,renderProject,runProcess} from '../electron/media';
import {proxyCacheKey,hasLegacyProxyTiming} from '../electron/proxy-cache';
import {changedProjectSources,refreshProjectSources} from '../electron/project-sources';
import {newClip,newProject} from '../shared/project';
import {assertProject} from '../shared/validation';
import type {MediaAsset,ExportSettings} from '../shared/types';

const root=path.resolve('.test-artifacts/media-selection',String(Date.now()));
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:90000});
const source=path.join(root,'blue.mp4'),cover=path.join(root,'red.png'),covered=path.join(root,'cover-first.mp4');
let plain:MediaAsset,media:MediaAsset;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function atoms(bytes:Buffer){
  const result:{type:string;bytes:Buffer;offset:number}[]=[];
  for(let at=0;at<bytes.length;){const size=bytes.readUInt32BE(at);assert.ok(size>=8&&at+size<=bytes.length,'Fixture needs ordinary complete MP4 atoms');result.push({type:bytes.toString('ascii',at+4,at+8),bytes:bytes.subarray(at,at+size),offset:at});at+=size;}
  return result;
}
async function blue(file:string,minimum=220){
  const pixel=(await ff(['-i',file,'-map','0:V:0','-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
  assert.equal(pixel.length,3);assert.ok(pixel[2]>=minimum&&pixel[0]<25&&pixel[1]<25,`${path.basename(file)} selected the wrong picture: ${[...pixel]}`);
}
before(async()=>{
  await fs.mkdir(root,{recursive:true});
  await ff(['-f','lavfi','-i','color=c=blue:s=640x360:r=24:d=1','-f','lavfi','-i','sine=frequency=437:sample_rate=48000:duration=1','-vf','scale=in_color_matrix=bt601:out_color_matrix=bt709:in_range=tv:out_range=tv,format=yuv420p,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709','-c:v','libx264','-preset','ultrafast','-crf','18','-profile:v','high','-pix_fmt','yuv420p','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-color_range','tv','-c:a','aac','-shortest',source]);
  await ff(['-f','lavfi','-i','color=c=red:s=64x64','-frames:v','1','-threads','1',cover]);
  await ff(['-i',source,'-i',cover,'-map','0:v:0','-map','0:a:0','-map','1:v:0','-c','copy','-disposition:v:1','attached_pic',covered]);
  // mov normally writes cover metadata after movie tracks. Put udta first so
  // libavformat encounters the attached picture before the actual video. Atom
  // sizes and absolute chunk offsets do not change; no encoded bytes change.
  const bytes=await fs.readFile(covered),moov=atoms(bytes).find(a=>a.type==='moov')!;assert.ok(moov);
  const children=atoms(moov.bytes.subarray(8)),udta=children.find(a=>a.type==='udta');assert.ok(udta);
  const reordered=Buffer.concat([moov.bytes.subarray(0,8),udta.bytes,...children.filter(a=>a!==udta).map(a=>a.bytes)]);
  assert.equal(reordered.length,moov.bytes.length);reordered.copy(bytes,moov.offset);await fs.writeFile(covered,bytes);
  const info=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-show_streams','-of','json',covered])).stdout.toString());
  const videos=info.streams.filter((s:any)=>s.codec_type==='video');assert.equal(videos.length,2);assert.equal(videos[0].disposition.attached_pic,1);assert.equal(videos[1].codec_name,'h264');
  await fs.writeFile(path.join(root,'source-streams.json'),JSON.stringify(info,null,2));
  assert.deepEqual([videos[1].color_space,videos[1].color_primaries,videos[1].color_transfer,videos[1].color_range],['bt709','bt709','bt709','tv']);
  plain=await probeMedia(source,ctx);media=await probeMedia(covered,ctx);
});

test('cover art before the movie cannot replace thumbnails, proxies or rendered pictures',{timeout:180000},async t=>{
  assert.equal(plain.videoStreamOrdinal,0);assert.equal(media.videoStreamOrdinal,1);assert.deepEqual([media.width,media.height],[640,360]);assert.equal(media.hasAudio,true);
  await blue(media.thumbnail!);const proxy=await createProxy(media,ctx);await blue(proxy.proxyPath!);
  const proxyInfo=await probeMedia(proxy.proxyPath!,ctx,undefined,{derivatives:false});assert.deepEqual([proxyInfo.width,proxyInfo.height],[640,360]);assert.ok(Math.abs(proxyInfo.duration-1)<.01);
  const project=newProject();project.width=640;project.height=360;project.fps=24;project.media=[media];project.clips=[{...newClip('video-1',media),duration:1}];
  const settings=(name:string):ExportSettings=>({outputPath:path.join(root,name),width:640,height:360,fps:24,format:'mp4',codec:'h264',encoder:'cpu',quality:'draft'});
  for(const opacity of [1,.7]){project.clips[0]={...project.clips[0],opacity};const output=settings(`render-${opacity}.mp4`);await renderProject(project,output,{...ctx,gpuProcessing:false});await blue(output.outputPath!,opacity===1?220:145);}
  if((await detectEncoders(ctx)).includes('h264_nvenc')){
    project.clips[0]={...project.clips[0],opacity:1};const events:Record<string,unknown>[]=[],output={...settings('gpu.mp4'),encoder:'nvenc' as const};
    await renderProject(project,output,{...ctx,diagnostics:event=>events.push(event)});await blue(output.outputPath!);
    await fs.writeFile(path.join(root,'gpu-events.json'),JSON.stringify(events,null,2));
    assert.ok(events.some(e=>e.event==='gpu-processing'&&e.backend==='cuda-direct'),'Eligible H264/BT709 fixture must exercise the CUDA direct source selector');
    t.diagnostic('CUDA direct source selector exercised: true');
  }
});

test('source selection migration retains normal and external proxies, and only discards the old cover proxy',{timeout:120000},async()=>{
  const ordinaryProxy=await createProxy(plain,ctx),ordinaryBytes=await fs.readFile(ordinaryProxy.proxyPath!);
  const legacy={...media,name:'My covered clip',videoStreamOrdinal:undefined},legacyPath=path.join(ctx.cacheDir,`${proxyCacheKey(legacy)}-color-proxy.mp4`),externalPath=path.join(root,'user-color-proxy.mp4');
  const sentinel=Buffer.from('Existing proxy bytes must remain untouched');await fs.writeFile(legacyPath,sentinel);await fs.writeFile(externalPath,sentinel);
  const oldCover={...legacy,proxyPath:legacyPath,thumbnail:cover},oldPlain={...ordinaryProxy,videoStreamOrdinal:undefined},external={...oldCover,id:'external',proxyPath:externalPath};
  // Simulate a metadata cache written before source stream selection was kept.
  for(const file of await fs.readdir(ctx.cacheDir)){if(!file.endsWith('.json'))continue;const target=path.join(ctx.cacheDir,file),saved=JSON.parse(await fs.readFile(target,'utf8'));if(saved.path===covered&&saved.thumbnail){delete saved.videoStreamOrdinal;await fs.writeFile(target,JSON.stringify(saved));}}
  const project=newProject();project.media=[oldPlain,oldCover,external];project.clips=project.media.map((m,i)=>newClip('video-1',m,i*2));const snapshot=JSON.stringify(project);assert.doesNotThrow(()=>assertProject(project));
  const changed=await changedProjectSources(project);assert.deepEqual([...changed].sort(),[source,covered].sort());const result=await refreshProjectSources(project,changed,ctx);
  assert.equal(result.changedSources,0);assert.equal(result.project.media[0].proxyPath,ordinaryProxy.proxyPath);assert.equal(result.project.media[1].proxyPath,undefined);assert.equal(result.project.media[1].thumbnail,undefined);assert.equal(result.project.media[2].proxyPath,externalPath);
  assert.deepEqual(result.project.media.map(m=>m.videoStreamOrdinal),[0,1,1]);assert.deepEqual(result.project.clips,project.clips);assert.equal(JSON.stringify(project),snapshot);
  assert.equal((await enrichMedia(oldCover,ctx)).proxyPath,undefined);assert.equal((await enrichMedia(external,ctx)).proxyPath,externalPath);
  assert.equal(proxyCacheKey(oldPlain),proxyCacheKey(ordinaryProxy));assert.notEqual(proxyCacheKey(oldCover),proxyCacheKey(media));assert.equal(hasLegacyProxyTiming({...oldCover,videoStreamOrdinal:1}),true);
  assert.equal(digest(await fs.readFile(ordinaryProxy.proxyPath!)),digest(ordinaryBytes));assert.ok((await fs.readFile(legacyPath)).equals(sentinel));assert.ok((await fs.readFile(externalPath)).equals(sentinel));
});

test('a cached waveform failure retries on analysis while metadata-only reads stay cheap',async()=>{
  let erased=0;
  for(const file of await fs.readdir(ctx.cacheDir)){if(!file.endsWith('.json'))continue;const target=path.join(ctx.cacheDir,file),saved=JSON.parse(await fs.readFile(target,'utf8'));if(saved.path===source&&saved.thumbnail){delete saved.waveform;await fs.writeFile(target,JSON.stringify(saved));erased++;}}
  assert.equal(erased,1);const metadata=await probeMedia(source,ctx,undefined,{derivatives:false});assert.equal(metadata.waveform,undefined);
  const refreshed=await probeMedia(source,ctx);assert.equal(refreshed.waveform?.length,320);assert.ok(refreshed.waveform!.some(value=>value>.1));
});
