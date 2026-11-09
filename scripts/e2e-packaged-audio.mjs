import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const root=path.resolve('.test-artifacts/packaged-audio'),executable=path.resolve(process.env.SLU_TEST_EXE||'release/win-unpacked/SLU Studio.exe');
const profile=path.join(root,`profile-${Date.now()}`),run=promisify(execFile),checks=[],errors=[],details=[],outputs=new Map();
const digest=data=>createHash('sha256').update(data).digest('hex');
const expectedVersion=JSON.parse(await fs.readFile('package.json','utf8')).version,oracleBytes=await fs.readFile(path.join(root,'oracle.json')),oracle=JSON.parse(oracleBytes);
assert.equal(oracle.version,expectedVersion);assert.equal(digest(await fs.readFile(oracle.source)),oracle.sourceSha256);
for(const [file,hash] of Object.entries(oracle.sourceHashes))assert.equal(digest(await fs.readFile(file)),hash,`Stale source oracle: ${file}`);
const env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
let app,page,version,resources;
try{
  app=await launchTestElectron({executablePath:executable,args:electronTestArgs(true),env,timeout:90000});page=await app.firstWindow();
  page.on('pageerror',error=>errors.push(String(error)));page.on('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
  const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,executable:process.execPath,resources:process.resourcesPath,appPath:app.getAppPath(),version:app.getVersion()}));
  assert.equal(runtime.packaged,true);assert.equal(path.resolve(runtime.executable),executable);assert.ok(runtime.appPath.endsWith('app.asar'));version=runtime.version;resources=runtime.resources;assert.equal(version,expectedVersion);
  checks.push('Actual packaged EXE runs the current ASAR and version');
  const [media]=await page.evaluate(files=>window.studio.importMedia(files),[oracle.source]);assert.equal(media.kind,'video');assert.equal(media.hasAudio,true);
  checks.push('Packaged media-import IPC authorizes and probes the stereo source');
  await page.evaluate(()=>{window.packagedAudioJobs=[];window.packagedAudioOff=window.studio.onJob(event=>window.packagedAudioJobs.push(event));});
  const ffmpeg=path.join(resources,'bin','ffmpeg.exe'),ffprobe=path.join(resources,'bin','ffprobe.exe');
  assert.equal(digest(await fs.readFile(ffmpeg)),oracle.sourceHashes['resources/bin/ffmpeg.exe']);assert.equal(digest(await fs.readFile(path.join(resources,'bin','slu-audio-stretch.exe'))),oracle.sourceHashes['resources/bin/slu-audio-stretch.exe']);
  for(const reference of oracle.reports){
    const projectBytes=await fs.readFile(reference.projectFile),expected=await fs.readFile(reference.pcmFile);assert.equal(digest(projectBytes),reference.projectSha256);assert.equal(digest(expected),reference.pcmSha256);
    const original=JSON.parse(projectBytes),project={...original,media:[media],clips:original.clips.map(c=>({...c,mediaId:media.id}))},output=path.join(root,`${reference.name}.wav`);
    await app.evaluate(({dialog},output)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:output});},output);
    const started=Date.now(),settings={width:320,height:180,fps:30,format:'wav',codec:'h264',encoder:'cpu',quality:'high'};
    const job=await page.evaluate(({project,settings})=>window.studio.exportProject(project,settings),{project,settings});assert.ok(job?.jobId);assert.equal(path.resolve(job.path),output);
    await page.waitForFunction(id=>window.packagedAudioJobs.some(e=>e.id===id&&['complete','error','cancelled'].includes(e.status)),job.jobId,{timeout:120000});
    const event=await page.evaluate(id=>window.packagedAudioJobs.find(e=>e.id===id&&['complete','error','cancelled'].includes(e.status)),job.jobId);assert.equal(event.status,'complete',event.message);
    const probe=JSON.parse((await run(ffprobe,['-v','error','-show_streams','-show_format','-of','json',output],{windowsHide:true,timeout:30000})).stdout);assert.equal(probe.streams.length,1);assert.equal(probe.streams[0].codec_name,'pcm_s24le');assert.equal(probe.streams[0].channels,2);assert.equal(probe.streams[0].sample_rate,'48000');assert.ok(Math.abs(Number(probe.format.duration)-6)<1/48000);
    const pcm=(await run(ffmpeg,['-v','error','-i',output,'-map','0:a:0','-f','f32le','pipe:1'],{windowsHide:true,timeout:30000,encoding:'buffer',maxBuffer:16*1024*1024})).stdout;assert.equal(pcm.length,expected.length);
    let max=0,squares=0,energy=0;for(let i=0;i<pcm.length;i+=4){const actual=pcm.readFloatLE(i),delta=Math.abs(actual-expected.readFloatLE(i));assert.ok(Number.isFinite(actual));max=Math.max(max,delta);squares+=delta*delta;energy+=actual*actual;}
    assert.ok(max<=2/32768,`${reference.name}: PCM error ${max}`);const rms=Math.sqrt(energy/(pcm.length/4));assert.ok(rms>.01);outputs.set(reference.name,pcm);
    details.push({name:reference.name,output,frames:pcm.length/8,channels:2,maxSampleDifference:max,rmsSampleDifference:Math.sqrt(squares/(pcm.length/4)),audioRms:rms,pcmSha256:digest(pcm),expectedSha256:reference.pcmSha256,elapsedSeconds:(Date.now()-started)/1000});
    checks.push(`${reference.name}: real WAV export preserves 288000 stereo frames and matches source PCM within 16-bit quantization`);
  }
  const splitComparisons=[];
  for(const prefix of ['eq','curve']){const a=outputs.get(`${prefix}-single`),b=outputs.get(`${prefix}-split`);let max=0,different=0;for(let i=0;i<a.length;i+=4){const delta=Math.abs(a.readFloatLE(i)-b.readFloatLE(i));max=Math.max(max,delta);if(delta)different++;}assert.ok(max<=(prefix==='eq'?0:1/32768));splitComparisons.push({prefix,maximumSampleDifference:max,differentSamples:different});checks.push(`${prefix}: two editorial splits preserve decoded audio within ${prefix==='eq'?'zero':'one 16-bit quantization step'} sample error`);}
  assert.ok(!outputs.get('flat').equals(outputs.get('eq-single')));assert.ok(!outputs.get('eq-split').equals(outputs.get('changed-middle')));checks.push('EQ and a changed middle-clip EQ affect the exported samples');
  assert.deepEqual(errors,[]);await captureElectron(app,{path:path.join(root,'packaged-app.png')});checks.push('All six packaged exports complete without renderer errors');
  const bundleHashes={asar:digest(await fs.readFile(path.join(resources,'app.asar'))),ffmpeg:digest(await fs.readFile(ffmpeg)),audioStretch:digest(await fs.readFile(path.join(resources,'bin','slu-audio-stretch.exe')))};
  const sourceHashes={...oracle.sourceHashes,'scripts/e2e-packaged-audio.mjs':digest(await fs.readFile('scripts/e2e-packaged-audio.mjs'))};
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({version,executable,recordedAt:new Date().toISOString(),checks,errors,details,splitComparisons,bundleHashes,sourceHashes,oracleSha256:digest(oracleBytes),profile,scope:'Actual packaged IPC/export integration. Source mixer oracle; independent DSP equations and native preview parity are verified separately. Concurrent correctness checks, not isolated performance measurements.'},null,2));console.log(JSON.stringify({version,checks,errors,details,splitComparisons},null,2));
}catch(error){errors.push(String(error));if(app)await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({version,executable,checks,errors,details,profile},null,2));throw error;}
finally{if(app)await app.close();}
