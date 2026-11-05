import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {probeMedia,createProxy,renderProject,runProcess,canUseNativeBase} from '../electron/media';
import {newProject,newClip} from '../shared/project';
import {changedProjectSources,refreshProjectSources} from '../electron/project-sources';
import {previewProxyPath,toPreviewTime} from '../shared/media-clock';
import {mergeAsset} from '../src/editor';
import type {MediaAsset} from '../shared/types';

const root=path.resolve('.test-artifacts/media-alpha'),ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false},assets:Record<string,MediaAsset>={};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:120000,maxOutputBytes:32*1024*1024});
const pattern="testsrc2=s=160x90:r=30:d=2,format=yuva420p,geq=lum='if(lt(Y,12),if(mod(floor(N/pow(2,floor(X/20))),2),235,16),63)':cb='if(lt(Y,6),128,102)':cr='if(lt(Y,6),128,240)':a='if(lt(Y,12),255,if(lt(X,50),0,if(lt(X,100),128,255)))'";
before(async()=>{await fs.mkdir(root,{recursive:true});for(const kind of ['vp8','vp9','audio']){const file=path.join(root,`${kind}.${kind==='audio'?'mkv':'webm'}`);await ff(['-f','lavfi','-i',pattern,...(kind==='audio'?['-f','lavfi','-i','aevalsrc=0.1*sin(2*PI*1000*t)|0.05*sin(2*PI*750*t):s=48000:d=2']:[]),'-c:v',kind==='vp8'?'libvpx':'libvpx-vp9',...(kind==='vp8'?['-crf','4','-b:v','1M']:['-lossless','1']),'-cpu-used','5','-auto-alt-ref','0','-pix_fmt','yuva420p','-colorspace','bt709',...(kind==='audio'?['-c:a','pcm_f32le']:[]),file]);assets[kind]=await probeMedia(file,ctx);assert.equal(assets[kind].hasAlpha,true);}
});
const samples=(rgba:Buffer,width=160,height=90)=>[25,75,125].map(x=>Array.from(rgba.subarray((Math.floor(height/2)*width+Math.floor(x*width/160))*4,(Math.floor(height/2)*width+Math.floor(x*width/160))*4+4)));
async function rgba(file:string,decoder?:string){return (await ff([...(decoder?['-c:v',decoder]:[]),'-i',file,'-frames:v','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout;}
async function reference(name:string){const data=(await ff(['-c:v',name==='vp8'?'libvpx':'libvpx-vp9','-i',assets[name].path,'-frames:v','1','-pix_fmt','yuva420p','-f','rawvideo','pipe:1'])).stdout,kr=name==='vp8'?.299:.2126,kb=name==='vp8'?.114:.0722,kg=1-kr-kb;return [25,75,125].map(x=>{const y=data[45*160+x],u=data[14400+22*80+Math.floor(x/2)],v=data[18000+22*80+Math.floor(x/2)],alpha=data[21600+45*160+x],l=(y-16)*255/219,cb=(u-128)*255/224,cr=(v-128)*255/224;return {y,u,v,alpha,rgb:[l+2*(1-kr)*cr,l-2*kb*(1-kb)/kg*cb-2*kr*(1-kr)/kg*cr,l+2*(1-kb)*cb].map(value=>Math.max(0,Math.min(255,value)))};});}
test('VP8/VP9 transparent originals compose over the timeline background, including a non-native effect path',{timeout:120000},async()=>{
 const reports=[];for(const name of ['vp8','vp9','audio'])for(const opacity of [1,.5]){const media=assets[name],p=newProject();p.width=160;p.height=90;p.fps=30;p.background='#0000ff';p.media=[media];const c={...newClip('video-1',media),duration:1,opacity};p.clips=[c];assert.equal(await canUseNativeBase({...c,opacity:1},media,1,ctx),false);const output=path.join(root,`${name}-${opacity}.mp4`);await renderProject(p,{width:160,height:90,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'high',outputPath:output},ctx);const rgb=samples(await rgba(output));
   const source=await reference(name),expected=source.map(sample=>{const a=sample.alpha/255*opacity;return sample.rgb.map((value,channel)=>value*a+(channel===2?255:0)*(1-a));});for(let i=0;i<3;i++)for(let ch=0;ch<3;ch++)assert.ok(Math.abs(rgb[i][ch]-expected[i][ch])<7,`${name} opacity${opacity} at${i}: ${rgb[i]} vs${expected[i]}`);reports.push({name,opacity,rgb,expected,source});}
 await fs.writeFile(path.join(root,'render-results.json'),JSON.stringify(reports,null,2));
});
test('Transparent proxy and thumbnail retain alpha; audio proxy uses a seekable native WebM container',{timeout:120000},async()=>{
 const proxies:Record<string,MediaAsset>={};for(const [name,asset] of Object.entries(assets)){const source=await reference(name),expected=source.map(s=>s.alpha);assert.ok(asset.thumbnail?.endsWith('.png'));const thumbnail=await rgba(asset.thumbnail!),a=samples(thumbnail,320,180).map(p=>p[3]);assert.deepEqual(a,expected);const proxy=await createProxy(asset,ctx),pixels=samples(await rgba(proxy.proxyPath!,'libvpx-vp9'));assert.ok(proxy.proxyPath?.endsWith('-alpha-proxy.webm'));assert.ok(pixels.every((p,i)=>Math.abs(p[3]-expected[i])<=2));assert.equal(pixels[0][3],0);assert.equal(pixels[2][3],255);assert.equal(previewProxyPath(proxy),proxy.proxyPath);assert.equal((await createProxy(asset,ctx)).proxyPath,proxy.proxyPath);proxies[name]=proxy;}
 await fs.writeFile(path.join(root,'fixtures.json'),JSON.stringify({version:JSON.parse(await fs.readFile('package.json','utf8')).version,assets,proxies},null,2));
});
test('Legacy opaque proxies are discarded on hydration and cannot return through history or preview clocks',async()=>{
 const media=assets.vp9,p=newProject(),legacy={...media,hasAlpha:undefined,proxyPath:path.join(ctx.cacheDir,'old-proxy.mp4')};p.media=[legacy];p.clips=[newClip('video-1',legacy)];const old=JSON.stringify(p),changed=await changedProjectSources(p);assert.ok(changed.has(media.path));const refreshed=await refreshProjectSources(p,changed,ctx);assert.equal(refreshed.changedSources,0);assert.equal(refreshed.project.media[0].hasAlpha,true);assert.equal(refreshed.project.media[0].proxyPath,undefined);assert.equal(JSON.stringify(p),old);assert.deepEqual(refreshed.project.clips,p.clips);
 const hydrated={...legacy,hasAlpha:true,timing:{version:1 as const,origin:2,previewOffset:2}};assert.equal(previewProxyPath(hydrated),undefined);assert.equal(toPreviewTime(hydrated,.3,true),2.3);assert.equal(mergeAsset(legacy,{hasAlpha:true}).proxyPath,undefined);
});
