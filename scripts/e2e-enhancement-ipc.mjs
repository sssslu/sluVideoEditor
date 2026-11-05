import {editorEvidence,verifyEditorBuild,testExecutable} from './e2e-release-evidence.mjs';
import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// Exercise the actual preload/IPC/job entry points with an uninstalled runtime.
// Successful model execution is covered separately by native enhancement QA.
const root=path.resolve('.test-artifacts/enhancement-ipc',`${Date.now()}-${process.pid}`);
await fs.mkdir(root,{recursive:true});
const pointer=path.resolve(`.test-artifacts/enhancement-ipc-current-${process.env.SLU_TEST_EXE?'packaged':'source'}.txt`);
await fs.rm(pointer,{force:true});
const source=path.join(root,'source.mp4'),profile=path.join(root,'profile');
await promisify(execFile)(path.resolve('resources/bin/ffmpeg.exe'),[
  '-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=64x48:r=10:d=1',
  '-c:v','libx264','-threads','1','-pix_fmt','yuv420p',source,
],{windowsHide:true,timeout:30000});
const executable=testExecutable(),env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({executablePath:executable||undefined,args:electronTestArgs(!!executable),env,timeout:90000});
const page=await app.firstWindow(),checks=[],errors=[];
let result;
page.on('pageerror',error=>errors.push(String(error)));
const terminal=async id=>{
  await page.waitForFunction(id=>window.enhancementEvents.some(event=>event.id===id&&event.status!=='running'),id,{timeout:30000});
  return page.evaluate(id=>window.enhancementEvents.filter(event=>event.id===id),id);
};
const releaseJobs=async(keepHolding=true)=>app.evaluate(keepHolding=>{
  const gate=globalThis.enhancementJobGate;gate.holding=keepHolding;
  for(const task of gate.tasks.splice(0)){clearTimeout(task.timer);gate.schedule(task.callback,0,...task.args);}
  if(!keepHolding)globalThis.setTimeout=gate.schedule;
},keepHolding);
try{
  const evidence=await editorEvidence(app,import.meta.url);
  await page.locator('.preview-gpu-stage').waitFor({state:'attached'});
  await page.evaluate(()=>{window.enhancementEvents=[];window.studio.onJob(event=>window.enhancementEvents.push(event));});
  const [media]=await page.evaluate(file=>window.studio.importMedia([file]),source);
  const ordinary=await page.evaluate(media=>window.studio.enhanceMedia(media,{start:0,duration:1,scale:2,preview:true}),media);
  const ordinaryEvents=await terminal(ordinary.jobId);
  assert.equal(ordinaryEvents.at(-1).status,'error');assert.match(ordinaryEvents.at(-1).message,/먼저 설치/);
  assert.ok(ordinaryEvents.every(event=>event.preview===true));
  checks.push('Unmodified application scheduling runs the actual enhancement entry point and reports an uninstalled engine');
  await app.evaluate(()=>{
    const gate={schedule:globalThis.setTimeout,holding:true,tasks:[],downloads:[]};
    globalThis.enhancementJobGate=gate;
    // Hold the application's existing deferred tasks while real IPC cancels or
    // rejects them. No runtime request can turn a failed test into a download.
    globalThis.setTimeout=function(callback,milliseconds,...args){
      if(milliseconds!==80||!gate.holding)return gate.schedule(callback,milliseconds,...args);
      const timer=gate.schedule(()=>{},3600000);gate.tasks.push({callback,args,timer});return timer;
    };
    globalThis.fetch=async(...args)=>{gate.downloads.push(String(args[0]));throw new Error('Downloads are disabled in the uninstalled-engine IPC test');};
  });
  const info=await page.evaluate(()=>window.studio.enhancementInfo());
  assert.equal(info.installed,false);assert.equal(typeof info.deviceSupported,'boolean');
  assert.ok(info.downloadBytes>10_000_000_000);assert.ok(info.model.startsWith('seedvr2-'));
  checks.push('Actual info IPC reports the pinned engine and a clean uninstalled profile');
  const invalid=await page.evaluate(async media=>{
    const options={start:0,duration:1,scale:2,preview:true};
    const calls=[
      ()=>window.studio.enhanceMedia({...media,path:media.path+'.unregistered'},options),
      ...[{start:-1},{duration:0},{duration:3},{scale:3},{preview:'yes'}].map(change=>()=>window.studio.enhanceMedia(media,{...options,...change})),
    ];
    return Promise.all(calls.map(async call=>{try{await call();return null;}catch(error){return String(error);}}));
  },media);
  assert.equal(invalid.length,6);assert.ok(invalid.every(Boolean));
  checks.push('Unregistered input and five invalid enhancement option combinations fail before job creation');
  const cancelled=await page.evaluate(async media=>{
    const job=await window.studio.enhanceMedia(media,{start:0,duration:1,scale:2,preview:true});
    await window.studio.cancelJob(job.jobId);return job;
  },media);
  await releaseJobs();
  const cancelEvents=await terminal(cancelled.jobId);
  assert.deepEqual(cancelEvents.map(event=>event.status),['cancelled']);
  assert.ok(cancelEvents.every(event=>event.type==='enhance'&&event.preview===true));
  checks.push('Cancellation before the queued task starts emits only the preview-owned cancelled event');
  const exclusive=await page.evaluate(async media=>{
    const first=await window.studio.enhanceMedia(media,{start:0,duration:1,scale:2,preview:true});
    const rejected=[];
    for(const call of [()=>window.studio.enhanceMedia(media,{start:0,duration:1,scale:2}),()=>window.studio.installEnhancementEngine()]){
      try{await call();rejected.push(null);}catch(error){rejected.push(String(error));}
    }
    await window.studio.cancelJob(first.jobId);return {first,rejected};
  },media);
  assert.ok(exclusive.rejected.every(message=>message?.includes('진행 중')));
  await releaseJobs();
  assert.equal((await terminal(exclusive.first.jobId)).at(-1).status,'cancelled');
  checks.push('Full enhancement and runtime installation cannot overlap an active preview job');
  const install=await page.evaluate(async()=>{
    const job=await window.studio.installEnhancementEngine();await window.studio.cancelJob(job.jobId);return job;
  });
  await releaseJobs();
  const installEvents=await terminal(install.jobId);
  assert.deepEqual(installEvents.map(event=>event.status),['cancelled']);
  assert.ok(installEvents.every(event=>event.type==='enhancement-install'&&event.preview===undefined));
  assert.equal(await fs.stat(path.join(profile,'enhancement-runtime')).then(()=>true,()=>false),false);
  checks.push('Cancelling queued installation creates no runtime directory or download');
  const missing=await page.evaluate(media=>window.studio.enhanceMedia(media,{start:0,duration:1,scale:2,preview:true}),media);
  await releaseJobs();
  const missingEvents=await terminal(missing.jobId);
  assert.equal(missingEvents.at(-1).status,'error');assert.match(missingEvents.at(-1).message,/먼저 설치/);
  assert.ok(missingEvents.every(event=>event.preview===true));
  assert.equal(await fs.stat(path.join(profile,'media-derived')).then(()=>true,()=>false),false);
  assert.equal(await fs.stat(path.join(profile,'cache/enhancement-previews')).then(()=>true,()=>false),false);
  checks.push('An uninstalled engine fails with a Korean action message and publishes no preview or derived file');
  const before=await fs.readFile(source);
  await page.evaluate(async path=>{
    await Promise.all([window.studio.discardEnhancementPreview('unknown'),window.studio.discardEnhancementPreview(path)]);
    await window.studio.discardEnhancementPreview('unknown');
  },source);
  assert.deepEqual(await fs.readFile(source),before);
  checks.push('Unknown or source-path-shaped preview IDs are harmless and idempotent');
  assert.deepEqual(await app.evaluate(()=>globalThis.enhancementJobGate.downloads),[]);
  assert.deepEqual(errors,[]);await verifyEditorBuild(evidence);
  result={root,...evidence,checks,errors,profile,info,ordinaryEvents,cancelEvents,installEvents,missingEvents};
}catch(error){
  const events=await page.evaluate(()=>window.enhancementEvents).catch(()=>undefined);
  const gate=await app.evaluate(()=>({holding:globalThis.enhancementJobGate?.holding,pending:globalThis.enhancementJobGate?.tasks.length,downloads:globalThis.enhancementJobGate?.downloads})).catch(()=>undefined);
  await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({checks,errors,events,gate,error:String(error),stack:error.stack},null,2));
  throw error;
}finally{
  await releaseJobs(false).catch(()=>{});
  await app.close();
}
await fs.writeFile(path.join(root,'results.json'),JSON.stringify({...result,passed:true,completedAt:new Date().toISOString()},null,2));
await fs.writeFile(pointer,root+'\n');
console.log(JSON.stringify({root,checks:checks.length,errors}));
