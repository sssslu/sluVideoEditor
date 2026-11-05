import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {editorEvidence,testExecutable} from './e2e-release-evidence.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const fixture=path.resolve(process.argv[2]||(await fs.readFile('.test-artifacts/matting-long/current.txt','utf8')).trim());
const timing=JSON.parse(await fs.readFile(path.join(fixture,'proxy-timing-results.json'),'utf8'));
assert.equal(timing.passed,true);
const initial=JSON.parse(await fs.readFile(timing.review,'utf8')),originalId=initial.clips[0].id,media=initial.media.find(m=>m.hasAlpha);
const root=path.resolve('.test-artifacts/cutout-long-ui',String(Date.now()));await fs.mkdir(root,{recursive:true});
// Project loading deliberately rejects proxy paths outside its own cache.
// Seed the isolated test profile with the already verified proxy bytes.
const cached=path.join(root,'profile','cache',path.basename(media.proxyPath));await fs.mkdir(path.dirname(cached),{recursive:true});await fs.copyFile(media.proxyPath,cached);media.proxyPath=cached;
const input=path.join(root,'input.sluproj');await fs.writeFile(input,JSON.stringify(initial));
const env={...process.env,SLU_USER_DATA:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const executable=testExecutable();
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000}),page=await app.firstWindow(),checks=[],errors=[],seeks=[],run=promisify(execFile);
page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
const current=()=>page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project);
async function program(){await dismissToasts(page);if(await page.getByTitle('작업 패널 닫기',{exact:true}).count())await page.getByTitle('작업 패널 닫기',{exact:true}).click();await page.getByRole('button',{name:'프로그램',exact:true}).click();}
async function open(file){await program();await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();}
async function select(id){await program();await page.locator(`[data-clip-id="${id}"]`).click();const section=page.locator('.inspector').getByRole('button',{name:'미디어',exact:true});if(await section.getAttribute('aria-expanded')==='false')await section.click();}
async function snapshot(predicate){const start=Date.now();let result;while(Date.now()-start<30000){result=await current();if(predicate(result))return result;await page.waitForTimeout(50);}throw Error('Project state timed out: '+JSON.stringify(result).slice(0,3000));}
const points=Array.from({length:20*12},(_,i)=>[32+(i%20)*64,30+Math.floor(i/20)*60]);
async function seek(frame,id=originalId){
  await program();await page.keyboard.press('Home');for(let n=0;n<Math.floor(frame/30);n++)await page.keyboard.press('Shift+ArrowRight');for(let n=0;n<frame%30;n++)await page.keyboard.press('ArrowRight');
  const time=frame/30,index=timing.proxyTimes.findLastIndex(t=>t<=time+1e-6),expected=timing.proxyTimes[index];
  await page.waitForFunction(({id,time,expected})=>{const r=document.querySelector('.preview-gpu-stage')?.previewRuntime,n=r?.nodes.get(id);return r&&Math.abs(r.time()-time)<1e-6&&n?.loaded&&!n.failed&&!n.element.seeking&&n.element.readyState>=2&&Math.abs((n.presentedTime??-10)-expected)<.00001;},{id,time,expected},{timeout:30000}).catch(async error=>{const state=await page.evaluate(id=>{const r=document.querySelector('.preview-gpu-stage')?.previewRuntime;return {time:r?.time(),nodes:[...r.nodes.entries()].map(([key,n])=>({key,desired:n.desired,presented:n.presentedTime,currentTime:n.element.currentTime,loaded:n.loaded,failed:n.failed,seeking:n.element.seeking,readyState:n.element.readyState,url:n.url}))};},id);await fs.writeFile(path.join(root,'seek-failure.json'),JSON.stringify({id,time,expected,index,state},null,2));throw error;});
  const actual=await page.evaluate(({id,points})=>{
    const r=document.querySelector('.preview-gpu-stage').previewRuntime,n=r.nodes.get(id),c=document.createElement('canvas');c.width=1280;c.height=720;const ctx=c.getContext('2d');ctx.drawImage(n.element,0,0,1280,720);const data=ctx.getImageData(0,0,1280,720).data;
    const samples=points.map(([x,y])=>[...data.slice((y*1280+x)*4,(y*1280+x)*4+4)]);r.snapshot();
    return {presentedTime:n.presentedTime,desired:n.desired,time:n.element.currentTime,url:n.url,proxy:r.proxy,samples};
  },{id,points});assert.equal(actual.proxy,false);assert.ok(actual.url.includes('alpha-proxy.webm'));
  const raw=(await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-c:v','libvpx-vp9','-i',media.proxyPath,'-vf',`select=eq(n\\,${index})`,'-frames:v','1','-fps_mode','passthrough','-pix_fmt','rgba','-f','rawvideo','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:5*1024*1024,timeout:30000})).stdout;
  assert.equal(raw.length,1280*720*4);let maxVisibleError=0;
  for(let n=0;n<points.length;n++){const [x,y]=points[n],offset=(y*1280+x)*4,reference=[...raw.subarray(offset,offset+4)],sample=actual.samples[n];assert.ok(Math.abs(reference[3]-sample[3])<=1);for(let c=0;c<3;c++){const composited=p=>p[c]*p[3]/255+(c===1?255:0)*(1-p[3]/255);maxVisibleError=Math.max(maxVisibleError,Math.abs(composited(reference)-composited(sample)));}}
  assert.ok(maxVisibleError<=5,`Visible proxy decoding mismatch at ${time}: ${maxVisibleError}`);
  seeks.push({time,index,expected,presentedTime:actual.presentedTime,maxVisibleError,id});console.log(`seek ${time.toFixed(3)} frame ${index}, visible error ${maxVisibleError.toFixed(3)}`);return actual;
}
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();await page.evaluate(()=>localStorage.setItem('slu-proxy','false'));await page.reload();await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
  await open(input);
  for(const frame of [0,1786,165,900,363,1357,357])await seek(frame);
  checks.push('Seven forward/backward seeks across the long clip present the exact proxy frame and independently decoded transparent pixels');
  await page.getByRole('button',{name:`${media.name} 소스 열기`,exact:true}).click();await page.locator('.source-monitor .source-view video').waitFor();
  await page.getByLabel('소스 시작점',{exact:true}).fill('45');await page.getByTitle('소스 시작점으로',{exact:true}).click();
  await page.waitForFunction(()=>{const v=document.querySelector('.source-monitor .source-view video');return v?.readyState>=2&&!v.seeking&&Math.abs(v.currentTime-45)<.00001&&v.currentSrc.includes('alpha-proxy.webm');});
  checks.push('Source monitor seeks to45seconds through the mandatory transparent proxy while optional proxies are disabled');
  await select(originalId);await seek(885);await page.keyboard.press('s');let edited=await snapshot(p=>p.clips.length===2),right=edited.clips.find(c=>c.id!==originalId);assert.ok(right);assert.ok(Math.abs(right.start-29.5)<1e-8);assert.ok(Math.abs(right.in-29.5)<1e-8);assert.ok(Math.abs(right.duration-30.1)<1e-8);
  await seek(1357,right.id);await select(right.id);await page.getByRole('button',{name:'배경 제거 해제',exact:true}).click();
  edited=await snapshot(p=>!p.clips.find(c=>c.id===right.id)?.cutout);const restored=edited.clips.find(c=>c.id===right.id);assert.equal(restored.mediaId,initial.clips[0].cutout.sourceMediaId);assert.ok(Math.abs(restored.in-29.7)<1e-8);assert.ok(Math.abs(restored.duration-30.1)<1e-8);assert.ok(edited.clips.find(c=>c.id===originalId).cutout);
  await program();await page.keyboard.press('Control+z');await snapshot(p=>!!p.clips.find(c=>c.id===right.id)?.cutout);await seek(1357,right.id);
  checks.push('Splitting at29.5seconds and restoring only the right clip preserves the exact original29.7second offset; undo restores late transparent playback');
  const saved=path.join(root,'saved.sluproj');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},saved);await page.keyboard.press('Control+Shift+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();
  const serialized=JSON.parse(await fs.readFile(saved,'utf8'));assert.equal(serialized.clips.length,2);assert.ok(serialized.clips.every(c=>!!c.cutout));await open(saved);await seek(1786,right.id);await seek(165,originalId);
  checks.push('Save and reopen retain both split intervals, original links and exact early/late decoded frames');
  await page.getByTitle('오디오 레벨',{exact:true}).click();await page.getByLabel('오디오 레벨 위치',{exact:true}).selectOption('0');await seek(1650,right.id);await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.time()>57,{timeout:15000});const playback=await page.evaluate(()=>({time:document.querySelector('.preview-gpu-stage').previewRuntime.time(),levels:[...document.querySelectorAll('.audio-meter-track')].map(n=>({peak:Number(n.dataset.peak),rms:Number(n.dataset.rms)}))}));await page.keyboard.press('Space');
  assert.equal(playback.levels.length,2);assert.ok(playback.levels.every(c=>c.rms>-50&&c.peak<0),JSON.stringify(playback));checks.push('Actual late playback advances with both stereo channels active');
  await select(right.id);await captureElectron(app,{path:path.join(root,'long-cutout.png')});assert.deepEqual(errors,[]);
  const evidence=await editorEvidence(app,import.meta.url,{matting:true});
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({root,fixture,...evidence,checks,errors,seeks,playback,scope:'Hidden app correctness only; no real-time performance or general human-quality claim'},null,2));
  await fs.writeFile('.test-artifacts/cutout-long-ui-current.txt',root+'\n');
  console.log(JSON.stringify({root,checks,errors}));
}catch(error){await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({root,checks,errors,seeks,error:String(error),project:await current().catch(()=>null)},null,2));throw error;}finally{await app.close();}
