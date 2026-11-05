import {testExecutable,editorEvidence,verifyEditorBuild} from './e2e-release-evidence.mjs';
import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve('.test-artifacts/tracking-ipc');await fs.mkdir(root,{recursive:true});
const profile=path.join(root,'profile-'+Date.now()),source=path.join(root,'source-'+Date.now()+'.webm');await fs.copyFile('.build-cache/tracking/samples/david/david.webm',source);
const fixture=JSON.parse(await fs.readFile('.test-artifacts/tracking-fixtures/david.json','utf8')),env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const executable=testExecutable();
const app=await launchTestElectron({executablePath:executable||undefined,args:electronTestArgs(!!executable),env,timeout:90000}),page=await app.firstWindow(),errors=[],checks=[];
page.on('pageerror',error=>errors.push(String(error)));
try{
  const evidence=await editorEvidence(app,import.meta.url);
  await page.locator('.preview-gpu-stage').waitFor({state:'attached'});
  await app.evaluate(({utilityProcess})=>{globalThis.trackingWorkerAudit=[];const fork=utilityProcess.fork;utilityProcess.fork=(...args)=>{const worker=fork(...args);worker.on('spawn',()=>globalThis.trackingWorkerAudit.push({event:'start',pid:worker.pid}));worker.on('message',m=>{if(m?.type==='backend')globalThis.trackingWorkerAudit.push(m);});worker.on('exit',code=>globalThis.trackingWorkerAudit.push({event:'exit',code}));return worker;};});
  await page.evaluate(()=>{window.trackingEvents=[];window.studio.onJob(e=>window.trackingEvents.push(e));});
  const [media]=await page.evaluate(source=>window.studio.importMedia([source]),source),anchor=i=>({time:11.96+i/25,box:{x:fixture.ground[i][0]/320,y:fixture.ground[i][1]/240,width:fixture.ground[i][2]/320,height:fixture.ground[i][3]/240}});
  const awaitJob=async id=>{await page.waitForFunction(id=>window.trackingEvents.some(e=>e.id===id&&e.status!=='running'),id,{timeout:90000});return page.evaluate(id=>window.trackingEvents.find(e=>e.id===id&&e.status!=='running'),id);};
  const options={start:11.96,duration:2,anchors:[anchor(10),anchor(30)],device:'gpu'},job=await page.evaluate(({media,options})=>window.studio.trackMedia(media,options),{media,options}),result=await awaitJob(job.jobId);
  assert.equal(result.status,'complete',result.message);assert.equal(result.tracking.backend,'dml');assert.equal(result.tracking.frames,50);assert.ok(result.path.startsWith(path.join(profile,'tracking-derived')));
  await page.getByText('객체 추적 완료',{exact:true}).last().waitFor();
  const ranges=[];for(const time of [11.96,12.76,13.56])ranges.push(await page.evaluate(({file,time})=>window.studio.readTrackingPath(file,time,20),{file:result.path,time}));
  assert.deepEqual(ranges.map(r=>r.startIndex),[0,20,40]);assert.deepEqual(ranges.map(r=>r.samples.length),[20,20,10]);assert.equal(ranges[2].nextIndex,undefined);
  const rows=ranges.flatMap(r=>r.samples);assert.deepEqual(rows.flatMap((s,i)=>s.anchor?[i]:[]),[10,30]);for(let i=0;i<50;i++)assert.ok(Math.abs(rows[i].time-(11.96+i/25))<.000002);
  checks.push('Actual app IPC runs DirectML tracking, preserves 50 source timestamps and returns bounded pages from its registered artifact');
  const cpuJob=await page.evaluate(({media,options})=>window.studio.trackMedia(media,{...options,device:'cpu'}),{media,options}),cpu=await awaitJob(cpuJob.jobId);
  assert.equal(cpu.status,'complete',cpu.message);assert.equal(cpu.tracking.backend,'cpu');assert.equal(cpu.tracking.frames,50);
  const cpuRows=(await page.evaluate(file=>window.studio.readTrackingPath(file,11.96,100),cpu.path)).samples;
  assert.equal(cpuRows.length,rows.length);
  for(let i=0;i<rows.length;i++){assert.equal(cpuRows[i].time,rows[i].time);for(const key of ['x','y','width','height'])assert.ok(Math.abs(cpuRows[i].box[key]-rows[i].box[key])<=1/320);}
  checks.push('Explicit native CPU tracking runs from the same installed model and agrees with DirectML within one source pixel');
  const rejects=await page.evaluate(async({file,media,options})=>{
    const cases=[()=>window.studio.readTrackingPath(file,0,5000),()=>window.studio.readTrackingPath(media.path,0,20),()=>window.studio.trackMedia({...media,path:media.path+'.unregistered'},options)],errors=[];
    for(const call of cases){try{await call();errors.push(null);}catch(error){errors.push(String(error));}}return errors;
  },{file:result.path,media,options});assert.ok(rejects.every(Boolean));checks.push('Unregistered files, oversized reads and unregistered source requests are rejected');

  const cancel=await page.evaluate(({media,anchor})=>window.studio.trackMedia(media,{start:0,duration:30,anchors:[anchor],device:'gpu'}),{media,anchor:anchor(0)});
  await page.waitForFunction(id=>window.trackingEvents.some(e=>e.id===id&&e.status==='running'&&e.progress>.1),cancel.jobId,{timeout:60000});await page.evaluate(id=>window.studio.cancelJob(id),cancel.jobId);
  assert.equal((await awaitJob(cancel.jobId)).status,'cancelled');const files=await fs.readdir(path.join(profile,'tracking-derived'));assert.deepEqual(files.sort(),[path.basename(result.path),path.basename(cpu.path)].sort());
  checks.push('Actual job cancellation closes the worker/decoder and leaves no partial tracking artifact');
  await fs.utimes(source,new Date(),new Date(Date.now()+10000));const changed=await page.evaluate(async file=>{try{await window.studio.readTrackingPath(file,12,20);return '';}catch(error){return String(error);}},result.path);assert.match(changed,/원본 파일이 변경/);
  checks.push('A source replaced after completion invalidates subsequent path reads');
  const audit=await app.evaluate(()=>globalThis.trackingWorkerAudit);assert.ok(audit.some(e=>e.type==='backend'&&e.backend==='dml'));assert.equal(audit.filter(e=>e.event==='start').length,audit.filter(e=>e.event==='exit').length);for(const event of audit.filter(e=>e.event==='start'))assert.throws(()=>process.kill(event.pid,0),{code:'ESRCH'});
  assert.ok(audit.some(e=>e.type==='backend'&&e.backend==='cpu'));
  assert.deepEqual(errors,[]);await verifyEditorBuild(evidence);await fs.writeFile(path.join(root,'results.json'),JSON.stringify({...evidence,checks,profile,result,cpu,audit,errors},null,2)+'\n');console.log(JSON.stringify({checks:checks.length,frames:rows.length}));
}finally{await app.close();}
