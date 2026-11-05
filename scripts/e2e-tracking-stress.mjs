import {testExecutable,editorEvidence,verifyEditorBuild} from './e2e-release-evidence.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {launchTestElectron,captureElectron} from './e2e-launch.mjs';

const root=path.resolve('.test-artifacts/tracking-stress-ui',Date.now().toString());await fs.mkdir(root,{recursive:true});
const fixture=JSON.parse(await fs.readFile('.test-artifacts/tracking-stress-fixtures/fixtures.json','utf8')),media=fixture.cases.find(c=>c.fps===30).media;
const p=JSON.parse(await fs.readFile('.test-artifacts/motion-render/saved.sluproj','utf8'));p.id+='-uhd';p.name='4K 편집 검사';p.width=1920;p.height=1080;p.media=[media];p.clips=[{...p.clips[0],mediaId:media.id,duration:120,in:0,start:0}];p.tracks=p.tracks.filter(t=>t.id===p.clips[0].trackId).map(t=>({...t,hidden:false}));delete p.motionPaths;delete p.fileReferences;
const projectFile=path.join(root,'project.sluproj');await fs.writeFile(projectFile,JSON.stringify(p));
const profile=path.join(root,'profile'),env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
// Normal Chromium flags. Hidden-window timer and input measurements below are
// not a claim about visible playback FPS or total machine memory.
const executable=testExecutable();
const app=await launchTestElectron({executablePath:executable||undefined,args:executable?[]:['.'],env,timeout:90000}),page=await app.firstWindow(),errors=[],checks=[],latencies=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
const box=time=>{const g=fixture.ground[Math.floor(time%4*25)];return {time,box:{x:(g[0]*9+480)/3840,y:g[1]/240,width:g[2]*9/3840,height:g[3]/240}};};
async function terminal(id){await page.waitForFunction(id=>window.stressJobs.some(e=>e.id===id&&e.status!=='running'),id,{timeout:180000});return page.evaluate(id=>window.stressJobs.find(e=>e.id===id&&e.status!=='running'),id);}
try{
  const evidence=await editorEvidence(app,import.meta.url);
  await page.locator('.preview-gpu-stage').waitFor({state:'attached'});
  await app.evaluate(({dialog,utilityProcess},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});globalThis.stressWorkers=[];const fork=utilityProcess.fork;utilityProcess.fork=(...args)=>{const child=fork(...args);child.on('spawn',()=>globalThis.stressWorkers.push({event:'start',pid:child.pid}));child.on('message',m=>{if(m?.type==='backend')globalThis.stressWorkers.push({event:'backend',backend:m.backend});});child.on('exit',code=>globalThis.stressWorkers.push({event:'exit',code}));return child;};},projectFile);
  await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();await page.waitForFunction(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime,v=document.querySelector('.gpu-media-decoders video');return r.ready()&&v?.videoWidth===3840&&v.videoHeight===2160;},null,{timeout:60000});
  assert.equal(await page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.renderer.mode),'WebGL2');checks.push('Normal source app opens and displays the 120-second UHD source using WebGL2');
  await page.evaluate(()=>{window.stressJobs=[];window.studio.onJob(e=>window.stressJobs.push(e));window.stressHeartbeat={ticks:0,maxGap:0,last:performance.now()};window.stressTimer=setInterval(()=>{const h=window.stressHeartbeat,now=performance.now();h.ticks++;h.maxGap=Math.max(h.maxGap,now-h.last);h.last=now;},20);});
  const job=await page.evaluate(({media,anchor})=>window.studio.trackMedia(media,{start:60,duration:20,anchors:[anchor],maxDimension:1280,device:'gpu'}),{media,anchor:box(70)});
  await page.waitForFunction(id=>window.stressJobs.some(e=>e.id===id&&e.status==='running'&&e.progress>.09),job.jobId,{timeout:90000});
  for(let i=0;i<5;i++){
    assert.equal(await page.evaluate(id=>window.stressJobs.filter(e=>e.id===id).at(-1)?.status,job.jobId),'running');
    const start=performance.now(),name=`4K 처리 중 편집 ${i}`;await dismissToasts(page);await page.getByLabel('프로젝트 이름',{exact:true}).fill(name);await page.getByLabel('프로젝트 이름',{exact:true}).blur();await page.waitForFunction(name=>document.querySelector('.preview-gpu-stage').previewRuntime.project.name===name,name);latencies.push(performance.now()-start);
  }
  await page.keyboard.press('Control+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();assert.equal(JSON.parse(await fs.readFile(projectFile,'utf8')).name,'4K 처리 중 편집 4');
  checks.push('Five real editor input changes and a manual save complete while native UHD tracking is still running');
  const result=await terminal(job.jobId);assert.equal(result.status,'complete',result.message);assert.equal(result.tracking.backend,'dml');assert.equal(result.tracking.frames,600);
  const range=await page.evaluate(file=>window.studio.readTrackingPath(file,60,700),result.path);assert.equal(range.samples.length,600);for(let i=0;i<600;i++)assert.ok(Math.abs(range.samples[i].time-(60+i/30))<.000002);
  checks.push('Actual GPU job returns all 600 exact frame times through the registered, paged artifact API');
  const heartbeat=await page.evaluate(()=>{clearInterval(window.stressTimer);return window.stressHeartbeat;});assert.ok(heartbeat.ticks>20);assert.ok(heartbeat.maxGap<1000,`Renderer timer stalled ${heartbeat.maxGap} ms`);assert.ok(Math.max(...latencies)<1500,`Input response ${Math.max(...latencies)} ms`);
  checks.push('Renderer timers and actual input remain responsive during UHD analysis; hidden-window timings are recorded');
  const cancelJob=await page.evaluate(({media,anchor})=>window.studio.trackMedia(media,{start:60,duration:4,anchors:[anchor],maxDimension:1920,device:'gpu'}),{media,anchor:box(62)});
  await page.waitForFunction(id=>window.stressJobs.some(e=>e.id===id&&e.status==='running'&&e.message.includes('뒤 방향')),cancelJob.jobId,{timeout:90000});const cancelling=performance.now();await page.evaluate(id=>window.studio.cancelJob(id),cancelJob.jobId);const cancelled=await terminal(cancelJob.jobId),cancelMs=performance.now()-cancelling;assert.equal(cancelled.status,'cancelled');assert.ok(cancelMs<5000);
  const files=await fs.readdir(path.join(profile,'tracking-derived'));assert.deepEqual(files,[path.basename(result.path)]);checks.push('Cancellation during the 1920-pixel disk-backed reverse pass removes its spool and partial artifact');
  const workers=await app.evaluate(()=>globalThis.stressWorkers);assert.equal(workers.filter(e=>e.event==='start').length,workers.filter(e=>e.event==='exit').length);assert.ok(workers.some(e=>e.backend==='dml'));for(const e of workers.filter(e=>e.event==='start'))assert.throws(()=>process.kill(e.pid,0),{code:'ESRCH'});checks.push('Every native tracking worker has exited, including the cancelled worker');
  await captureElectron(app,{path:path.join(root,'uhd.png')});assert.deepEqual(errors,[]);await verifyEditorBuild(evidence);await fs.writeFile(path.join(root,'results.json'),JSON.stringify({...evidence,scope:'Hidden app with normal Chromium flags; input/timer responsiveness, not visible playback FPS',checks,errors,latencies,heartbeat,cancelMs,workers,result},null,2));await fs.writeFile('.test-artifacts/tracking-stress-ui-current.txt',root);console.log(JSON.stringify({root,checks:checks.length,latencies,maxRendererGap:heartbeat.maxGap,cancelMs,errors}));
}finally{await app.close();}
