import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';

import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';
const root=path.resolve('.test-artifacts/color-pixels');await fs.mkdir(root,{recursive:true});
const fixture=JSON.parse(await fs.readFile('.test-artifacts/color-render/fixture.json','utf8')),chart=await fs.readFile('.test-artifacts/color-render/chart.rgba');
const env={...process.env,SLU_USER_DATA:path.join(root,`profile-${Date.now()}`),SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({args:electronTestArgs(),env,timeout:60000}),errors=[];
try{
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(String(e)));await page.locator('.preview-gpu-stage').waitFor();
 const bundle=await build({stdin:{contents:"import {GLCompositor} from './src/preview/renderer';import {CPUCompositor} from './src/preview/fallback';globalThis.colorQA={GLCompositor,CPUCompositor};",resolveDir:path.resolve('.')},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',logLevel:'silent'});
 await page.evaluate(bundle.outputFiles[0].text);
 const renderer=await page.evaluate(({fixture,raw})=>{const q=globalThis.colorQA,{width,height,project}=fixture;q.source=document.createElement('canvas');q.source.width=width;q.source.height=height;const data=Uint8ClampedArray.from(atob(raw),c=>c.charCodeAt(0));q.source.getContext('2d').putImageData(new ImageData(data,width,height),0,0);q.gpu=new q.GLCompositor(document.createElement('canvas'));q.cpu=new q.CPUCompositor(document.createElement('canvas'));q.gpu.resize(project,720);q.cpu.resize(project,720);const gl=q.gpu.gl,info=gl.getExtension('WEBGL_debug_renderer_info');return info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);},{fixture,raw:chart.toString('base64')});
 const details=[];
 for(const item of fixture.cases){
  const pixels=await page.evaluate(({project,item})=>{const q=globalThis.colorQA,clip={...project.clips[0],colorGrade:item.grade},p={...project,clips:[clip],colorLuts:item.lut?[item.lut]:[]},visuals=[{clip,frame:{key:'chart',source:q.source,width:p.width,height:p.height,version:1}}];q.gpu.draw(p,0,visuals,[]);q.cpu.draw(p,0,visuals,[]);const gl=q.gpu.gl,raw=new Uint8Array(p.width*p.height*4),flipped=new Uint8Array(raw.length);gl.readPixels(0,0,p.width,p.height,gl.RGBA,gl.UNSIGNED_BYTE,raw);if(gl.getError())throw Error('WebGL color readback failed');for(let y=0;y<p.height;y++)flipped.set(raw.subarray((p.height-y-1)*p.width*4,(p.height-y)*p.width*4),y*p.width*4);const b64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};return {gpu:b64(flipped),cpu:b64(q.cpu.canvas.getContext('2d').getImageData(0,0,p.width,p.height).data)};},{project:fixture.project,item});
  const expected=await fs.readFile(path.resolve('.test-artifacts/color-render',item.name,'expected.rgba')),exported=await fs.readFile(path.resolve('.test-artifacts/color-render',item.name,'actual.rgba'));
  for(const mode of ['gpu','cpu']){const actual=Buffer.from(pixels[mode],'base64');assert.equal(actual.length,expected.length);let max=0,sum=0,exportMax=0,exportSum=0;for(let i=0;i<actual.length;i++){const d=Math.abs(actual[i]-expected[i]),e=Math.abs(actual[i]-exported[i]);max=Math.max(max,d);sum+=d;exportMax=Math.max(exportMax,e);exportSum+=e;}const mean=sum/(actual.length/4*3),exportMean=exportSum/(actual.length/4*3);assert.ok(max<=1&&mean<.15,`${item.name}/${mode}: reference ${max}/${mean}`);assert.ok(exportMax<=2&&exportMean<.7,`${item.name}/${mode}: FFmpeg ${exportMax}/${exportMean}`);await fs.writeFile(path.join(root,`${item.name}-${mode}.rgba`),actual);details.push({case:item.name,mode,max,mean,exportMax,exportMean});}
 }
 await page.evaluate(()=>{globalThis.colorQA.gpu.dispose();globalThis.colorQA.cpu.dispose();});assert.deepEqual(errors,[]);
 const sources=['src/preview/color-grade.ts','src/preview/programs.ts','src/preview/renderer.ts','src/preview/fallback.ts','shared/color.ts'];const report={version:JSON.parse(await fs.readFile('package.json','utf8')).version,renderer,details,sourceHashes:Object.fromEntries(await Promise.all(sources.map(async file=>[file,createHash('sha256').update(await fs.readFile(file)).digest('hex')]))),checks:['Actual WebGL2 shader and CPU compositor match reference pixels on 8 color configurations','Every configuration compares with actual FFmpeg output','4096-sample curves, all tetrahedral sectors, custom domains, strength, 33/65 LUTs and bypass'],errors};await fs.writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await app.close();}
