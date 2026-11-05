import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {probeMedia,createProxy,enrichMedia,renderProject,runProcess,THUMBNAIL_SUFFIX} from '../electron/media';
import {freezeFrame} from '../electron/freeze-frame';
import {previewColorPrefix,previewVideoColor} from '../electron/video-color';
import {changedProjectSources,refreshProjectSources} from '../electron/project-sources';
import {previewProxyPath} from '../shared/media-clock';
import {mergeAsset} from '../src/editor';
import {prepareColorFixtures,colorReference,patchSamples,type ColorFixture} from './fixtures/color-range';

const root=path.resolve('.test-artifacts/color-range'),ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false};
let cases:ColorFixture[];const reports:{name:string;reference:Awaited<ReturnType<typeof colorReference>>;exports:unknown[];proxy?:unknown;thumbnail?:unknown;freeze?:unknown}[]=[];
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:120000,maxOutputBytes:32*1024*1024});
const info=async(file:string)=>JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-show_streams','-of','json',file])).stdout.toString()).streams[0];
const rgba=async(file:string)=>(await ff(['-i',file,'-frames:v','1','-vf','scale=flags=bilinear+full_chroma_int+accurate_rnd','-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout;
const near=(a:number[][],b:number[][],tolerance:number,label:string)=>{for(let i=0;i<b.length;i++)for(let c=0;c<b[i].length;c++)assert.ok(Math.abs(a[i][c]-b[i][c])<=tolerance,`${label} patch${i} channel${c}: ${a[i][c]} vs ${b[i][c]}`);};
before(async()=>{cases=await prepareColorFixtures(root,ctx);for(const row of cases)reports.push({name:row.spec.name,reference:await colorReference(row,ctx),exports:[]});});

test('Actual partial/complete SDR stream tags select the native decoder range; YUVJ relabelling leaves every plane byte unchanged',async()=>{
  for(const {spec,info:stream,media} of cases){assert.equal(stream.color_space,'bt709');assert.equal(stream.color_range,spec.range);assert.equal(stream.color_primaries==='bt709',spec.complete);assert.equal(stream.color_transfer==='bt709',spec.complete);assert.deepEqual(previewVideoColor(stream),{matrix:spec.matrix,range:spec.previewRange});
    const prefix=previewColorPrefix(stream);if(spec.range==='pc'&&spec.previewRange==='tv'){assert.ok(prefix);const original=(await ff(['-i',media.path,'-frames:v','1','-pix_fmt',stream.pix_fmt,'-f','rawvideo','pipe:1'])).stdout,relabeled=(await ff(['-i',media.path,'-vf',prefix.slice(0,-1),'-frames:v','1','-pix_fmt','yuv420p','-f','rawvideo','pipe:1'])).stdout;assert.deepEqual(relabeled,original,spec.name);}else assert.equal(prefix,'');
  }
});

test('Software exports match an independent YUV matrix/range reference at full and half opacity in every output frame',{timeout:180000},async()=>{
  for(const [index,row] of cases.entries())for(const opacity of [1,.5]){const p={...row.project,clips:row.project.clips.map(c=>({...c,opacity}))},output=path.join(root,`${row.spec.name}-${opacity}-software.mp4`),events:unknown[]=[];await renderProject(p,{width:p.width,height:p.height,fps:p.fps,format:'mp4',codec:'h264',encoder:'cpu',quality:'high',outputPath:output},{...ctx,diagnostics:e=>events.push(e)});
    const raw=(await ff(['-i',output,'-fps_mode','passthrough','-vf','scale=flags=bilinear+full_chroma_int+accurate_rnd:in_color_matrix=bt709:in_range=tv:out_range=pc','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout,bytes=p.width*p.height*3,count=raw.length/bytes,reference=reports[index].reference.map(s=>s.rgb.map((v,c)=>v*opacity+[20,40,60][c]*(1-opacity)));assert.equal(count,24);
    for(let f=0;f<count;f++)near(patchSamples(raw,p.width,p.height,3,f*bytes),reference,5,`${row.spec.name} opacity${opacity} frame${f}`);
    assert.ok(!events.some((e:any)=>e.event==='gpu-processing'));reports[index].exports.push({opacity,frames:count,samples:patchSamples(raw,p.width,p.height,3),reference,output});
  }
});

test('Generated proxies, PNG thumbnails and original-resolution freeze frames preserve source color; HD proxies remain709 below720 lines',{timeout:180000},async()=>{
  for(const [index,row] of cases.entries()){const expected=reports[index].reference.map(s=>s.rgb),thumb=row.media.thumbnail!;assert.ok(thumb?.endsWith(THUMBNAIL_SUFFIX));const thumbInfo=await info(thumb),thumbSamples=patchSamples(await rgba(thumb),thumbInfo.width,thumbInfo.height);near(thumbSamples,expected,2,`${row.spec.name} thumbnail`);assert.equal(thumbInfo.color_transfer,'iec61966-2-1');
    const proxy=await createProxy(row.media,ctx),proxyInfo=await info(proxy.proxyPath!),proxySamples=patchSamples(await rgba(proxy.proxyPath!),proxyInfo.width,proxyInfo.height);assert.ok(proxy.proxyPath?.endsWith('-color-proxy.mp4'));assert.equal(previewProxyPath(proxy),proxy.proxyPath);for(const field of ['color_space','color_primaries','color_transfer'])assert.equal(proxyInfo[field],'bt709');assert.equal(proxyInfo.color_range,'tv');near(proxySamples,expected,5,`${row.spec.name} proxy`);if(row.spec.width===1600)assert.equal(proxyInfo.height,600);assert.equal((await createProxy(row.media,ctx)).proxyPath,proxy.proxyPath);
    const freeze=await freezeFrame(row.media,.2,ctx),freezeInfo=await info(freeze.path),freezeSamples=patchSamples(await rgba(freeze.path),freezeInfo.width,freezeInfo.height);assert.equal(freezeInfo.width,row.spec.width);assert.equal(freezeInfo.height,row.spec.height);near(freezeSamples,expected,2,`${row.spec.name} freeze`);
    Object.assign(reports[index],{thumbnail:{path:thumb,samples:thumbSamples},proxy:{path:proxy.proxyPath,width:proxyInfo.width,height:proxyInfo.height,samples:proxySamples},freeze:{path:freeze.path,samples:freezeSamples}});
  }
  const jpeg=path.join(root,'still.jpg');await ff(['-f','rawvideo','-pix_fmt','rgb24','-s','160x90','-i',path.join(root,'complete-sd-pc.rgb'),'-frames:v','1','-vf','scale=out_color_matrix=bt601:out_range=pc','-q:v','1',jpeg]);const still=await probeMedia(jpeg,ctx),thumbInfo=await info(still.thumbnail!);near(patchSamples(await rgba(still.thumbnail!),thumbInfo.width,thumbInfo.height),patchSamples(await rgba(jpeg),160,90).map(p=>p.slice(0,3)),2,'still JPEG full-range');
});

test('Legacy color proxies cannot return on hydration or undo; updating thumbnails preserves custom asset names and clip edits',async()=>{
  const media={...cases[0].media,name:'Custom edited asset',proxyPath:path.join(ctx.cacheDir,'old-proxy.mp4')},project={...cases[0].project,media:[media]},original=JSON.stringify(project),changed=await changedProjectSources(project);assert.ok(changed.has(media.path));const refreshed=await refreshProjectSources(project,changed,ctx);assert.equal(refreshed.changedSources,0);assert.equal(refreshed.project.media[0].name,media.name);assert.equal(refreshed.project.media[0].proxyPath,undefined);assert.deepEqual(refreshed.project.clips,project.clips);assert.equal(JSON.stringify(project),original);assert.equal(mergeAsset(media,{}).proxyPath,undefined);assert.equal((await enrichMedia(media,ctx)).name,media.name);
  const proxy=await createProxy(media,ctx);assert.equal(proxy.name,media.name);
  // A previous thumbnail failure may leave a metadata-only cache entry. A later
  // analysis must retry it instead of permanently returning the incomplete row.
  for(const file of await fs.readdir(ctx.cacheDir)){if(!file.endsWith('.json'))continue;const target=path.join(ctx.cacheDir,file),saved=JSON.parse(await fs.readFile(target,'utf8'));if(saved.path===media.path&&saved.sourceRevision===media.sourceRevision&&saved.thumbnail){delete saved.thumbnail;await fs.writeFile(target,JSON.stringify(saved));}}
  assert.ok((await probeMedia(media.path,ctx)).thumbnail?.endsWith(THUMBNAIL_SUFFIX));
  await fs.writeFile(path.join(root,'fixtures.json'),JSON.stringify({version:JSON.parse(await fs.readFile('package.json','utf8')).version,cases,reports},null,2));
});
