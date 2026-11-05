import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const expectedVersion=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const root=path.resolve('.test-artifacts/editor-boundaries');await fs.mkdir(root,{recursive:true});
const profile=path.join(root,`profile-${Date.now()}`),env={...process.env,SLU_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(process.env.SLU_TEST_EXE?{executablePath:path.resolve(process.env.SLU_TEST_EXE),args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000}),page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(String(e)));
const recovery=path.join(profile,'recovery.sluproj'),checks=[];
async function snapshot(predicate){const start=Date.now();let last;while(Date.now()-start<15000){try{last=JSON.parse(await fs.readFile(recovery,'utf8'));if(predicate(last))return last;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error(`Recovery condition failed: ${JSON.stringify(last)?.slice(0,1000)}`);}
async function numeric(label,value){const field=page.getByLabel(label,{exact:true});await field.fill(String(value));await field.press('Enter');}
async function open(files){await app.evaluate(({dialog},filePaths)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths});},files);}
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();await numeric('너비',64);await numeric('높이',64);
  const short=path.join(root,'short.srt'),long=path.join(root,'overlong.srt');await fs.writeFile(short,'1\n00:00:01,000 --> 00:00:01,001\n짧은 자막\n');await fs.writeFile(long,'1\n00:00:01,000 --> 00:00:02,000\n'+'가'.repeat(20001));
  await page.getByRole('button',{name:'자막',exact:true}).first().click();await open([short]);await page.getByRole('button',{name:'SRT 열기',exact:true}).click();let p=await snapshot(p=>p.clips.length===1);assert.equal(p.clips[0].duration,1/30);assert.equal(p.clips[0].fontSize,4);assert.equal(p.clips[0].text,'짧은 자막');checks.push('1ms subtitle and64px canvas normalize before autosave');
  await open([long]);await page.getByRole('button',{name:'SRT 열기',exact:true}).click();await page.getByText(/최대 20,000자/).waitFor();assert.equal((await snapshot(p=>p.clips.length===1)).clips.length,1);checks.push('Overlong subtitle is rejected visibly without project mutation');
  await page.getByRole('button',{name:'텍스트',exact:true}).first().click();await page.getByRole('button',{name:'텍스트 추가',exact:true}).click();p=await snapshot(p=>p.clips.length===2);assert.equal(p.clips.find(c=>c.text==='텍스트').fontSize,4);checks.push('New text respects minimum font size on64px canvas');
  await page.getByRole('button',{name:'미디어',exact:true}).first().click();await open([path.resolve('examples/01 - Aurora motion.mp4')]);await page.getByRole('button',{name:'가져오기',exact:true}).first().click();await page.getByTitle('01 - Aurora motion.mp4 타임라인에 추가',{exact:true}).click();p=await snapshot(p=>p.clips.length===3);const video=p.clips.find(c=>c.mediaId);
  await numeric('길이',1/30);await snapshot(p=>Math.abs(p.clips.find(c=>c.id===video.id).duration-1/30)<1e-9);await numeric('재생 속도',16);await page.getByRole('alert').filter({hasText:'최소 길이'}).waitFor();assert.equal(await page.getByLabel('재생 속도',{exact:true}).inputValue(),'1');p=await snapshot(p=>p.clips.find(c=>c.id===video.id).speed===1);assert.equal(p.clips.find(c=>c.id===video.id).duration,1/30);checks.push('Invalid16x speed is rejected and numeric draft resets');
  await numeric('길이',1);await numeric('재생 속도',2);await snapshot(p=>p.clips.find(c=>c.id===video.id).duration===.5);await numeric('원본 시작점',12);p=await snapshot(p=>p.clips.find(c=>c.id===video.id).in>11.9);assert.ok(p.clips.find(c=>c.id===video.id).duration>=1/30);checks.push('Source-end edit retains a valid minimum duration');
  await page.keyboard.press('Escape');await numeric('너비',7680);await numeric('높이',7680);p=await snapshot(p=>p.width===7680&&p.height===7680);assert.ok(p.clips.every(c=>c.fontSize>=4&&c.fontSize<=1000));checks.push('Extreme canvas resize remains saveable');
  const saved=path.join(root,'saved.sluproj');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},saved);await page.keyboard.press('Control+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();assert.equal(JSON.parse(await fs.readFile(saved,'utf8')).clips.length,3);assert.deepEqual(errors,[]);
  const system=await page.evaluate(()=>window.studio.getSystemInfo());assert.equal(system.version,expectedVersion,'Unexpected application version');
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({version:system.version,executable,checks,errors,profile},null,2));console.log(JSON.stringify({checks,errors}));
}catch(error){await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText());throw error;}finally{await app.close();}
