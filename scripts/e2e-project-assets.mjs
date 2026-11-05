import {testExecutable,editorEvidence,verifyEditorBuild} from './e2e-release-evidence.mjs';
import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const root=path.resolve('.test-artifacts/project-assets-ui',Date.now().toString());await fs.mkdir(root,{recursive:true});
const profile=path.join(root,'profile'),env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const fixture=JSON.parse(await fs.readFile('.test-artifacts/motion-render/saved.sluproj','utf8')),input=path.join(root,'input.sluproj');await fs.writeFile(input,JSON.stringify(fixture));
const executable=testExecutable();
const app=await launchTestElectron({executablePath:executable||undefined,args:electronTestArgs(!!executable),env,timeout:90000}),page=await app.firstWindow(),checks=[],errors=[];
page.on('pageerror',error=>errors.push(String(error)));page.on('dialog',dialog=>dialog.accept());
const current=()=>page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project);
async function open(file){await dismissToasts(page);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();await page.waitForFunction(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime;return r.ready()&&r.renderer.hitRegions.some(h=>h.clip.id==='marker');});}
async function capture(time){
  await page.evaluate(time=>{document.querySelector('.preview-gpu-stage').previewRuntime.seek(time);},time);
  await page.waitForFunction(time=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime;return Math.abs(r.evaluationTime()-time)<.00001&&r.ready();},time);
  return page.evaluate(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime;r.snapshot();const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const context=canvas.getContext('2d');context.drawImage(r.renderer.canvas,0,0,320,180);const pixels=context.getImageData(0,0,320,180).data;let x=0,y=0,count=0;for(let i=0;i<320*180;i++)if(pixels[i*4]>200&&pixels[i*4+1]>200&&pixels[i*4+2]>200){x+=i%320;y+=Math.floor(i/320);count++;}return {center:r.renderer.hitRegions.find(h=>h.clip.id==='marker').geometry.center,x:x/count,y:y/count,count,mode:r.renderer.mode};});
}
async function waitJob(id){await page.waitForFunction(id=>window.assetJobs.some(e=>e.id===id&&e.status!=='running'),id,{timeout:120000});return page.evaluate(id=>window.assetJobs.find(e=>e.id===id&&e.status!=='running'),id);}
try{
  const evidence=await editorEvidence(app,import.meta.url);
  await page.locator('.preview-gpu-stage').waitFor({state:'attached'});await page.evaluate(()=>{window.assetJobs=[];window.studio.onJob(e=>window.assetJobs.push(e));});await open(input);
  const before=await current(),baseline=await capture(2),folder=path.join(root,'collected');await fs.mkdir(folder);const output=path.join(folder,'edit.sluproj');
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},output);
  await dismissToasts(page);await page.getByRole('button',{name:'프로젝트',exact:true}).click();await page.getByRole('button',{name:'프로젝트 모아 저장',exact:true}).click();
  await page.waitForFunction(()=>window.assetJobs.some(e=>e.type==='collect'&&e.status!=='running'));
  const completed=await page.evaluate(()=>window.assetJobs.find(e=>e.type==='collect'&&e.status!=='running'));assert.equal(completed.status,'complete',completed.message);await page.getByText('프로젝트와 원본 파일을 모아 저장했습니다.',{exact:true}).first().waitFor();
  const collected=JSON.parse(await fs.readFile(output,'utf8'));assert.equal(collected.fileReferences.length,collected.media.length+collected.motionPaths.length);assert.ok(collected.fileReferences.every(r=>r.relativePath));assert.deepEqual((await current()).clips,before.clips);assert.equal((await current()).media[0].path,before.media[0].path);
  checks.push('File menu collects media and tracking with a completion event, without replacing the active edit session');
  const moved=path.join(root,'moved');await fs.cp(folder,moved,{recursive:true});const movedFile=path.join(moved,'edit.sluproj');await open(movedFile);
  const reopened=await current();assert.ok(reopened.media.every(m=>m.path.startsWith(moved+path.sep)));assert.equal(reopened.motionPaths[0].sourceRevision,reopened.media[0].sourceRevision);assert.notEqual(reopened.media[0].sourceRevision,before.media[0].sourceRevision);assert.deepEqual(reopened.clips,before.clips);
  const after=await capture(2);assert.equal(after.mode,'WebGL2');assert.deepEqual(after.center,baseline.center);assert.ok(Math.abs(after.x-baseline.x)<.01&&Math.abs(after.y-baseline.y)<.01);
  checks.push('Opening a moved collection prefers copied media while the originals still exist; WebGL2 tracking pixels remain identical');
  await page.keyboard.press('Control+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();const resaved=JSON.parse(await fs.readFile(movedFile,'utf8'));assert.ok(resaved.motionPaths[0].path.startsWith(moved+path.sep));assert.ok(resaved.fileReferences.filter(r=>r.kind==='media').every(r=>r.relativePath));
  await open(movedFile);const twice=await capture(2);assert.deepEqual(twice.center,baseline.center);assert.ok(Math.abs(twice.x-baseline.x)<.01);
  checks.push('A regular save stores rebased tracking beside the moved project and survives another reopen');
  await page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.fallback());const cpu=await capture(2);assert.equal(cpu.mode,'CPU');assert.ok(Math.abs(cpu.x-baseline.x)<=1.5&&Math.abs(cpu.y-baseline.y)<=1.5);
  checks.push('CPU compositor uses the same relocated tracking path');
  const video=path.join(root,'collected-output.mp4');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},video);
  const job=await page.evaluate(()=>window.studio.exportProject(document.querySelector('.preview-gpu-stage').previewRuntime.project,{format:'mp4',codec:'h264',encoder:'cpu',quality:'high',width:320,height:180,fps:30}));const exported=await waitJob(job.jobId);assert.equal(exported.status,'complete',exported.message);
  const raw=(await promisify(execFile)(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-i',video,'-an','-pix_fmt','rgb24','-fps_mode','passthrough','-f','rawvideo','pipe:1'],{encoding:'buffer',windowsHide:true,maxBuffer:32*1024*1024})).stdout;assert.equal(raw.length,120*320*180*3);
  for(const frame of [0,30,60,119]){let x=0,y=0,count=0;for(let i=0;i<320*180;i++){const at=(frame*320*180+i)*3;if(raw[at]>200&&raw[at+1]>200&&raw[at+2]>200){x+=i%320;y+=Math.floor(i/320);count++;}}assert.ok(count>20);assert.ok(Math.abs(x/count-(80+frame/3000*320))<2);assert.ok(Math.abs(y/count-(63+frame/6000*180))<2);}
  checks.push('Actual moved-project output contains 120 frames with independently checked tracking centroids within 2 pixels');
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},movedFile);
  const ordered=await page.evaluate(async file=>{const p=document.querySelector('.preview-gpu-stage').previewRuntime.project,job=await window.studio.collectProject({...p,name:'earlier collection'});await window.studio.saveProject({...p,name:'latest manual save'},file);return job.jobId;},movedFile);assert.equal((await waitJob(ordered)).status,'complete');assert.equal(JSON.parse(await fs.readFile(movedFile,'utf8')).name,'latest manual save');
  checks.push('A later manual save waits for the whole collection and wins publication to the same destination');
  const cancelled=path.join(root,'cancelled.sluproj');await fs.writeFile(cancelled,'previous project remains');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},cancelled);
  const cancelledId=await page.evaluate(async()=>{const job=await window.studio.collectProject(document.querySelector('.preview-gpu-stage').previewRuntime.project);await window.studio.cancelJob(job.jobId);return job.jobId;});assert.equal((await waitJob(cancelledId)).status,'cancelled');assert.equal(await fs.readFile(cancelled,'utf8'),'previous project remains');
  checks.push('Collection cancellation preserves the previous destination project');
  assert.deepEqual(errors,[]);await verifyEditorBuild(evidence);await fs.writeFile(path.join(root,'results.json'),JSON.stringify({...evidence,checks,errors,baseline,after,cpu,video},null,2));await fs.writeFile('.test-artifacts/project-assets-ui-current.txt',root);console.log(JSON.stringify({checks:checks.length,errors,root}));
}finally{await app.close();}
