import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {newProject,newClip} from '../shared/project.ts';
const parent=path.resolve('.test-artifacts/alpha-resampling'),latest=(await fs.readdir(parent)).sort().at(-1),fixture=JSON.parse(await fs.readFile(path.join(parent,latest,'fixtures.json'),'utf8')),proxies=JSON.parse(await fs.readFile(path.join(parent,latest,'proxy-results.json'),'utf8'));
const root=path.resolve('.test-artifacts/alpha-edges-ui',Date.now().toString());await fs.mkdir(root,{recursive:true});
const env={...process.env,SLU_USER_DATA:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({args:electronTestArgs(),env,timeout:60000}),page=await app.firstWindow(),errors=[],checks=[];page.on('pageerror',e=>errors.push(String(e)));
try{
 await page.locator('.preview-gpu-stage').waitFor();
 const bundle=await build({stdin:{contents:"import {GLCompositor} from './src/preview/renderer';import {CPUCompositor} from './src/preview/fallback';globalThis.alphaQA={GLCompositor,CPUCompositor};",resolveDir:path.resolve('.')},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',logLevel:'silent'});await page.evaluate(bundle.outputFiles[0].text);
 const data=await fs.readFile(path.join(fixture.root,'zero.bgra')),rgba=Buffer.from(data);for(let i=0;i<rgba.length;i+=4){rgba[i]=data[i+2];rgba[i+2]=data[i];}
 const [media]=await page.evaluate(file=>window.studio.importMedia([file]),proxies.proxies[1].proxyPath),project=newProject();project.width=160;project.height=120;project.background='#ff0000';project.media=[media];project.clips=[{...newClip('video-1',media),duration:.2}];
 const renderer=await page.evaluate(async({raw,media,project})=>{
  const q=window.alphaQA;q.source=document.createElement('canvas');q.source.width=96;q.source.height=64;q.source.getContext('2d').putImageData(new ImageData(Uint8ClampedArray.from(atob(raw),c=>c.charCodeAt(0)),96,64),0,0);
  q.video=document.createElement('video');q.video.crossOrigin='anonymous';q.video.muted=true;q.video.style.cssText='position:fixed;left:0;top:0;width:96px;height:64px;z-index:10000';document.body.append(q.video);q.video.src=window.studio.mediaUrl(media.path);await new Promise((resolve,reject)=>{q.video.addEventListener('loadeddata',resolve,{once:true});q.video.addEventListener('error',()=>reject(Error('Alpha fixture decoder failed')),{once:true});q.video.load();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No presented alpha frame')),10000);q.video.requestVideoFrameCallback(()=>{clearTimeout(timer);q.video.pause();resolve();});q.video.play().catch(reject);});
  q.gpu=new q.GLCompositor(document.createElement('canvas'));q.cpu=new q.CPUCompositor(document.createElement('canvas'));q.gpu.resize(project,720);q.cpu.resize(project,720);const gl=q.gpu.gl,ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
 },{raw:rgba.toString('base64'),media,project});
 const cases=[['resize',{}],['rotate',{scale:.87,rotation:17,x:.3,y:-.2}],['blur',{blur:2,scale:.87,rotation:17}]];
 for(const source of ['canvas','video'])for(const [name,edit]of cases){
  const result=await page.evaluate(({project,source,edit})=>{
   const q=window.alphaQA,p={...project,clips:[{...project.clips[0],...edit}]},element=source==='canvas'?q.source:q.video,visuals=[{clip:p.clips[0],frame:{key:source,source:element,width:96,height:64,version:1}}];q.gpu.draw(p,0,visuals,[]);q.cpu.draw(p,0,visuals,[]);
   const gl=q.gpu.gl,gpu=new Uint8Array(160*120*4);gl.readPixels(0,0,160,120,gl.RGBA,gl.UNSIGNED_BYTE,gpu);if(gl.getError())throw Error('GPU readback failed');const cpu=q.cpu.canvas.getContext('2d').getImageData(0,0,160,120).data;
   const deficit=data=>{let max=0,count=0;for(let i=0;i<data.length;i+=4){max=Math.max(max,255-data[i]);if(data[i+1]>16)count++;}return {max,count};};return {gpu:deficit(gpu),cpu:deficit(cpu)};
  },{project,source,edit});
  checks.push({source,name,...result});
  for(const [mode,value]of Object.entries(result)){assert.ok(value.count>1000,`${source}/${name}/${mode}: missing foreground ${JSON.stringify(result)}`);assert.ok(value.max<=(source==='canvas'?2:8),`${source}/${name}/${mode}: red deficit ${value.max}`);}
 }
 assert.deepEqual(errors,[]);await captureElectron(app,{path:path.join(root,'editor.png')});await fs.writeFile(path.join(root,'results.json'),JSON.stringify({root,fixture:fixture.root,renderer,checks,errors},null,2));console.log(JSON.stringify({root,renderer,checks,errors}));
}catch(error){await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({checks,errors,error:String(error)},null,2));throw error;}finally{await app.close();}
