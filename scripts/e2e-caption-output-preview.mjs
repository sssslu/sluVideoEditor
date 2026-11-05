import {captionFontTestSource} from './caption-font-test-source.mjs';
import {launchTestElectron} from './e2e-launch.mjs';

import {build} from 'esbuild';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

// Reuses the actual render produced by tests/caption-export-host.ts; no encoding/export rerun.
const root=path.resolve('.test-artifacts/caption-output-preview');
await fs.mkdir(root,{recursive:true});
const fixturePath=path.resolve('.test-artifacts/rich-captions/raw-fixture.json');
const fixture=JSON.parse(await fs.readFile(fixturePath,'utf8'));
const actualPath=path.resolve('.test-artifacts/rich-captions/actual.yuv'),actual=await fs.readFile(actualPath);
const {width,height,fps}=fixture.settings,frameBytes=width*height*1.5;
assert.equal(actual.length,fixture.frames*frameBytes);
const env={...process.env,SLU_TEST_BACKGROUND:'1',SLU_USER_DATA:path.join(root,`profile-${Date.now()}`)};
delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:[]}:{args:['.']}),env,timeout:60000});
const errors=[];
try{
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(String(e)));await page.locator('.preview-gpu-stage').waitFor();
 const fontSource=await captionFontTestSource();
 const bundle=await build({stdin:{contents:"import {ensureCaptionFonts} from './src/preview/text';import {GLCompositor} from './src/preview/renderer';import {CPUCompositor} from './src/preview/fallback';globalThis.captionOutputQA={ensureCaptionFonts,GLCompositor,CPUCompositor};",resolveDir:path.resolve('.')},plugins:[{name:'bundled-caption-fonts',setup(builder){builder.onLoad({filter:/[\\/]captions[\\/]font\.ts$/},()=>({contents:fontSource,loader:'ts'}));}}],bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'});
 await page.evaluate(bundle.outputFiles[0].text);await page.evaluate(()=>window.captionOutputQA.ensureCaptionFonts());
 const buffers={gpu:[],cpu:[]};
 await page.evaluate(({project})=>{const q=window.captionOutputQA;q.gpu=new q.GLCompositor(document.createElement('canvas'));q.cpu=new q.CPUCompositor(document.createElement('canvas'));q.gpu.resize(project,720);q.cpu.resize(project,720);},fixture);
 for(let frame=0;frame<fixture.frames;frame++){
  const pixels=await page.evaluate(({project,time})=>{
   const q=window.captionOutputQA,sample=time+1e-9,texts=project.clips.filter(c=>sample>=c.start&&sample<c.start+c.duration),base64=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
   q.gpu.draw(project,time,[],texts);q.cpu.draw(project,time,[],texts);
   const {width,height}=project,gl=q.gpu.gl,raw=new Uint8Array(width*height*4),rgb=new Uint8Array(raw.length);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,raw);
   for(let y=0;y<height;y++)rgb.set(raw.subarray((height-y-1)*width*4,(height-y)*width*4),y*width*4);
   if(gl.getError())throw Error('GPU readback error');
   return {gpu:base64(rgb),cpu:base64(q.cpu.canvas.getContext('2d').getImageData(0,0,width,height).data)};
  },{project:fixture.project,time:frame/fps});
  for(const mode of ['gpu','cpu'])buffers[mode].push(Buffer.from(pixels[mode],'base64'));
 }
 await page.evaluate(()=>{window.captionOutputQA.gpu.dispose();window.captionOutputQA.cpu.dispose();});
 assert.deepEqual(errors,[]);
 const details=[];
 for(const mode of ['gpu','cpu']){
  const file=path.join(root,`${mode}.rgba`);await fs.writeFile(file,Buffer.concat(buffers[mode]));
  const converted=await new Promise((resolve,reject)=>{
   const child=spawn(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-framerate',String(fps),'-i',file,'-vf','scale=out_color_matrix=bt709,format=yuv420p','-frames:v',String(fixture.frames),'-f','rawvideo','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
   const data=[],stderr=[];child.stdout.on('data',x=>data.push(x));child.stderr.on('data',x=>stderr.push(x));child.once('error',reject);child.once('close',code=>code===0?resolve(Buffer.concat(data)):reject(Error(Buffer.concat(stderr).toString())));
  });
  assert.equal(converted.length,actual.length);let maximumMean=0,maximumInkMean=0,maximumPixelsOver8=0;
  for(let f=0;f<fixture.frames;f++){
   const offset=f*frameBytes;let error=0,inkError=0,ink=0,over8=0;
   for(let i=0;i<frameBytes;i++){const d=Math.abs(converted[offset+i]-actual[offset+i]);error+=d;}
   for(let i=0;i<width*height;i++){const a=actual[offset+i],b=converted[offset+i];if(a>20||b>20){const d=Math.abs(a-b);inkError+=d;ink++;if(d>8)over8++;}}
   maximumMean=Math.max(maximumMean,error/frameBytes);maximumInkMean=Math.max(maximumInkMean,ink?inkError/ink:0);maximumPixelsOver8=Math.max(maximumPixelsOver8,ink?over8/ink:0);
  }
  details.push({mode,maximumMean,maximumInkMean,maximumPixelsOver8,frames:fixture.frames});
  // Chroma subsampling and Canvas/WebGL transformed-edge sampling are not byte-identical.
  // Region-relative bounds prevent a missing/small caption being hidden by black background.
  assert.ok(maximumMean<1.2,`${mode}: full-frame YUV error ${maximumMean}`);
  assert.ok(maximumInkMean<5,`${mode}: caption-region luma error ${maximumInkMean}`);
  assert.ok(maximumPixelsOver8<.15,`${mode}: changed caption-region fraction ${maximumPixelsOver8}`);
 }
 const sourceFiles=['src/preview/renderer.ts','src/preview/fallback.ts','src/preview/math.ts','src/preview/text.ts','src/captions/layout.ts','src/captions/font.ts','shared/captions.ts'];
 const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
 const report={version:JSON.parse(await fs.readFile('package.json','utf8')).version,executable,width,height,fps,details,sourceHashes:Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,await hash(file)]))),fixtureSha256:await hash(fixturePath),actualSha256:await hash(actualPath),checks:['Every actual 120fps export frame compared with WebGL2 preview and CPU preview through the same BT709 4:2:0 conversion','Word boundaries, fractional exposure, easing, pop/slide animation, opacity, translation, scale, rotation and emoji included'],errors};
 await fs.writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({fps,details,checks:report.checks}));
}finally{await app.close();}
