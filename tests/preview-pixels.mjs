// Correctness fixture producer for SLU_PREVIEW_COMPARE. No playback/FPS workload.
// Run after npm run build: node --import tsx tests/preview-pixels.mjs
// Use the same isolated-desktop runner as UI tests.
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {newProject,newClip} from '../shared/project.ts';
import {launchTestElectron,electronTestArgs} from '../scripts/e2e-launch.mjs';
import {editorEvidence,verifyEditorBuild} from '../scripts/e2e-release-evidence.mjs';

const root=path.resolve('.test-artifacts/gpu-preview');await fs.mkdir(root,{recursive:true});
const env={...process.env,SLU_USER_DATA:path.join(root,`pixels-${Date.now()}`),SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):undefined;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:60000});
const errors=[],captures=[];
const variants={baseline:{},flip:{flipH:true},rotation:{rotation:180},crop:{crop:{left:.5,top:0,right:0,bottom:0}},chroma:{chromaKey:{enabled:true,color:'#14e628',similarity:.02,smoothness:.05}},mask:{mask:{type:'ellipse',x:.5,y:.5,width:.7,height:.9,feather:.05,invert:false}},blur:{blur:8}};
try{
  const page=await app.firstWindow();page.on('pageerror',error=>errors.push(String(error)));await page.locator('.preview-gpu-stage').waitFor();
  const evidence=await editorEvidence(app,import.meta.url);
  const quadrant=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const context=canvas.getContext('2d');
    for(const [color,x,y] of [['rgb(240,40,20)',0,0],['rgb(20,230,40)',160,0],['rgb(30,60,240)',0,90],['rgb(220,220,220)',160,90]]){context.fillStyle=color;context.fillRect(x,y,160,90);}
    return canvas.toDataURL('image/png');
  });
  const source=path.join(root,'quadrants.png');await fs.writeFile(source,Buffer.from(quadrant.split(',')[1],'base64'));
  await app.evaluate(({dialog},source)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[source]});},source);
  const media=await page.evaluate(async()=>(await window.studio.importMedia())[0]);assert.ok(media);
  let seek=1000;
  for(const [name,changes] of Object.entries(variants)){
    const project=newProject();project.width=320;project.height=180;project.fps=30;project.background='#112233';project.media=[media];
    project.tracks=project.tracks.filter(track=>track.id==='video-1');project.clips=[{...newClip('video-1',media),duration:.5,...changes}];
    await page.evaluate(({project,seek})=>{
      const runtime=document.querySelector('.preview-gpu-stage').previewRuntime;runtime.setTransport(0,false,seek-1);runtime.setProject(project);runtime.setOptions(false,720,true,[]);runtime.setTransport(0,false,seek);
    },{project,seek:seek++});
    await page.waitForFunction(()=>{const runtime=document.querySelector('.preview-gpu-stage').previewRuntime;return runtime.nodes.size===1&&[...runtime.nodes.values()].every(node=>node.loaded&&!node.failed&&node.element instanceof HTMLImageElement)&&runtime.ready();});
    const points=name==='crop'?[[30,45],[160,45],[160,135]]:name==='mask'?[[5,45],[120,80]]:[[80,45],[240,45],[80,135],[240,135]];
    const captured=await page.evaluate(points=>{
      const runtime=document.querySelector('.preview-gpu-stage').previewRuntime;
      if(runtime.renderer.mode!=='WebGL2')throw new Error('WebGL2 is required for preview/export parity fixtures.');
      const png=runtime.snapshot(),gl=runtime.renderer.gl,extension=gl.getExtension('WEBGL_debug_renderer_info');
      const pixels=points.map(([x,y])=>{const pixel=new Uint8Array(4);gl.readPixels(x,gl.drawingBufferHeight-y-1,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return Array.from(pixel);});
      return {png,pixels,width:gl.drawingBufferWidth,height:gl.drawingBufferHeight,error:gl.getError(),renderer:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};
    },points);
    assert.equal(captured.error,0);assert.equal(captured.width,320);assert.equal(captured.height,180);
    const rgb=captured.pixels.map(pixel=>pixel.slice(0,3));
    if(name==='baseline')assert.deepEqual(rgb,[[240,40,20],[20,230,40],[30,60,240],[220,220,220]]);
    if(name==='flip')assert.deepEqual(rgb[0],[20,230,40]);
    if(name==='rotation')assert.deepEqual(rgb[0],[220,220,220]);
    if(name==='crop')assert.deepEqual(rgb,[[17,34,51],[20,230,40],[220,220,220]]);
    if(name==='chroma'){assert.deepEqual(rgb[1],[17,34,51]);assert.deepEqual(rgb[0],[240,40,20]);}
    if(name==='mask')assert.deepEqual(rgb,[[17,34,51],[240,40,20]]);
    if(name==='blur')assert.ok(Math.abs(rgb[0][0]-240)<2&&Math.abs(rgb[2][2]-240)<2);
    const bytes=Buffer.from(captured.png.split(',')[1],'base64'),output=path.join(root,`${name}.png`);await fs.writeFile(output,bytes);
    const {png,...detail}=captured;captures.push({name,output,sha256:createHash('sha256').update(bytes).digest('hex'),...detail});
  }
  assert.equal(captures.length,7);assert.deepEqual(errors,[]);
  await verifyEditorBuild(evidence);
  const report={...evidence,date:new Date().toISOString(),purpose:'WebGL/export pixel parity only; no timing measurements',checks:captures.map(capture=>`${capture.name}: actual WebGL2 snapshot and reference pixel checks`),captures,errors};
  await fs.writeFile(path.join(root,'pixel-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await app.close();}
