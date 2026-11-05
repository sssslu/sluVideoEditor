import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {editorEvidence} from './e2e-release-evidence.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {newClip,newProject} from '../shared/project.ts';

const root=path.resolve('.test-artifacts/cutout-ui',Date.now().toString());await fs.mkdir(root,{recursive:true});
const run=promisify(execFile),source=path.join(root,'인물 영상.mp4');
await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-y','-i',path.resolve('.build-cache/matting/b5.mp4'),'-t','2','-vf','scale=640:360','-an','-c:v','libx264','-preset','fast','-crf','12','-fps_mode','vfr',source],{windowsHide:true,timeout:60000});
const profile=path.join(root,'profile'),env={...process.env,SLU_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000});
const page=await app.firstWindow(),checks=[],errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
const current=()=>page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project);
async function snapshot(predicate){const began=Date.now();let p;while(Date.now()-began<90000){p=await current();if(predicate(p))return p;const last=await page.evaluate(()=>window.__cutoutJobs?.at(-1));if(last?.status==='error')throw Error(last.message);await page.waitForTimeout(75);}throw Error('Snapshot timed out: '+JSON.stringify(p).slice(0,3000));}
async function program(){await dismissToasts(page);if(await page.getByTitle('작업 패널 닫기',{exact:true}).count())await page.getByTitle('작업 패널 닫기',{exact:true}).click();await page.getByRole('button',{name:'프로그램',exact:true}).click();}
async function select(id='cutout-clip'){await program();await page.locator(`[data-clip-id="${id}"]`).click();const section=page.locator('.inspector').getByRole('button',{name:'미디어',exact:true});if(await section.getAttribute('aria-expanded')==='false')await section.click();}
async function open(file){await program();await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();}
async function start(quality='portrait',device='gpu'){await select();await page.getByRole('button',{name:'인물 배경 제거',exact:true}).click();await page.getByRole('dialog',{name:'인물 배경 제거'}).waitFor();await page.getByLabel('배경 제거 품질',{exact:true}).selectOption(quality);await page.getByLabel('배경 제거 처리 장치',{exact:true}).selectOption(device);await page.getByRole('button',{name:'배경 제거',exact:true}).click();}
async function ready(id='cutout-clip'){await page.waitForFunction(id=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime,n=r.nodes.get(id);return n?.loaded&&n.media.id===r.project.clips.find(c=>c.id===id)?.mediaId&&!n.failed&&!n.element.seeking&&n.element.readyState>=2&&n.url.includes('alpha-proxy.webm');},id,{timeout:45000});}
const clip=p=>p.clips.find(c=>c.id==='cutout-clip');
try{
 await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();await page.evaluate(()=>localStorage.setItem('slu-proxy','false'));await page.reload();await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
 await page.evaluate(()=>{window.__cutoutJobs=[];window.studio.onJob(e=>window.__cutoutJobs.push(e));});
 const [asset]=await page.evaluate(file=>window.studio.importMedia([file]),source),p=newProject();p.id='cutout-ui';p.name='배경 제거 검사';p.width=640;p.height=360;p.background='#00ff00';p.media=[asset];p.clips=[{...newClip('video-1',asset),id:'cutout-clip',in:.2,duration:1.2}];
 const input=path.join(root,'input.sluproj');await fs.writeFile(input,JSON.stringify(p));await open(input);await start();
 let edited=await snapshot(p=>!!clip(p)?.cutout);const cut=clip(edited),derived=edited.media.find(m=>m.id===cut.mediaId);assert.equal(cut.cutout.sourceMediaId,asset.id);assert.equal(cut.cutout.sourceIn,.2);assert.equal(derived.hasAlpha,true);assert.ok(derived.proxyPath.endsWith('-alpha-proxy.webm'));assert.equal(cut.in,0);assert.equal(cut.duration,1.2);
 assert.ok((await page.evaluate(()=>window.__cutoutJobs)).some(j=>j.type==='cutout'&&j.message.includes('GPU')));checks.push('Actual UI invokes the GPU worker and applies the exact selected interval with transparent source and proxy');
 await program();await page.keyboard.press('Home');await ready();
 const pixels=await page.evaluate(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime;if(r.proxy)throw Error('Optional proxies must be disabled');r.snapshot();const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');x.drawImage(r.renderer.canvas,0,0,640,360);const d=x.getImageData(0,0,640,360).data;return [[10,180],[350,180]].map(([px,py])=>[...d.slice((py*640+px)*4,(py*640+px)*4+4)]);});
 assert.ok(pixels[0][1]>245&&pixels[0][0]<8&&pixels[0][2]<8,JSON.stringify(pixels));assert.ok(pixels[1][1]<130,JSON.stringify(pixels));checks.push('GPU preview composites transparent background over green while optional proxies are disabled');
 await select();await captureElectron(app,{path:path.join(root,'cutout.png')});
 await program();await page.keyboard.press('Control+z');await snapshot(p=>!clip(p)?.cutout&&clip(p)?.mediaId===asset.id);await page.keyboard.press('Control+Shift+z');await snapshot(p=>!!clip(p)?.cutout);checks.push('Apply is one undoable edit and redo preserves the original link');
 const legacyKey=createHash('sha256').update(`proxy-alpha-source-v3|${derived.sourceRevision}`).digest('hex').slice(0,28),legacyPath=path.join(path.dirname(derived.proxyPath),`${legacyKey}-alpha-proxy.webm`),legacyFile=path.join(root,'legacy-proxy.sluproj');await fs.copyFile(derived.proxyPath,legacyPath);
 const beforeMigration=await current();
 await fs.writeFile(legacyFile,JSON.stringify({...beforeMigration,media:beforeMigration.media.map(m=>m.id===derived.id?{...m,proxyPath:legacyPath}:m)}));
 // Compare persisted edits. JSON legitimately omits unset optional fields.
 const persistedMigration=JSON.parse(await fs.readFile(legacyFile,'utf8'));
 await open(legacyFile);await ready();
 const migrated=await current();
 assert.deepEqual(migrated.clips,persistedMigration.clips);
 assert.equal(migrated.media.find(m=>m.id===derived.id).proxyPath,derived.proxyPath);
 assert.ok((await fs.stat(legacyPath)).size>0);
 checks.push('Opening a legacy timing proxy restores the current transparent cache without changing edits or deleting the previous file');
 await select();await page.getByRole('button',{name:'역재생',exact:true}).click();edited=await snapshot(p=>!!clip(p)?.reversal&&!!clip(p)?.cutout);assert.ok(edited.media.find(m=>m.id===clip(edited).mediaId).proxyPath?.endsWith('-alpha-proxy.webm'));await ready();
 await select();await page.getByRole('button',{name:'흔들림 보정',exact:true}).click();await page.getByRole('dialog',{name:'흔들림 보정'}).waitFor();assert.equal(await page.getByLabel('보정 가장자리 처리',{exact:true}).locator('option[value="black"]').textContent(),'투명 여백');await page.getByLabel('보정 가장자리 처리',{exact:true}).selectOption('black');await page.getByLabel('보정 부드러움',{exact:true}).fill('15');await page.getByRole('button',{name:'분석 후 적용',exact:true}).click();
 edited=await snapshot(p=>!!clip(p)?.stabilization&&!!clip(p)?.reversal&&!!clip(p)?.cutout);assert.ok(edited.media.find(m=>m.id===clip(edited).mediaId).proxyPath?.endsWith('-alpha-proxy.webm'));await ready();await page.locator('.gpu-issues').waitFor({state:'detached'});assert.equal(edited.media.find(m=>m.id===clip(edited).mediaId).hasAlpha,true);assert.ok(Math.abs(edited.media.find(m=>m.id===clip(edited).mediaId).duration-1.2)<1e-6);checks.push('Real stabilization after cutout and reverse publishes ready proxies and preserves transparency and duration without false preview errors');
 await program();await page.keyboard.press('Home');await ready();const stabilizedCorner=await page.evaluate(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime;r.snapshot();const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');x.drawImage(r.renderer.canvas,0,0,640,360);return [...x.getImageData(10,180,1,1).data];});assert.ok(stabilizedCorner[1]>245&&stabilizedCorner[0]<8&&stabilizedCorner[2]<8,JSON.stringify(stabilizedCorner));await select();await captureElectron(app,{path:path.join(root,'cutout-stabilized.png')});
 await program();await page.keyboard.press('Control+z');await snapshot(p=>!clip(p)?.stabilization&&!!clip(p)?.cutout&&!!clip(p)?.reversal);await page.keyboard.press('Control+Shift+z');await snapshot(p=>!!clip(p)?.stabilization);await ready();checks.push('Transparent stabilization is one undoable edit');
 await select();await page.getByRole('button',{name:'배경 제거·이후 처리 해제',exact:true}).click();edited=await snapshot(p=>!clip(p)?.cutout&&!clip(p)?.reversal&&!clip(p)?.stabilization);assert.equal(clip(edited).mediaId,asset.id);assert.ok(Math.abs(clip(edited).in-.2)<1e-6);checks.push('Cutout removal after actual reverse and stabilization restores the original source interval');
 await program();await page.keyboard.press('Control+z');await snapshot(p=>!!clip(p)?.cutout&&!!clip(p)?.reversal&&!!clip(p)?.stabilization);
 const saved=path.join(root,'saved.sluproj');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},saved);await page.keyboard.press('Control+Shift+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();const serialized=JSON.parse(await fs.readFile(saved,'utf8'));assert.equal(serialized.version,10);await open(saved);await snapshot(p=>!!clip(p)?.cutout&&!!clip(p)?.reversal&&!!clip(p)?.stabilization);await ready();checks.push('Actual save/reopen retains format9 nested source provenance and transparent playback');
 // Collection drops proxy paths. Reopening must rebuild the required browser
 // representation, rather than leave the FFV1 source permanently unplayable.
 const collected=path.join(root,'collected.sluproj');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},collected);const result=await page.evaluate(p=>window.studio.collectProject(p),serialized);assert.ok(result);
 await page.waitForFunction(id=>window.__cutoutJobs.some(j=>j.id===id&&j.status!=='running'),result.jobId,{timeout:60000});assert.equal((await page.evaluate(id=>window.__cutoutJobs.findLast(j=>j.id===id),result.jobId)).status,'complete');
 const collection=JSON.parse(await fs.readFile(collected,'utf8'));assert.ok(collection.media.every(m=>!m.proxyPath));await open(collected);await ready();await page.locator('.gpu-issues').waitFor({state:'detached'});checks.push('Collected project rebuilds required proxies and clears recovered decoder errors');
 const output=path.join(root,'composed.mp4');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},output);
 const exportJob=await page.evaluate(p=>window.studio.exportProject(p,{width:640,height:360,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'high'}),await current());assert.ok(exportJob);
 await page.waitForFunction(id=>window.__cutoutJobs.some(j=>j.id===id&&j.status!=='running'),exportJob.jobId,{timeout:60000});assert.equal((await page.evaluate(id=>window.__cutoutJobs.findLast(j=>j.id===id),exportJob.jobId)).status,'complete');
 const exported=Buffer.from((await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-i',output,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:2*1024*1024})).stdout),corner=[...exported.subarray((180*640+10)*3,(180*640+10)*3+3)];assert.ok(corner[1]>245&&corner[0]<8&&corner[2]<8,JSON.stringify(corner));checks.push('Actual project export preserves the reversed cutout transparency over the timeline background');
 for(const type of ['reverse','stabilize']){
  const directory=path.join(profile,'media-derived'),before=(await fs.readdir(directory)).sort();
  await page.evaluate(type=>{window.__cancelPreview=window.studio.onJob(e=>{if(e.type===type&&e.status==='running'&&e.message==='투명 영상 미리보기 준비 중')void window.studio.cancelJob(e.id);});},type);
  const task=await page.evaluate(({type,media})=>window.studio[type==='reverse'?'reverseMedia':'stabilizeMedia'](media,{start:0,duration:1.2}),{type,media:derived});
  // Processing must reach the cancellation point before its response deadline
  // starts. Competing CPU/GPU work can lengthen the preceding stabilization.
  await page.waitForFunction(id=>window.__cutoutJobs.some(j=>j.id===id&&(j.message==='투명 영상 미리보기 준비 중'||j.status!=='running')),task.jobId,{timeout:90000});
  assert.ok((await page.evaluate(()=>window.__cutoutJobs)).some(j=>j.id===task.jobId&&j.message==='투명 영상 미리보기 준비 중'));
  await page.waitForFunction(id=>window.__cutoutJobs.some(j=>j.id===id&&j.status==='cancelled'),task.jobId,{timeout:15000});
  await page.evaluate(()=>{window.__cancelPreview();delete window.__cancelPreview;});
  assert.deepEqual((await fs.readdir(directory)).sort(),before);
  checks.push(`${type}: cancellation during required preview creation removes the unpublished derived video`);
 }
 await open(input);await start();await page.getByTitle('작업 취소',{exact:true}).first().click();await page.waitForFunction(()=>window.__cutoutJobs.filter(j=>j.type==='cutout').at(-1)?.status==='cancelled',null,{timeout:15000});assert.equal(clip(await current()).cutout,undefined);checks.push('Cancelling actual UI processing leaves the source clip unchanged');
 await open(input);await start('precision');
 edited=await snapshot(p=>clip(p)?.cutout?.quality==='precision');await ready();
 const preciseMedia=edited.media.find(media=>media.id===clip(edited).mediaId);
 assert.equal(preciseMedia.hasAlpha,true);assert.equal(preciseMedia.codec,'ffv1');
 assert.ok(preciseMedia.proxyPath.endsWith('-alpha-proxy.webm'));
 await select();await captureElectron(app,{path:path.join(root,'cutout-resnet50.png')});
 checks.push('ResNet50 selection creates a transparent native source and ready required proxy through the actual GPU UI workflow');
 const preciseSave=path.join(root,'resnet50.sluproj');
 await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},preciseSave);
 await program();await page.keyboard.press('Control+Shift+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();
 assert.equal(clip(JSON.parse(await fs.readFile(preciseSave,'utf8'))).cutout.quality,'precision');
 await open(preciseSave);await snapshot(p=>clip(p)?.cutout?.quality==='precision');await ready();
 await select();await page.getByRole('button',{name:'배경 제거 해제',exact:true}).click();
 await snapshot(p=>!clip(p)?.cutout&&clip(p)?.mediaId===asset.id);
 await program();await page.keyboard.press('Control+z');await snapshot(p=>clip(p)?.cutout?.quality==='precision');await ready();
 checks.push('ResNet50 setting survives actual save/reopen, source restoration and undo');
 await open(input);await start('precision','cpu');
 edited=await snapshot(p=>clip(p)?.cutout?.quality==='precision');await ready();
 const preciseCpuMedia=edited.media.find(media=>media.id===clip(edited).mediaId);
 assert.notEqual(preciseCpuMedia.path,preciseMedia.path);
 const preciseCpuEvents=await page.evaluate(()=>window.__cutoutJobs.filter(event=>event.type==='cutout'));
 const preciseCpuId=preciseCpuEvents.findLast(event=>event.status==='complete').id;
 assert.ok(preciseCpuEvents.some(event=>event.id===preciseCpuId&&event.message.includes('CPU')));
 checks.push('Explicit ResNet50 CPU selection completes through the actual editor and presents its transparent proxy');
 await open(input);
 await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('media:cutout');ipcMain.handle('media:cutout',()=>({jobId:'controlled-cutout'}));});await start();await select();const sourceIn=page.getByLabel('원본 시작점',{exact:true});await sourceIn.fill('.3');await sourceIn.press('Enter');await snapshot(p=>Math.abs(clip(p).in-.3)<1e-6);
 await app.evaluate(({BrowserWindow},media)=>BrowserWindow.getAllWindows()[0].webContents.send('job:progress',{id:'controlled-cutout',type:'cutout',status:'complete',progress:1,message:'controlled completion',media}),derived);
 edited=await snapshot(p=>p.media.some(m=>m.id===derived.id));assert.equal(clip(edited).cutout,undefined);assert.equal(clip(edited).mediaId,asset.id);assert.ok(Math.abs(clip(edited).in-.3)<1e-6);checks.push('Late completion cannot overwrite a source interval edited while processing');
 await app.evaluate(({ipcMain})=>{globalThis.__cutoutAudit=[];ipcMain.removeHandler('media:cutout');ipcMain.handle('media:cutout',(_event,media,options)=>{const id=`cutout-guard-${globalThis.__cutoutAudit.length}`;globalThis.__cutoutAudit.push({id,media,options});return {jobId:id};});});
 const controlledStart=async()=>{await start();await page.getByRole('dialog',{name:'인물 배경 제거'}).waitFor({state:'hidden'});return app.evaluate(()=>globalThis.__cutoutAudit.at(-1).id);};
 const complete=async id=>app.evaluate(({BrowserWindow},{id,media})=>BrowserWindow.getAllWindows()[0].webContents.send('job:progress',{id,type:'cutout',status:'complete',progress:1,message:'controlled completion',media}),{id,media:derived});
 const numeric=async(label,value)=>{const input=page.getByLabel(label,{exact:true});await input.fill(String(value));await input.press('Enter');};
 const row=id=>page.getByLabel(`트랙 이름 ${id}`,{exact:true}).locator('xpath=ancestor::div[contains(@class,"track-row")]');
 await open(input);let job=await controlledStart();await program();await row('video-1').getByTitle('트랙 잠금',{exact:true}).click();await snapshot(p=>p.tracks.find(t=>t.id==='video-1').locked);await complete(job);
 edited=await snapshot(p=>p.media.some(m=>m.id===derived.id));assert.equal(clip(edited).mediaId,asset.id);assert.equal(clip(edited).cutout,undefined);assert.equal(edited.tracks.find(t=>t.id==='video-1').locked,true);checks.push('Cutout completion after a track lock adds media without changing the locked clip');
 await program();await page.keyboard.press('Control+z');edited=await snapshot(p=>!p.media.some(m=>m.id===derived.id));assert.equal(edited.tracks.find(t=>t.id==='video-1').locked,true);assert.equal(clip(edited).mediaId,asset.id);checks.push('Undoing a deferred library-only cutout preserves the newer track lock');
 await open(input);job=await controlledStart();await select();await page.keyboard.press('Delete');await snapshot(p=>!clip(p));await complete(job);edited=await snapshot(p=>p.media.some(m=>m.id===derived.id));assert.equal(clip(edited),undefined);checks.push('Cutout completion cannot resurrect a clip deleted during processing');
 const curved={...p,clips:[{...p.clips[0],speedCurve:[{position:0,speed:.8},{position:1,speed:1.2}]}]},curveFile=path.join(root,'curved.sluproj');await fs.writeFile(curveFile,JSON.stringify(curved));await open(curveFile);job=await controlledStart();await select();await numeric('시작',2);await numeric('위치 X',79);await snapshot(p=>clip(p).start===2&&clip(p).x===79);await complete(job);
 edited=await snapshot(p=>!!clip(p)?.cutout);assert.equal(clip(edited).start,2);assert.equal(clip(edited).x,79);assert.deepEqual(clip(edited).speedCurve,curved.clips[0].speedCurve);const applied=JSON.stringify(edited);checks.push('Cutout application preserves newer placement and the existing nonlinear speed curve');
 await complete(job);await page.waitForTimeout(150);assert.equal(JSON.stringify(await current()),applied);checks.push('Duplicate cutout completion cannot create another edit or media entry');
 for(const mode of ['same-project','different-project']){
  await open(input);job=await controlledStart();const next=mode==='same-project'?input:path.join(root,'other.sluproj');if(mode==='different-project')await fs.writeFile(next,JSON.stringify({...p,id:'other-cutout-project',name:'Other project'}));await open(next);await dismissToasts(page);await complete(job);await page.getByText('작업이 완료되었지만 프로젝트 또는 원본이 변경되어 적용하지 않았습니다.',{exact:true}).waitFor();
  edited=await current();assert.equal(clip(edited).mediaId,asset.id);assert.equal(clip(edited).cutout,undefined);assert.equal(edited.media.some(m=>m.id===derived.id),false);checks.push(`Cutout completion is ignored after ${mode} reopen, including media-library mutation`);
 }
 assert.deepEqual(errors,[]);
 const evidence=await editorEvidence(app,import.meta.url,{matting:true});
 await fs.writeFile(path.join(root,'results.json'),JSON.stringify({root,...evidence,checks,errors,pixels,profile},null,2));
 await fs.writeFile('.test-artifacts/cutout-ui-current.txt',root+'\n');
 console.log(JSON.stringify({root,checks,errors}));
}catch(error){await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({root,checks,errors,error:String(error),project:await current().catch(()=>null),jobs:await page.evaluate(()=>window.__cutoutJobs).catch(()=>null)},null,2));console.error((await page.locator('body').innerText()).slice(-4000));throw error;}finally{await app.close();}
