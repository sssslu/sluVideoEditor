import {launchTestElectron} from './e2e-launch.mjs';

import path from 'node:path';
import {promises as fs} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';

const directory=path.resolve('.test-artifacts/video-range/ipc');
await fs.mkdir(directory,{recursive:true});
const work=await fs.mkdtemp(path.join(directory,'run-'));
const source=path.join(work,'variable.mp4'),cancelSource=path.join(work,'cancel.mkv');
const run=promisify(execFile),ffmpeg=path.resolve('resources/bin/ffmpeg.exe');
await run(ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=160x90:r=25:d=2','-vf',"select='lt(n,20)+gte(n,20)*not(mod(n,3))'",'-fps_mode:v','vfr','-enc_time_base:v','filter','-c:v','libx264',source],{windowsHide:true});
await run(ffmpeg,['-v','error','-nostdin','-y','-i',source,'-c','copy',cancelSource],{windowsHide:true});
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const expectedVersion=JSON.parse(await fs.readFile('package.json','utf8')).version;
const profile=path.join(work,'profile'),env={...process.env,SLU_USER_DATA:profile};
delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:[]}:{args:['.']}),env,timeout:90000});
const checks=[],errors=[];
try{
  const page=await app.firstWindow();page.on('pageerror',error=>errors.push(String(error)));
  await page.waitForFunction(()=>typeof window.studio?.analyzeVideoRange==='function');
  const system=await page.evaluate(()=>window.studio.getSystemInfo());assert.equal(system.version,expectedVersion);
  const media=(await page.evaluate(file=>window.studio.importMedia([file]),source))[0];
  assert.equal(media.videoEnd,undefined);assert.ok(Math.abs(media.duration-1.8)<.001);
  const measured=await page.evaluate(async media=>{
    const events=[];const off=window.studio.onJob(event=>{if(event.type==='range')events.push(event);});
    try{
      const result=await window.studio.analyzeVideoRange({...media,duration:99,videoStart:0,videoEnd:99});
      for(let i=0;i<100&&!events.some(event=>event.status==='complete');i++)await new Promise(resolve=>setTimeout(resolve,10));
      return {result,events};
    }finally{off();}
  },media);
  assert.equal(measured.result.id,media.id);assert.equal(measured.result.path,source);
  assert.equal(measured.result.videoStart,0);assert.equal(measured.result.videoEnd,2.04);assert.equal(measured.result.duration,2.04);
  assert.ok(measured.events.some(event=>event.status==='running'));
  assert.ok(measured.events.some(event=>event.status==='complete'&&event.media?.videoEnd===2.04));
  checks.push('Verified VFR range and duration replace untrusted renderer metadata; job running/completion events accompany the Promise result');
  const repeated=await page.evaluate(media=>window.studio.analyzeVideoRange(media),measured.result);
  assert.equal(repeated.videoEnd,2.04);assert.equal(repeated.id,media.id);
  checks.push('Completed range is reusable through the same IPC API');
  const rejected=await page.evaluate(async({media,file})=>{try{await window.studio.analyzeVideoRange({...media,path:file});return false;}catch{return true;}},{media,file:cancelSource});
  assert.equal(rejected,true);checks.push('Unregistered local source is rejected before analysis');
  const cancelAsset=(await page.evaluate(file=>window.studio.importMedia([file]),cancelSource))[0];
  const cancelled=await page.evaluate(async media=>{
    const events=[];let requested=false;
    const off=window.studio.onJob(event=>{if(event.type!=='range')return;events.push(event);if(!requested&&event.status==='running'){requested=true;void window.studio.cancelJob(event.id);}});
    try{
      let message;try{await window.studio.analyzeVideoRange(media);}catch(error){message=String(error);}
      for(let i=0;i<100&&!events.some(event=>event.status==='cancelled');i++)await new Promise(resolve=>setTimeout(resolve,10));
      return {message,events};
    }finally{off();}
  },cancelAsset);
  assert.match(cancelled.message,/취소/);assert.ok(cancelled.events.some(event=>event.status==='cancelled'));
  assert.equal(cancelled.events.some(event=>event.status==='complete'),false);
  checks.push('Registered range job can be cancelled and its Promise rejects without publishing a completed asset');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(directory,'results.json'),JSON.stringify({date:new Date().toISOString(),version:system.version,executable,checks,errors,profile,range:measured.result,events:measured.events,cancelEvents:cancelled.events},null,2));
  console.log('Video range IPC integration passed',checks.length);
}finally{await app.close();}
