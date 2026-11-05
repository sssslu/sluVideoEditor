import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root=path.resolve('.test-artifacts/stabilization-ui');await fs.mkdir(root,{recursive:true});
const fixtureMedia=path.join(root,'shaky-source.mov');
await promisify(execFile)(path.resolve('resources/bin/ffmpeg.exe'),['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=360x280:rate=30:duration=4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-vf',"crop=320:240:x='20+8*sin(n*2.1)':y='20+7*cos(n*1.61)':exact=1",'-c:v','libx264','-preset','veryfast','-crf','12','-c:a','pcm_f32le','-shortest',fixtureMedia],{windowsHide:true,timeout:60000});
const profile=path.join(root,`profile-${Date.now()}`),env={...process.env,SLU_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(process.env.SLU_TEST_EXE?{executablePath:path.resolve(process.env.SLU_TEST_EXE),args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000});
const page=await app.firstWindow(),errors=[],checks=[];let system;page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
const recovery=path.join(profile,'recovery.sluproj');
async function snapshot(predicate){let last;const begun=Date.now();while(Date.now()-begun<60000){try{last=JSON.parse(await fs.readFile(recovery,'utf8'));if(predicate(last))return last;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error(`Snapshot condition failed: ${JSON.stringify(last)?.slice(0,1400)}`);}
async function open(file){await dismissToasts(page);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();}
async function numeric(name,value){const el=page.getByLabel(name,{exact:true});await el.fill(String(value));await el.press('Enter');}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
  system=await page.evaluate(()=>window.studio.getSystemInfo());assert.equal(system.version,JSON.parse(await fs.readFile('package.json','utf8')).version);
  
  assert.equal(await page.evaluate(()=>Object.hasOwn(window.studio,'downloadVideo')),false);
  const assets=await page.evaluate(file=>window.studio.importMedia([file]),fixtureMedia),asset=assets[0];
  const template=JSON.parse(await fs.readFile('examples/AURORA.sluproj','utf8'));
  const source={...template.clips.find(c=>c.mediaId),id:'stabilization-clip',mediaId:asset.id,trackId:'video-1',start:0,in:.137,duration:2,speed:1,fadeIn:.1,fadeOut:.15,x:17,y:-9,scale:.8,rotation:4,
    speedCurve:[{position:0,speed:.5},{position:.5,speed:2},{position:1,speed:1}],keyframes:[],sourceClipOffset:undefined,sourceClipDuration:undefined};
  const fixture={...template,version:2,id:'stabilization-ui-project',name:'보정 검사',media:[asset],clips:[source],updatedAt:new Date().toISOString()};
  const file=path.join(root,'input.sluproj');await fs.writeFile(file,JSON.stringify(fixture));await open(file);
  await page.locator('[data-clip-id="stabilization-clip"]').click();
  await page.locator('.inspector').getByRole('button',{name:'미디어',exact:true}).click();
  await page.getByRole('button',{name:'흔들림 보정',exact:true}).click();await page.getByRole('dialog',{name:'흔들림 보정'}).waitFor();
  await page.getByLabel('보정 부드러움',{exact:true}).fill('15');await page.getByRole('button',{name:'분석 후 적용',exact:true}).click();
  let p=await snapshot(p=>p.clips[0].stabilization&&p.media.length===2),corrected=p.clips[0],derived=p.media.find(m=>m.id===corrected.mediaId);
  assert.equal(corrected.stabilization.sourceMediaId,asset.id);near(corrected.stabilization.sourceIn,source.in);near(corrected.in,0);
  for(const key of ['start','duration','speed','x','y','scale','rotation','fadeIn','fadeOut','speedCurve'])assert.deepEqual(corrected[key],source[key]);
  assert.ok(derived.path.toLowerCase().startsWith(path.join(profile,'media-derived').toLowerCase()));assert.ok(!derived.path.toLowerCase().startsWith(path.join(profile,'cache').toLowerCase()));
  assert.ok(p.media.some(m=>m.id===asset.id&&m.path===asset.path));checks.push('Real stabilization applies a derived source, preserving nonlinear speed, effects and original media');
  await page.waitForFunction(id=>{const r=document.querySelector('.preview-gpu-stage')?.previewRuntime;return r&&[...r.nodes.values()].some(n=>n.media.id===id&&n.loaded&&n.element.readyState>=2&&!n.element.error);},derived.id,{timeout:30000});
  await page.keyboard.press('Home');await page.keyboard.press('Shift+ArrowRight');await page.waitForTimeout(500);
  const frame=await page.locator('.preview-gpu-stage').evaluate(stage=>{const r=stage.previewRuntime;return{time:r.time(),nodes:[...r.nodes.values()].map(n=>({id:n.media.id,time:n.element.currentTime,error:!!n.element.error}))};});
  near(frame.time,1);assert.ok(frame.nodes.some(n=>n.id===derived.id&&n.time>1&&!n.error));checks.push('Program monitor decodes and seeks the corrected MOV with curved source timing');
  await page.keyboard.press('Control+z');await snapshot(p=>p.clips[0].mediaId===asset.id&&!p.clips[0].stabilization);await page.keyboard.press('Control+Shift+z');await snapshot(p=>!!p.clips[0].stabilization);checks.push('Apply stabilization is one undoable edit');
  await page.locator('[data-clip-id="stabilization-clip"]').click();await numeric('원본 시작점',.2);
  p=await snapshot(p=>Math.abs(p.clips[0].in-.2)<1e-8);const trimmed=p.clips[0];
  await page.getByRole('button',{name:'보정 해제',exact:true}).click();p=await snapshot(p=>!p.clips[0].stabilization&&p.clips[0].mediaId===asset.id);
  near(p.clips[0].in,source.in+trimmed.in);near(p.clips[0].duration,trimmed.duration);assert.deepEqual(p.clips[0].speedCurve,trimmed.speedCurve);checks.push('Disable stabilization after a source trim restores the corresponding original interval');
  await page.keyboard.press('Control+z');await snapshot(p=>!!p.clips[0].stabilization);
  const saved=path.join(root,`saved-${Date.now()}.sluproj`);await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},saved);await page.keyboard.press('Control+Shift+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();assert.ok((await fs.stat(saved)).size>0);await open(saved);
  await page.locator('[data-clip-id="stabilization-clip"]').click();await snapshot(p=>!!p.clips[0].stabilization);checks.push('Saved project reopens with processed source and reversible original reference');
  await page.keyboard.press('Control+c');await page.getByText('1개 클립을 복사했습니다.',{exact:true}).waitFor();await page.keyboard.press('Delete');await snapshot(p=>p.clips.length===0);
  await page.getByTitle(`${asset.name} 미디어 제거`,{exact:true}).click();await snapshot(p=>!p.media.some(m=>m.id===asset.id));
  await page.keyboard.press('Control+v');await page.getByText('복사한 클립의 원본 미디어가 없습니다. 미디어 삭제를 취소한 뒤 붙여넣으세요.',{exact:true}).waitFor();
  assert.equal((await snapshot(p=>p.clips.length===0)).clips.length,0);
  await page.keyboard.press('Control+z');await snapshot(p=>p.media.some(m=>m.id===asset.id));await page.keyboard.press('Control+v');
  p=await snapshot(p=>p.clips.length===1);assert.equal(p.clips[0].stabilization.sourceMediaId,asset.id);checks.push('Clipboard refuses a removed original reference and pastes after undo restores the asset');
  await captureElectron(app,{path:path.join(root,'stabilization.png')});assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({date:new Date().toISOString(),version:system.version,executable:process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null,checks,errors,profile,source:asset.path,derived:derived.path,frame},null,2));console.log(JSON.stringify({checks,errors}));
}catch(error){await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText());throw error;}finally{await app.close();}
