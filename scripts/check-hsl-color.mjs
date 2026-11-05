import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {RenderColorFiles} from '../electron/render-color.ts';
import {HSL_BANDS,applyColorPixels,encodeLutData} from '../shared/color.ts';
import {newClip,newProject} from '../shared/project.ts';
import {launchTestElectron,electronTestArgs,assertQuietDialogs} from './e2e-launch.mjs';

// Run with node --import tsx. The app supplies an isolated Chromium/WebGL host;
// current source compositors are bundled into that host without rebuilding dist.
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const base=path.resolve('.test-artifacts/hsl-color',version);
await fs.mkdir(base,{recursive:true});
const directory=await fs.mkdtemp(path.join(base,'proof-'));
const hashFile=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),run=promisify(execFile);
const native=async args=>(await run(ffmpeg,['-v','error','-nostdin',...args],{cwd:directory,windowsHide:true,encoding:'buffer',timeout:60000,maxBuffer:16*1024*1024})).stdout;
const width=128,height=64,original=Buffer.alloc(width*height*4);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const at=(y*width+x)*4;
  original.set(y<8?[x*2,x*2,x*2,255]:[x*2,(y*7+x*3)%256,(y*13+x*5)%256,255],at);
}
const alpha=Buffer.from(original);for(let index=3;index<alpha.length;index+=4)alpha[index]=(index>>>2)%256;
await fs.writeFile(path.join(directory,'chart.rgba'),original);
await fs.writeFile(path.join(directory,'alpha.rgba'),alpha);
const zero={hue:0,saturation:0,lightness:0};
const mixed=Object.fromEntries(HSL_BANDS.map((band,index)=>[band,{hue:index%2?36:-24,saturation:index%2?.6:-.45,lightness:index%2?.15:-.2}]));
const lut={id:'test-lut',name:'HSL combination',size:2,domainMin:[-.1,0,.1],domainMax:[.9,1,1.1],encoding:'f32le',data:encodeLutData(Array.from({length:24},(_,index)=>.1+.75*Number((Math.floor(index/3)>>(index%3))&1)))};
const cases=[
  {name:'neutral',grade:{enabled:true,intensity:1,hsl:{red:zero}}},
  ...HSL_BANDS.map(band=>({name:band,grade:{enabled:true,intensity:1,hsl:{[band]:{hue:60,saturation:-.3,lightness:.2}}}})),
  {name:'overlap',grade:{enabled:true,intensity:1,hsl:mixed}},
  {name:'combined',grade:{enabled:true,intensity:.37,hsl:mixed,curves:{master:[{x:0,y:.02},{x:.5,y:.4},{x:1,y:.95}]},lutId:lut.id},lut},
  {name:'bypass',grade:{enabled:false,intensity:1,hsl:mixed}},
];
const bundled=await build({stdin:{contents:"import {GLCompositor} from './src/preview/renderer';import {CPUCompositor} from './src/preview/fallback';globalThis.hslQA={GLCompositor,CPUCompositor};",resolveDir:path.resolve('.')},bundle:true,write:false,metafile:true,format:'iife',platform:'browser',target:'es2022',logLevel:'silent'});
const sourceFiles=[...new Set(['scripts/check-hsl-color.mjs','electron/render-color.ts','electron/alpha-filters.ts','shared/color.ts','shared/types.ts',...Object.keys(bundled.metafile.inputs).filter(file=>file!=='<stdin>')])].sort();
const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,await hashFile(file)])));
const ffmpegSha256=await hashFile(ffmpeg),bundleSha256=createHash('sha256').update(bundled.outputFiles[0].text).digest('hex');
await fs.writeFile(path.join(directory,'preview-bundle.js'),bundled.outputFiles[0].text);
const nativeResults=[];
for(const item of cases){
  const caseDirectory=path.join(directory,item.name);await fs.mkdir(caseDirectory);
  const graph=[],chain=[],files=new RenderColorFiles(caseDirectory);
  const source=await files.append(graph,'0:v',chain,item.grade,item.lut,'color');
  graph.push(`[${source}]${chain.length?chain.join(','):'null'}[out]`);
  await fs.writeFile(path.join(caseDirectory,'filters.txt'),graph.join(';\n'));
  for(const [name,input] of [['chart',original],['alpha',alpha]]){
    const expected=new Uint8ClampedArray(input);applyColorPixels(expected,item.grade,item.lut);
    const actual=(await run(ffmpeg,['-v','error','-nostdin','-filter_complex_threads','1','-f','rawvideo','-pix_fmt','rgba','-s',`${width}x${height}`,'-i',path.join(directory,`${name}.rgba`),'-filter_complex_script','filters.txt','-map','[out]','-frames:v','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'],{cwd:caseDirectory,windowsHide:true,encoding:'buffer',timeout:60000,maxBuffer:original.length*2})).stdout;
    assert.equal(actual.length,expected.length);let maximum=0,sum=0,samples=0;
    for(let index=0;index<actual.length;index++){
      if(index%4===3)assert.equal(actual[index],expected[index],`${item.name}/${name} alpha`);
      else if(expected[(index&~3)+3]){const difference=Math.abs(actual[index]-expected[index]);maximum=Math.max(maximum,difference);sum+=difference;samples++;}
    }
    const mean=sum/samples;assert.ok(maximum<=2&&mean<.7,`${item.name}/${name}: ${maximum}/${mean}`);
    if(item.name==='neutral'||item.name==='bypass')assert.deepEqual(actual,input);
    await fs.writeFile(path.join(caseDirectory,`${name}-expected.rgba`),expected);
    await fs.writeFile(path.join(caseDirectory,`${name}-actual.rgba`),actual);
    nativeResults.push({name:item.name,input:name,maximum,mean,alphaLevels:name==='alpha'?256:1});
  }
}
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const app=await launchTestElectron({...(executable?{executablePath:executable}:{}),args:electronTestArgs(!!executable),env:{...process.env,SLU_USER_DATA:path.join(directory,'profile')},timeout:90000});
const errors=[],previewResults=[];
try{
  const runtime=await app.evaluate(({app,BrowserWindow})=>({version:app.getVersion(),appPath:app.getAppPath(),executable:process.execPath,hidden:BrowserWindow.getAllWindows().every(window=>!window.isVisible())}));
  assert.equal(runtime.hidden,true);
  const page=await app.firstWindow();page.on('pageerror',error=>errors.push(String(error)));
  await page.locator('.preview-gpu-stage').waitFor();await page.evaluate(bundled.outputFiles[0].text);
  const media={id:'hsl-chart',path:path.join(directory,'chart.rgba'),name:'Chart',kind:'image',duration:0,width,height,fps:0,hasAudio:false};
  const project={...newProject(),width,height,media:[media],clips:[newClip('video-1',media)]};
  const renderer=await page.evaluate(({project,raw})=>{
    const q=globalThis.hslQA;q.source=document.createElement('canvas');q.source.width=project.width;q.source.height=project.height;
    q.source.getContext('2d').putImageData(new ImageData(Uint8ClampedArray.from(atob(raw),value=>value.charCodeAt(0)),project.width,project.height),0,0);
    q.gpu=new q.GLCompositor(document.createElement('canvas'));q.cpu=new q.CPUCompositor(document.createElement('canvas'));q.gpu.resize(project,720);q.cpu.resize(project,720);
    const gl=q.gpu.gl,extension=gl.getExtension('WEBGL_debug_renderer_info');return gl.getParameter(extension?extension.UNMASKED_RENDERER_WEBGL:gl.RENDERER);
  },{project,raw:original.toString('base64')});
  for(const item of cases){
    const pixels=await page.evaluate(({project,item})=>{
      const q=globalThis.hslQA,clip={...project.clips[0],colorGrade:item.grade},p={...project,clips:[clip],colorLuts:item.lut?[item.lut]:[]};
      const visuals=[{clip,frame:{key:'hsl',source:q.source,width:p.width,height:p.height,version:1}}];q.gpu.draw(p,0,visuals,[]);q.cpu.draw(p,0,visuals,[]);
      const gl=q.gpu.gl,raw=new Uint8Array(p.width*p.height*4),flipped=new Uint8Array(raw.length);gl.readPixels(0,0,p.width,p.height,gl.RGBA,gl.UNSIGNED_BYTE,raw);assertNoError();
      function assertNoError(){if(gl.getError())throw Error('HSL WebGL readback failed');}
      for(let y=0;y<p.height;y++)flipped.set(raw.subarray((p.height-y-1)*p.width*4,(p.height-y)*p.width*4),y*p.width*4);
      const encode=bytes=>{let value='';for(let i=0;i<bytes.length;i+=8192)value+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(value);};
      return {gpu:encode(flipped),cpu:encode(q.cpu.canvas.getContext('2d').getImageData(0,0,p.width,p.height).data)};
    },{project,item});
    const expected=await fs.readFile(path.join(directory,item.name,'chart-expected.rgba'));
    for(const mode of ['gpu','cpu']){
      const actual=Buffer.from(pixels[mode],'base64');assert.equal(actual.length,expected.length);let maximum=0,sum=0;
      for(let index=0;index<actual.length;index++){const difference=Math.abs(actual[index]-expected[index]);maximum=Math.max(maximum,difference);sum+=difference;}
      const mean=sum/(width*height*3);assert.ok(maximum<=1&&mean<.15,`${item.name}/${mode}: ${maximum}/${mean}`);
      await fs.writeFile(path.join(directory,item.name,`${mode}.rgba`),actual);previewResults.push({name:item.name,mode,maximum,mean});
    }
  }
  await page.evaluate(()=>{globalThis.hslQA.gpu.dispose();globalThis.hslQA.cpu.dispose();});
  for(const [file,digest] of Object.entries(sourceHashes))assert.equal(await hashFile(file),digest,`Changed proof source: ${file}`);
  assert.equal(await hashFile(ffmpeg),ffmpegSha256);assert.deepEqual(errors,[]);
  const quiet=await assertQuietDialogs(app);
  for(const name of ['neutral','overlap','combined'])await native(['-y','-f','rawvideo','-pix_fmt','rgba','-s',`${width}x${height}`,'-i',path.join(directory,name,'gpu.rgba'),'-frames:v','1',path.join(directory,`${name}.png`)]);
  await fs.writeFile(path.join(directory,'results.json'),JSON.stringify({passed:true,version,runtime,renderer,sourceHashes,bundleSha256,ffmpegSha256,nativeResults,previewResults,errors,quiet,scope:'Current source HSL CPU/WebGL and actual FFmpeg filter parity using an isolated app host; separate final application verification remains required.'},null,2));
  console.log(JSON.stringify({directory,passed:true,nativeCases:nativeResults.length,previewCases:previewResults.length,renderer}));
}catch(error){await fs.writeFile(path.join(directory,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,nativeResults,previewResults,errors},null,2));throw error;}
finally{await app.close();}
