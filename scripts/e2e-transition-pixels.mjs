import {launchTestElectron} from './e2e-launch.mjs';

import {build} from 'esbuild';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve('.test-artifacts/transition-pixels');await fs.mkdir(root,{recursive:true});
const env={...process.env,SLU_TEST_BACKGROUND:'1',SLU_USER_DATA:path.join(root,`profile-${Date.now()}`)};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({args:['.'],env,timeout:60000}),page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
try{
 await page.locator('.preview-gpu-stage').waitFor();
 const system=await page.evaluate(()=>window.studio.getSystemInfo());assert.equal(system.version,JSON.parse(await fs.readFile('package.json','utf8')).version);
 const code=await build({stdin:{contents:"import {GLCompositor} from './src/preview/renderer';import {CPUCompositor} from './src/preview/fallback';import {newClip,newProject} from './shared/project';import {transitionPixel} from './shared/transitions';globalThis.transitionQA={GLCompositor,CPUCompositor,newClip,newProject,transitionPixel};",resolveDir:path.resolve('.')},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'});
 await page.evaluate(code.outputFiles[0].text);
 const results=await page.evaluate(()=>{
  const {GLCompositor,CPUCompositor,newClip,newProject,transitionPixel}=window.transitionQA,W=320,H=180,background=[31,173,67],project={...newProject(),width:W,height:H,background:'#1fad43'},gpu=new GLCompositor(document.createElement('canvas')),cpu=new CPUCompositor(document.createElement('canvas'));
  gpu.resize(project,720);cpu.resize(project,720);
  const source=(alpha,flip)=>{const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;const context=canvas.getContext('2d');context.globalAlpha=alpha;for(const [color,x,y]of flip?[['#ead532',8,8],['#3d37e8',160,8],['#d73398',8,90],['#33e6dc',160,90]]:[['#ea3328',8,8],['#35d85a',160,8],['#3556e8',8,90],['#e6e4dd',160,90]]){context.fillStyle=color;context.fillRect(x,y,x===8?152:152,y===8?82:82);}return canvas;};
  const read=(renderer,target)=>{if(renderer.mode==='CPU')return renderer.pairInputs[target].getContext('2d').getImageData(0,0,W,H).data;const gl=renderer.gl,out=new Uint8Array(W*H*4);gl.bindFramebuffer(gl.FRAMEBUFFER,renderer.targets[target+2].framebuffer);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,out);gl.bindFramebuffer(gl.FRAMEBUFFER,null);return out;};
  const output=renderer=>{if(renderer.mode==='CPU')return renderer.context.getImageData(0,0,W,H).data;const gl=renderer.gl,out=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,out);return out;};
  function sampler(data,gl){return(u,v)=>{const x=u*W-.5,y=v*H-.5,x0=Math.floor(x),y0=Math.floor(y),wx=x-x0,wy=y-y0,out=[0,0,0,0];for(let j=0;j<2;j++)for(let i=0;i<2;i++){const sx=Math.max(0,Math.min(W-1,x0+i)),sy=Math.max(0,Math.min(H-1,y0+j)),at=((gl?H-1-sy:sy)*W+sx)*4,weight=(i?wx:1-wx)*(j?wy:1-wy),alpha=data[at+3]/255;for(let c=0;c<4;c++)out[c]+=data[at+c]/255*(c===3||gl?1:alpha)*weight;}return out;};}
  const reports=[];let sequence=0,example;
  for(const variant of ['opaque','transparent','effects'])for(const kind of ['dissolve','wipe','slide','zoom'])for(const direction of kind==='wipe'||kind==='slide'?['left','right','up','down']:['left'])for(const progress of [0,.25,1/3,.5,.731,1]){
   const a=source(variant==='opaque'?1:.5,false),b=source(variant==='opaque'?1:.35,true),base={...newClip('video-1'),text:undefined,start:0,duration:4,fadeIn:0,fadeOut:0,opacity:1,x:0,y:0,scale:1,rotation:0,brightness:0,contrast:1,saturation:1,blur:0,preset:'none',keyframes:[]};
   const from={clip:{...base,id:'a',...(variant==='effects'?{rotation:7,crop:{left:.1,top:0,right:0,bottom:0},mask:{type:'ellipse',x:.5,y:.5,width:.8,height:.9,feather:.03,invert:false}}:{})},frame:{key:'a',source:a,width:W,height:H,version:++sequence}},to={clip:{...base,id:'b',...(variant==='effects'?{x:20,scale:.8,brightness:.1,blur:1.5}:{})},frame:{key:'b',source:b,width:W,height:H,version:sequence}};
   const transition={id:'t',fromClipId:'a',toClipId:'b',kind,direction,durationFrames:30},node={type:'transition',transition,from,to,progress};
   const perRenderer=[],outputs=[];
   for(const renderer of [gpu,cpu]){
    renderer.draw(project,1,[node],[]);const actual=output(renderer),sampleA=sampler(read(renderer,0),renderer.mode==='WebGL2'),sampleB=sampler(read(renderer,1),renderer.mode==='WebGL2');let maximum=0,bad=0,sum=0;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){const expected=transitionPixel(kind,progress,direction,(x+.5)/W,(y+.5)/H,sampleA,sampleB),at=((renderer.mode==='WebGL2'?H-1-y:y)*W+x)*4;for(let c=0;c<3;c++){const error=Math.abs(actual[at+c]-Math.round((expected[c]+background[c]/255*(1-expected[3]))*255));maximum=Math.max(maximum,error);sum+=error;if(error>3)bad++;}}
    perRenderer.push({mode:renderer.mode,maximum,mean:sum/(W*H*3),badRatio:bad/(W*H*3)});outputs.push(actual);
    if(renderer.mode==='WebGL2'&&renderer.gl.getError())throw Error('WebGL transition error');
   }
   let between=0,betweenBad=0;for(let y=0;y<H;y++)for(let x=0;x<W;x++)for(let c=0;c<3;c++){const error=Math.abs(outputs[0][((H-1-y)*W+x)*4+c]-outputs[1][(y*W+x)*4+c]);between+=error;if(error>4)betweenBad++;}
   reports.push({variant,kind,direction,progress,renderers:perRenderer,cpuGpuMean:between/(W*H*3),cpuGpuBadRatio:betweenBad/(W*H*3)});
   if(variant==='transparent'&&kind==='dissolve'&&progress===.5)example=gpu.canvas.toDataURL('image/png');
  }
  gpu.dispose();cpu.dispose();return {reports,example};
 });
 await fs.writeFile(path.join(root,'dissolve-transparent.png'),Buffer.from(results.example.split(',')[1],'base64'));delete results.example;
 await fs.writeFile(path.join(root,'results.json'),JSON.stringify({version:system.version,date:new Date().toISOString(),rendererSourceSha256:createHash('sha256').update(code.outputFiles[0].text).digest('hex'),harness:'Current source renderers injected into Electron WebGL2/Canvas2D',...results,errors},null,2));
 for(const item of results.reports){for(const renderer of item.renderers)assert.ok(renderer.mean<1.2&&renderer.badRatio<.006,JSON.stringify(item));if(item.variant!=='effects')assert.ok(item.cpuGpuMean<1.2&&item.cpuGpuBadRatio<.006,JSON.stringify(item));}
 assert.deepEqual(errors,[]);console.log(JSON.stringify({cases:results.reports.length,comparisons:results.reports.length*2,maxReferenceMean:Math.max(...results.reports.flatMap(r=>r.renderers.map(x=>x.mean))),errors}));
}finally{await app.close();}
