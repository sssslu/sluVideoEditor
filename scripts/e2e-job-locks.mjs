import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve('.test-artifacts/job-locks-ui');await fs.mkdir(root,{recursive:true});
const profile=path.join(root,`profile-${Date.now()}`),env={...process.env,SLU_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(process.env.SLU_TEST_EXE?{executablePath:path.resolve(process.env.SLU_TEST_EXE),args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000}),page=await app.firstWindow(),errors=[],checks=[],findings=[];
let system;
page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
const recovery=path.join(profile,'recovery.sluproj');
async function snapshot(predicate){let last;const begun=Date.now();while(Date.now()-begun<20000){try{last=JSON.parse(await fs.readFile(recovery,'utf8'));if(predicate(last))return last;}catch{}await new Promise(r=>setTimeout(r,75));}throw Error(`Snapshot failed: ${JSON.stringify(last)?.slice(0,1200)}`);}
async function current(){await page.waitForTimeout(850);return JSON.parse(await fs.readFile(recovery,'utf8'));}
async function open(file){await dismissToasts(page);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();await snapshot(p=>p.name===path.basename(file,'.sluproj'));}
async function numeric(name,value){const input=page.getByLabel(name,{exact:true});await input.fill(String(value));await input.press('Enter');}
const row=id=>page.getByLabel(`트랙 이름 ${id}`,{exact:true}).locator('xpath=ancestor::div[contains(@class,"track-row")]');
async function startJob(){await page.locator('[data-clip-id="job-clip"]').click();const section=page.locator('.inspector').getByRole('button',{name:'미디어',exact:true});if(await section.getAttribute('aria-expanded')==='false')await section.click();await page.getByRole('button',{name:'흔들림 보정',exact:true}).click();await page.getByRole('button',{name:'분석 후 적용',exact:true}).click();await page.getByRole('dialog',{name:'흔들림 보정',exact:true}).waitFor({state:'hidden'});return app.evaluate(()=>globalThis.__jobAudit.at(-1).id);}
async function complete(id,media){await app.evaluate(({BrowserWindow},{id,media})=>{BrowserWindow.getAllWindows()[0].webContents.send('job:progress',{id,type:'stabilize',status:'complete',progress:1,message:'controlled completion',media});},{id,media});}
try{
 await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
 system=await page.evaluate(()=>window.studio.getSystemInfo());assert.equal(system.version,JSON.parse(await fs.readFile('package.json','utf8')).version);
 await app.evaluate(({ipcMain})=>{globalThis.__jobAudit=[];ipcMain.removeHandler('media:stabilize');ipcMain.handle('media:stabilize',(_event,media,options)=>{const id=`controlled-${globalThis.__jobAudit.length+1}`;globalThis.__jobAudit.push({id,media,options});return {jobId:id};});});
 const original=path.resolve('examples/01 - Aurora motion.mp4'),derivedPath=path.join(root,'controlled-derived.mp4');await fs.copyFile(original,derivedPath);
 const [asset,derived]=await page.evaluate(paths=>window.studio.importMedia(paths),[original,derivedPath]);
 const template=JSON.parse(await fs.readFile('examples/AURORA.sluproj','utf8'));
 const source={...template.clips.find(c=>c.mediaId),id:'job-clip',mediaId:asset.id,trackId:'video-1',start:.015,in:.137,duration:2,speed:1,fadeIn:0,fadeOut:0,x:0,y:0,keyframes:[],speedCurve:[{position:0,speed:.5},{position:1,speed:1.5}],stabilization:undefined,sourceClipOffset:undefined,sourceClipDuration:undefined};
 const caption={...template.clips.find(c=>c.text!==undefined),id:'locked-caption',trackId:'text-1',start:.023,duration:2,text:'잠금 원문',fadeIn:0,fadeOut:0,keyframes:[]};
 const fixture={...template,version:2,id:'job-locks-project',name:'job-locks',media:[asset],clips:[source,caption],tracks:template.tracks.map(t=>({...t,locked:false})),updatedAt:new Date().toISOString()};
 const file=path.join(root,'job-locks.sluproj'),other=path.join(root,'other-job-project.sluproj');await fs.writeFile(file,JSON.stringify(fixture));await fs.writeFile(other,JSON.stringify({...fixture,id:'other-job-project',name:'other-job-project'}));
 await open(file);await row('text-1').getByTitle('트랙 잠금',{exact:true}).click();await snapshot(p=>p.tracks.find(t=>t.id==='text-1').locked);
 await page.getByRole('button',{name:'자막',exact:true}).first().click();const text=page.getByLabel('자막 내용 locked-caption',{exact:true});
 if(await text.isEditable()){await text.fill('잠금 변경 시도');await text.blur();}
 let p=await current();if(p.clips.find(c=>c.id===caption.id).text!=='잠금 원문')findings.push('Locked caption was changed from the caption library');else checks.push('Locked caption text remains unchanged through the caption library');
 await open(file);await page.locator('[data-clip-id="locked-caption"]').click();await page.locator('[data-clip-id="job-clip"]').click({modifiers:['Shift']});await row('text-1').getByTitle('트랙 잠금',{exact:true}).click();await snapshot(p=>p.tracks.find(t=>t.id==='text-1').locked);
 await page.locator('[data-clip-id="job-clip"]').click({button:'right'});await page.getByRole('menuitem',{name:'양쪽 페이드 0.3초',exact:true}).click();p=await snapshot(p=>p.clips.find(c=>c.id===source.id).fadeIn===.3);
 if(p.clips.find(c=>c.id===caption.id).fadeIn!==0)findings.push('Context fade edited a locked clip in a mixed selected group');else checks.push('Context fade skips locked members of a mixed selection');
 await open(file);await page.locator('[data-clip-id="locked-caption"]').click();await page.locator('[data-clip-id="job-clip"]').click({modifiers:['Shift']});await page.keyboard.press('Alt+ArrowRight');p=await snapshot(p=>p.clips.find(c=>c.id===source.id).start>source.start);
 assert.ok(Math.abs(p.clips.find(c=>c.id===source.id).start-source.start-1/30)<1e-9);assert.ok(Math.abs(p.clips.find(c=>c.id===caption.id).start-p.clips.find(c=>c.id===source.id).start-(caption.start-source.start))<1e-9);checks.push('Actual keyboard nudge preserves fractional starts and group offsets');
 await open(file);let job=await startJob();await numeric('길이',1.5);await snapshot(p=>p.clips.find(c=>c.id===source.id).duration===1.5);await complete(job,derived);
 p=await snapshot(p=>p.media.length===2);assert.equal(p.clips.find(c=>c.id===source.id).mediaId,asset.id);assert.equal(p.clips.find(c=>c.id===source.id).duration,1.5);assert.equal(p.clips.find(c=>c.id===source.id).stabilization,undefined);checks.push('Completion after source-interval edit adds the result only to media');
 await complete(job,derived);p=await current();assert.equal(p.media.length,2);assert.equal(p.clips.find(c=>c.id===source.id).stabilization,undefined);checks.push('Duplicate completion does not reapply a handled job');
 await open(file);job=await startJob();await row('video-1').getByTitle('트랙 잠금',{exact:true}).click();await snapshot(p=>p.tracks.find(t=>t.id==='video-1').locked);await complete(job,derived);p=await snapshot(p=>p.media.length===2);assert.equal(p.clips.find(c=>c.id===source.id).mediaId,asset.id);assert.equal(p.clips.find(c=>c.id===source.id).stabilization,undefined);checks.push('Completion after track lock preserves the original clip');
 await open(file);job=await startJob();await numeric('시작',3);await numeric('위치 X',99);await snapshot(p=>p.clips.find(c=>c.id===source.id).x===99);await complete(job,derived);
 p=await snapshot(p=>!!p.clips.find(c=>c.id===source.id).stabilization);const corrected=p.clips.find(c=>c.id===source.id);assert.equal(corrected.start,3);assert.equal(corrected.x,99);assert.equal(corrected.stabilization.sourceMediaId,asset.id);assert.equal(corrected.mediaId,derived.id);assert.deepEqual(corrected.speedCurve,source.speedCurve);checks.push('Completion preserves newer placement/transform and nonlinear curve while replacing source');
 await open(file);job=await startJob();await open(other);await complete(job,derived);p=await current();assert.equal(p.id,'other-job-project');assert.equal(p.media.length,1);assert.equal(p.clips.find(c=>c.id===source.id).stabilization,undefined);checks.push('Old project completion cannot mutate the newly opened project');
 await captureElectron(app,{path:path.join(root,'review.png')});await fs.writeFile(path.join(root,'results.json'),JSON.stringify({version:system.version,executable:process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null,checks,findings,errors,profile},null,2));console.log(JSON.stringify({checks,findings,errors}));assert.deepEqual(errors,[]);assert.deepEqual(findings,[]);
}catch(error){await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({version:system?.version,executable:process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null,checks,findings,errors,error:String(error),profile},null,2));throw error;}finally{await app.close();}
