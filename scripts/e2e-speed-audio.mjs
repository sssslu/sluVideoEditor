import {launchTestElectron} from './e2e-launch.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve('.test-artifacts/speed-audio');await fs.mkdir(root,{recursive:true});
const profile=path.join(root,`profile-${Date.now()}`),env={...process.env,SLU_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const example=JSON.parse(await fs.readFile('examples/AURORA.sluproj','utf8')),clip=example.clips.find(c=>c.mediaId&&example.media.find(m=>m.id===c.mediaId)?.kind==='video');
const app=await launchTestElectron({args:['.'],env,timeout:90000}),page=await app.firstWindow(),results=[],errors=[];page.on('dialog',dialog=>dialog.accept());page.on('pageerror',error=>errors.push(String(error)));
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
  for(const rate of [1,.1,16]){
    const project={...example,version:2,id:`speed-audio-${rate}`,name:`Audio ${rate}`,clips:[{...clip,in:0,start:0,duration:12/rate,speed:1,volume:1,fadeIn:0,fadeOut:0,keyframes:[],sourceClipOffset:undefined,sourceClipDuration:undefined,speedCurve:[{position:0,speed:rate},{position:1,speed:rate}]}]};
    const file=path.join(root,`speed-${rate}.sluproj`);await fs.writeFile(file,JSON.stringify(project));await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');await page.waitForFunction(name=>document.querySelector('[aria-label="프로젝트 이름"]').value===name,project.name);await page.waitForFunction(()=>{const video=document.querySelector('.gpu-media-decoders video');return video&&video.readyState>=2&&!video.seeking&&!video.error;});
    await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.time()>.2);
    const measured=await page.evaluate(async()=>{const runtime=document.querySelector('.preview-gpu-stage').previewRuntime,audio=runtime.audio,master=runtime.master,analyser=audio.createAnalyser();analyser.fftSize=2048;master.connect(analyser);let peak=0;const data=new Float32Array(2048);try{for(let i=0;i<5;i++){await new Promise(resolve=>setTimeout(resolve,30));analyser.getFloatTimeDomainData(data);peak=Math.max(peak,Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length));}return {context:audio.state,rms:peak,rate:document.querySelector('.gpu-media-decoders video').playbackRate,timeline:runtime.time()};}finally{master.disconnect(analyser);analyser.disconnect();}});
    await page.keyboard.press('Space');results.push({requestedRate:rate,...measured});
  }
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({results,errors},null,2));console.log(JSON.stringify({results,errors}));assert.deepEqual(errors,[]);for(const result of results)assert.ok(result.rms>1e-5,`Preview audio is silent at ${result.requestedRate}x`);
}finally{await app.close();}
