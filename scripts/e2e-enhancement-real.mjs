import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {editorEvidence,verifyEditorBuild,testExecutable,hashFile} from './e2e-release-evidence.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {newProject,newClip} from '../shared/project.ts';
import {assertProject} from '../shared/validation.ts';
import {enhancementInventoryDigest} from '../electron/enhancement-install.ts';
import {sourceRevisionFromStat} from '../electron/source-revision.ts';
import {prepareTrackingInput} from '../electron/tracking-source.ts';
import {verifyVideoSelection} from '../electron/video-selection.ts';
import {decodeTrackingFrames} from '../electron/tracking-decode.ts';
import {promises as fs,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';

// This suite uses the production installer, preload, main handlers and model.
// It must run inside the private desktop after native inference approval.
const root=path.resolve('.test-artifacts/enhancement-real',`${Date.now()}-${process.pid}`);
const pointer=path.resolve(`.test-artifacts/enhancement-real-current-${process.env.SLU_TEST_EXE?'packaged':'source'}.txt`);
await fs.mkdir(root,{recursive:true});await fs.rm(pointer,{force:true});
const profile=path.resolve('.test-artifacts/enhancement-real-profile');
const payloadRoot=path.resolve('.build-cache/enhancement/payloads');
const resourceRoot=path.resolve('native/enhancement'),manifestFile=path.join(resourceRoot,'backend-manifest.json');
const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8')),manifestSha256=await hashFile(manifestFile);
const workerSha256=await hashFile(path.join(resourceRoot,'seedvr_worker.py'));
const nativeFiles=['seedvr_worker.py','tensor_loader.py','backend-manifest.json','worker-contract.json','requirements-lock.txt'];
for(const filename of await fs.readdir(path.join(resourceRoot,'licenses')))nativeFiles.push('licenses/'+filename);
const nativeSourceHashes=Object.fromEntries(await Promise.all(nativeFiles.map(async file=>[file,await hashFile(path.join(resourceRoot,file))])));
const runtimeRoot=path.join(profile,'enhancement-runtime',manifestSha256);
const previewRoot=path.join(profile,'cache','enhancement-previews');
const run=promisify(execFile),jobTimeout=30*60*1000;
const sourceWidth=960,sourceHeight=540,outputWidth=1920,outputHeight=1080,fps=10,duration=1.5,frameCount=15;
const proxyWidth=1280,proxyHeight=720;
await fs.mkdir(root,{recursive:true});await fs.mkdir(profile,{recursive:true});
const priorRecovery=await fs.readFile(path.join(profile,'recovery.sluproj'),'utf8').then(text=>JSON.parse(text).clips?.length>0).catch(error=>{if(error.code==='ENOENT')return false;throw error;});
const sourceFile=path.join(root,'source.mov'),auditFile=path.join(root,'native-audit.jsonl');
await fs.writeFile(auditFile,'');
await run(path.resolve('resources/bin/ffmpeg.exe'),[
  '-v','error','-nostdin','-y','-f','lavfi','-i',`testsrc2=s=${sourceWidth}x${sourceHeight}:r=${fps}:d=${duration}`,
  '-f','lavfi','-i',`sine=frequency=997:sample_rate=48000:duration=${duration}`,
  '-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','pcm_f32le','-t',String(duration),sourceFile,
],{windowsHide:true,timeout:30000});
const sourceSha256=await hashFile(sourceFile),executable=testExecutable();
const env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({executablePath:executable||undefined,args:electronTestArgs(!!executable),env,timeout:90000});
const page=await app.firstWindow(),checks=[],errors=[],jobs=[],archiveEvidence=[];
let evidence,runtimeEvidence,closed=false,previewResult,fullResult,cancelJob,shutdownJob,result;
page.on('pageerror',error=>errors.push(String(error)));
const current=()=>page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project);
const editedClip=async()=>(await current()).clips.find(clip=>clip.id==='actual-enhancement');
const exists=async file=>fs.stat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const children=async directory=>fs.readdir(directory).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
const inside=(file,directory)=>{const relative=path.relative(path.resolve(directory),path.resolve(file));return !!relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

async function provisionDownloads(){
  const cache=path.join(profile,'enhancement-runtime','downloads');await fs.mkdir(cache,{recursive:true});
  for(const artifact of manifest.artifacts){
    assert.equal(path.basename(artifact.filename),artifact.filename);assert.match(artifact.sha256,/^[a-f0-9]{64}$/);
    const source=path.join(payloadRoot,artifact.filename),target=path.join(cache,artifact.sha256);
    const stat=await fs.lstat(source);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.size,artifact.bytes);
    assert.equal(await hashFile(source),artifact.sha256,`Payload checksum ${artifact.id}`);
    let method='existing-verified-cache';
    if(!await exists(target)){
      try{await fs.link(source,target);method='archive-hardlink';}
      catch(error){if(error.code!=='EXDEV')throw error;await fs.copyFile(source,target,constants.COPYFILE_EXCL);method='archive-copy';}
    }
    const copied=await fs.lstat(target);assert.ok(copied.isFile()&&!copied.isSymbolicLink());assert.equal(copied.size,artifact.bytes);
    assert.equal(await hashFile(target),artifact.sha256,`Installer cache checksum ${artifact.id}`);
    archiveEvidence.push({id:artifact.id,source,target,bytes:copied.size,sha256:artifact.sha256,method});
  }
  await fs.writeFile(path.join(root,'download-cache.json'),JSON.stringify(archiveEvidence,null,2));
}

async function runtimeFiles(directory=runtimeRoot){
  const files=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name),stat=await fs.lstat(file);assert.equal(stat.isSymbolicLink(),false);
    if(stat.isDirectory())files.push(...await runtimeFiles(file));
    else{assert.equal(stat.isFile(),true);files.push(path.relative(runtimeRoot,file).replaceAll('\\','/'));}
  }
  return files.sort();
}
async function runtimeInventory(before){
  const registryFile=path.join(runtimeRoot,'.complete.json'),registryBytes=await fs.readFile(registryFile),registry=JSON.parse(registryBytes.toString('utf8'));
  const registryStat=await fs.lstat(registryFile);assert.ok(registryStat.isFile()&&!registryStat.isSymbolicLink());
  const registrySha256=digest(registryBytes),registryRevision=sourceRevisionFromStat(registryFile,registryStat);
  assert.equal(registry.version,1);assert.equal(registry.manifestSha256,manifestSha256);assert.equal(enhancementInventoryDigest(registry.files),manifest.expectedInstalledFilesSha256);
  assert.deepEqual(await runtimeFiles(),['.complete.json',...registry.files.map(record=>record.path)].sort());
  if(before){assert.equal(registrySha256,before.registrySha256);assert.equal(registryRevision,before.registryRevision);}
  const files=[];
  for(const record of registry.files){
    const file=path.resolve(runtimeRoot,record.path);assert.ok(inside(file,runtimeRoot));
    const stat=await fs.lstat(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink());assert.equal(stat.size,record.bytes);
    const revision=sourceRevisionFromStat(file,stat);assert.equal(revision,record.revision,`Installed runtime identity ${record.path}`);
    // Before inference validate bytes. Afterward require the same registry and
    // file identity for every entry, including size, times and Windows file ID.
    const sha256=before?record.sha256:await hashFile(file);assert.equal(sha256,record.sha256,`Installed runtime checksum ${record.path}`);
    assert.equal(sourceRevisionFromStat(file,await fs.lstat(file)),revision,`Runtime changed during inspection ${record.path}`);
    files.push({path:record.path,bytes:stat.size,sha256,revision});
  }
  const inventory={manifestSha256,workerSha256,runtimeRoot,registrySha256,registryRevision,installedFilesSha256:enhancementInventoryDigest(files),files};
  if(before)assert.deepEqual(inventory,before,'Installed runtime changed during actual inference');
  await fs.writeFile(path.join(root,before?'runtime-after.json':'runtime.json'),JSON.stringify(inventory,null,2));return inventory;
}

async function verifyNativeSources(){
  for(const [file,sha256] of Object.entries(nativeSourceHashes)){
    assert.equal(await hashFile(path.join(resourceRoot,file)),sha256,`Native source changed ${file}`);
    if(executable)assert.equal(await hashFile(path.join(evidence.runtime.resources,'enhancement',file)),sha256,`Packaged native source differs ${file}`);
  }
}

async function waitForActiveWorker(id,nativeBefore){
  const until=Date.now()+jobTimeout;
  while(Date.now()<until){
    const events=await page.evaluate(id=>window.actualEnhancementEvents.filter(event=>event.id===id),id);
    assert.ok(!events.some(event=>event.status!=='running'),'Fixture completed before cancellation could be exercised');
    const native=await app.evaluate((_electron,start)=>globalThis.actualEnhancementAudit.children.slice(start),nativeBefore);
    const worker=native.find(child=>path.basename(child.command).toLowerCase()==='python.exe');
    if(worker){
      const argument=worker.args.indexOf('--job-dir'),directory=worker.args[argument+1];
      assert.ok(argument>=0&&inside(directory,previewRoot));assert.ok(await exists(directory));
      return {worker,directory};
    }
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Error('Actual Python worker was not observed before cancellation');
}

async function terminal(id){
  await page.waitForFunction(id=>window.actualEnhancementEvents.some(event=>event.id===id&&event.status!=='running'),id,{timeout:jobTimeout});
  const events=await page.evaluate(id=>window.actualEnhancementEvents.filter(event=>event.id===id),id);jobs.push({id,events});
  await fs.writeFile(path.join(root,'jobs.json'),JSON.stringify(jobs,null,2));return events;
}
const successful=events=>{assert.equal(events.at(-1)?.status,'complete',JSON.stringify(events.at(-1)));return events.at(-1).media;};
async function cleanUI(){await dismissToasts(page);if(await page.getByTitle('작업 패널 닫기',{exact:true}).count())await page.getByTitle('작업 패널 닫기',{exact:true}).click();}
async function openProject(file,id){await cleanUI();await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');await page.waitForFunction(id=>document.querySelector('.preview-gpu-stage').previewRuntime.project.id===id,id);await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();await cleanUI();}
async function selectClip(){await cleanUI();await page.locator('[data-clip-id="actual-enhancement"]').focus();await page.locator('[data-clip-id="actual-enhancement"]').press('Enter');const section=page.locator('.inspector').getByRole('button',{name:'미디어',exact:true});if(await section.getAttribute('aria-expanded')==='false')await section.click();}
async function urlStatus(file){
  const url=await page.evaluate(file=>window.studio.mediaUrl(file),file);
  // Renderer CSP permits media playback, not fetch. Check protocol permissions
  // through Electron; playable() independently checks the normal video element.
  return app.evaluate(async({net},url)=>(await net.fetch(url,{method:'HEAD'})).status,url);
}
async function playable(file){
  return page.evaluate(async file=>{
    const video=document.createElement('video');video.muted=true;video.preload='auto';
    try{return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Processed proxy did not decode')),60000);
      video.onloadeddata=()=>{clearTimeout(timer);resolve({width:video.videoWidth,height:video.videoHeight,duration:video.duration,readyState:video.readyState});};
      video.onerror=()=>{clearTimeout(timer);reject(Error('Processed proxy decode error '+video.error?.code));};
      video.src=window.studio.mediaUrl(file);video.load();
    });}finally{video.pause();video.removeAttribute('src');video.load();}
  },file);
}
async function inspectPixels(file,expected){
  const frameBytes=outputWidth*outputHeight*4,expectedBytes=frameBytes*expected.frameCount;
  const child=spawn(path.resolve('resources/bin/ffmpeg.exe'),[
    '-v','error','-nostdin','-i',file,'-map','0:v:0','-fps_mode','passthrough',
    '-threads','1','-pix_fmt','bgra','-f','rawvideo','pipe:1',
  ],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let nativeError,stderr='',timedOut=false,bytes=0,frameOffset=0;
  let frameHash=createHash('sha256');const hash=createHash('sha256'),frames=[];
  child.on('error',error=>{nativeError=error;});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-8000);});
  const completion=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  const timer=setTimeout(()=>{timedOut=true;child.kill();},120000);
  try{
    for await(const chunk of child.stdout){
      assert.ok(bytes+chunk.length<=expectedBytes,'Decoded output exceeds the expected frame count');
      for(let offset=(3-bytes%4+4)%4;offset<chunk.length;offset+=4){
        if(chunk[offset]!==255)throw Error('Processed output contains a nonopaque pixel');
      }
      hash.update(chunk);
      for(let offset=0;offset<chunk.length;){
        const count=Math.min(frameBytes-frameOffset,chunk.length-offset);
        frameHash.update(chunk.subarray(offset,offset+count));offset+=count;frameOffset+=count;
        if(frameOffset===frameBytes){frames.push({index:frames.length,sha256:frameHash.digest('hex')});frameHash=createHash('sha256');frameOffset=0;}
      }
      bytes+=chunk.length;
    }
    const exit=await completion;
    if(nativeError)throw nativeError;
    assert.equal(timedOut,false,'Processed output decode timed out');assert.equal(exit.code,0,stderr);
    assert.equal(bytes,expectedBytes);assert.equal(frameOffset,0);assert.equal(frames.length,expected.frameCount);
    return {bytes,frameCount:frames.length,sha256:hash.digest('hex'),frames,pid:child.pid,exitCode:exit.code};
  }finally{
    if(child.exitCode===null&&child.signalCode===null)child.kill();
    await completion;clearTimeout(timer);
  }
}
async function readyWorkerSince(start){
  const children=await app.evaluate((_electron,start)=>globalThis.actualEnhancementAudit.children.slice(start),start);
  const workers=children.filter(child=>path.basename(child.command).toLowerCase()==='python.exe');assert.equal(workers.length,1);
  const worker=workers[0];assert.ok(worker.ready);assert.equal(worker.ready.protocolVersion,1);assert.equal(worker.ready.inputCapacity,5);
  assert.equal(worker.ready.outputWidth,outputWidth);assert.equal(worker.ready.outputHeight,outputHeight);
  const hardware=worker.ready.hardware;assert.ok(hardware);
  assert.equal(hardware.inferenceStrategy,'independent-frames-v1');assert.equal(hardware.modelTemporalFrames,1);
  assert.equal(hardware.transportWindowFrames,9);assert.equal(hardware.overlapReuseFrames,4);assert.equal(hardware.vaeTileSize,256);
  for(const key of ['directEstimatedVramBytes','partialEstimatedVramBytes','vramBudgetBytes','estimatedVramBytes'])assert.ok(Number.isSafeInteger(hardware[key])&&hardware[key]>0);
  const expectedBlocks=hardware.directEstimatedVramBytes<=hardware.vramBudgetBytes?0:8;
  assert.equal(hardware.blocksToSwap,expectedBlocks);assert.ok(hardware.estimatedVramBytes<=hardware.vramBudgetBytes);
  assert.equal(hardware.estimatedVramBytes,expectedBlocks?hardware.partialEstimatedVramBytes:hardware.directEstimatedVramBytes);
  assert.equal(hardware.memoryPolicy,expectedBlocks?'partial-cuda-8-v1':'direct-cuda-v1');
  return worker;
}
async function inspectOutput(media,label,expected,worker){
  assert.ok(Number.isInteger(expected.frameCount)&&expected.frameCount>=1&&expected.frameCount<=frameCount);assert.equal(expected.duration,expected.frameCount/fps);
  assert.equal(media.kind,'video');assert.equal(media.hasAlpha,false);assert.equal(media.width,outputWidth);assert.equal(media.height,outputHeight);assert.ok(Math.abs(media.duration-expected.duration)<=.002);assert.ok(media.proxyPath?.endsWith('-color-proxy.mp4'));
  const result=await run(path.resolve('resources/bin/ffprobe.exe'),['-v','error','-show_frames','-show_streams','-show_format','-of','json',media.path],{windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
  const probe=JSON.parse(result.stdout),frames=probe.frames.filter(frame=>frame.media_type==='video');
  assert.equal(frames.length,expected.frameCount);
  for(const [index,frame] of frames.entries()){
    assert.equal(Math.round(Number(frame.best_effort_timestamp_time)*1e6),index*100000);
    assert.equal(Math.round(Number(frame.duration_time)*1e6),100000);
  }
  assert.equal(Math.round((Number(frames.at(-1).best_effort_timestamp_time)+Number(frames.at(-1).duration_time))*1e6),Math.round(expected.duration*1e6));
  assert.equal(probe.streams.find(stream=>stream.codec_type==='video').pix_fmt,'bgr0');
  assert.equal(await urlStatus(media.path),200);assert.equal(await urlStatus(media.proxyPath),200);
  const browser=await playable(media.proxyPath);assert.ok(browser.readyState>=2);assert.equal(browser.width,proxyWidth);assert.equal(browser.height,proxyHeight);assert.ok(Math.abs(browser.duration-expected.duration)<=.002);
  const pixels=await inspectPixels(media.path,expected);
  const sourceAudio=await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-copyts','-i',sourceFile,'-map','0:a:0','-af',`atrim=start=0:end=${expected.duration},asetpts=PTS`,'-c:a','pcm_f32le','-f','f32le','pipe:1'],{windowsHide:true,timeout:60000,encoding:'buffer',maxBuffer:2*1024*1024});
  const outputAudio=await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-i',media.path,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1'],{windowsHide:true,timeout:60000,encoding:'buffer',maxBuffer:2*1024*1024});
  assert.equal(sourceAudio.stdout.length,Math.round(expected.duration*48000)*4);assert.deepEqual(outputAudio.stdout,sourceAudio.stdout);
  await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-y','-i',media.path,'-frames:v','1',path.join(root,label+'.png')],{windowsHide:true,timeout:60000});
  const record={media,expected,frameCount:frames.length,duration:expected.duration,probe,browser,worker,pixels,fileSha256:await hashFile(media.path),proxySha256:await hashFile(media.proxyPath),nativeBgraSha256:pixels.sha256,pcmSha256:digest(outputAudio.stdout),pcmBytes:outputAudio.stdout.length};
  await fs.writeFile(path.join(root,label+'.json'),JSON.stringify(record,null,2));return record;
}

try{
  evidence=await editorEvidence(app,import.meta.url);await page.locator('.preview-gpu-stage').waitFor({state:'attached'});
  await verifyNativeSources();
  if(priorRecovery){const recovery=page.getByRole('dialog',{name:'작업을 이어서 할까요?',exact:true});await recovery.waitFor();await recovery.getByRole('button',{name:'새로 시작',exact:true}).click();}
  await app.evaluate(({app},profile)=>{if(app.getPath('userData')!==profile)throw Error('Unexpected QA profile');},profile);
  await app.evaluate(async({app},auditFile)=>{
    const fs=process.getBuiltinModule('node:fs'),cp=process.getBuiltinModule('node:child_process'),module=process.getBuiltinModule('node:module');
    const audit=globalThis.actualEnhancementAudit={downloads:[],children:[]};
    const record=entry=>fs.appendFileSync(auditFile,JSON.stringify({...entry,at:new Date().toISOString()})+'\n');
    app.once('before-quit',()=>record({event:'before-quit',activeChildren:audit.children.filter(child=>!child.closed).map(child=>child.childId)}));
    globalThis.fetch=async(...args)=>{audit.downloads.push(String(args[0]));record({event:'blocked-fetch',url:String(args[0])});throw Error('Network downloads forbidden in cached actual-AI QA');};
    const spawn=cp.spawn;
    cp.spawn=function(command,args,options){
      const child=spawn.call(this,command,args,options);
      const childId=audit.children.length+1,entry={event:'spawn',childId,pid:child.pid,command:String(command),args,offline:{HF_HUB_OFFLINE:options?.env?.HF_HUB_OFFLINE,TRANSFORMERS_OFFLINE:options?.env?.TRANSFORMERS_OFFLINE}};
      audit.children.push(entry);record(entry);
      if(/(?:^|[\\/])python\.exe$/i.test(String(command))){
        let buffered='';
        child.stdout.on('data',chunk=>{
          buffered+=chunk.toString('utf8');
          if(buffered.length>1024*1024){record({event:'worker-observer-error',childId,message:'Protocol line exceeds audit bound'});buffered='';return;}
          let newline;
          while((newline=buffered.indexOf('\n'))>=0){
            const line=buffered.slice(0,newline).trim();buffered=buffered.slice(newline+1);if(!line)continue;
            try{
              const message=JSON.parse(line);
              if(message.result?.protocolVersion===1){entry.ready=message.result;record({event:'worker-ready',childId,pid:child.pid,result:message.result});}
            }catch{record({event:'worker-observer-error',childId,message:'Invalid worker protocol JSON'});}
          }
        });
      }
      const kill=child.kill;
      child.kill=function(...args){record({event:'kill',childId,pid:child.pid,args});return kill.apply(this,args);};
      child.once('close',(code,signal)=>{entry.closed=true;record({event:'close',childId,pid:child.pid,code,signal});});return child;
    };module.syncBuiltinESMExports();
  },auditFile);
  await page.evaluate(()=>{window.actualEnhancementEvents=[];window.studio.onJob(event=>window.actualEnhancementEvents.push(event));});
  let info=await page.evaluate(()=>window.studio.enhancementInfo());assert.equal(info.model,manifest.backendId);assert.equal(info.deviceSupported,true,'Actual model QA requires the supported GPU');
  if(!info.installed){
    await provisionDownloads();const install=await page.evaluate(()=>window.studio.installEnhancementEngine());const events=await terminal(install.jobId);successful(events);assert.ok(events.every(event=>event.type==='enhancement-install'&&event.preview===undefined));
    info=await page.evaluate(()=>window.studio.enhancementInfo());assert.equal(info.installed,true);
  }
  runtimeEvidence=await runtimeInventory();
  checks.push('Normal installation IPC publishes a manifest-verified runtime from checksum-verified archive cache, or reuses that exact installed manifest');
  assert.deepEqual(await app.evaluate(()=>globalThis.actualEnhancementAudit.downloads),[]);
  checks.push('The offline fetch rejection audit records zero download attempts');

  const [source]=await page.evaluate(file=>window.studio.importMedia([file]),sourceFile);assert.equal(source.width,sourceWidth);assert.equal(source.height,sourceHeight);assert.ok(Math.abs(source.duration-duration)<.002);
  const decodeEvents=[],decodeContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'input-proof'),diagnostics:event=>decodeEvents.push(event)};
  const prepared=await prepareTrackingInput(source,4096,decodeContext),selection=await verifyVideoSelection({...prepared.plan,revision:prepared.revision,probe:prepared.probe},0,duration,decodeContext),nativeInput=[];
  for await(const frame of decodeTrackingFrames(prepared.plan,selection.firstPts,selection.endPts,decodeContext))nativeInput.push({pts:frame.pts,width:frame.width,height:frame.height,bytes:frame.data.length,bgrSha256:digest(frame.data)});
  assert.equal(nativeInput.length,frameCount);
  for(const [index,frame] of nativeInput.entries()){assert.equal(frame.width,sourceWidth);assert.equal(frame.height,sourceHeight);assert.equal(frame.pts,index*100000);assert.equal(frame.bytes,sourceWidth*sourceHeight*3);}
  for(const event of decodeEvents)if(event.event==='tracking-decoder-start')assert.throws(()=>process.kill(Number(event.pid),0),{code:'ESRCH'});
  await fs.writeFile(path.join(root,'native-input-reference.json'),JSON.stringify({source,sourceSha256,selection,frames:nativeInput,events:decodeEvents},null,2));
  const original=await current(),beforePreview=await app.evaluate(()=>globalThis.actualEnhancementAudit.children.length);
  const preview=await page.evaluate(source=>window.studio.enhanceMedia(source,{start:0,duration:.1,scale:2,preview:true}),source);
  const previewEvents=await terminal(preview.jobId);assert.ok(previewEvents.every(event=>event.preview===true&&event.type==='enhance'));
  previewResult=successful(previewEvents);assert.ok(previewResult);assert.ok(inside(previewResult.path,previewRoot));
  const previewEvidence=await inspectOutput(previewResult,'preview',{frameCount:1,duration:.1},await readyWorkerSince(beforePreview));
  assert.deepEqual((await current()).media,original.media);assert.deepEqual((await current()).clips,original.clips);assert.equal((await current()).updatedAt,original.updatedAt);
  checks.push('Real model preview returns one opaque 1920x1080 frame with exact duration/PTS and its normal browser-playable 1280x720 proxy without changing project/library/history');
  const previewDirectory=path.dirname(previewResult.path);assert.match(path.basename(previewDirectory),/^job-/);
  await page.evaluate(async id=>{await Promise.all([window.studio.discardEnhancementPreview(id),window.studio.discardEnhancementPreview(id)]);await window.studio.discardEnhancementPreview(id);},previewResult.id);
  assert.equal(await exists(previewDirectory),false);assert.equal(await urlStatus(previewResult.path),403);assert.equal(await urlStatus(previewResult.proxyPath),403);
  assert.equal(await hashFile(sourceFile),sourceSha256);
  checks.push('Concurrent and repeated normal discard IPC removes only its owned preview directory and revokes original/proxy media URLs');

  const project=newProject();project.id='actual-enhancement-'+Date.now();project.name='AI 실제 적용 검사';project.width=outputWidth;project.height=outputHeight;project.fps=fps;project.media=[source];project.clips=[{...newClip('video-1',source),id:'actual-enhancement',duration,x:5,brightness:.06}];assertProject(project);
  const fixture=path.join(root,'input.sluproj');await fs.writeFile(fixture,JSON.stringify(project));await openProject(fixture,project.id);await selectClip();
  const beforeFull=await app.evaluate(()=>globalThis.actualEnhancementAudit.children.length);
  await page.getByRole('button',{name:'AI 화질 향상',exact:true}).click();const dialog=page.getByRole('dialog',{name:'AI 화질 향상',exact:true});await dialog.getByRole('button',{name:'클립에 적용',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>window.actualEnhancementEvents.some(event=>event.type==='enhance'&&event.preview===false),undefined,{timeout:30000});
  const fullId=await page.evaluate(()=>window.actualEnhancementEvents.find(event=>event.type==='enhance'&&event.preview===false).id);
  const fullEvents=await terminal(fullId);assert.ok(fullEvents.every(event=>event.preview===false));fullResult=successful(fullEvents);assert.ok(inside(fullResult.path,path.join(profile,'media-derived')));
  const fullEvidence=await inspectOutput(fullResult,'full',{frameCount,duration},await readyWorkerSince(beforeFull));await page.waitForFunction(()=>!!document.querySelector('.preview-gpu-stage').previewRuntime.project.clips[0].enhancement);
  const applied=await editedClip();assert.equal(applied.mediaId,fullResult.id);assert.equal(applied.enhancement.sourceMediaId,source.id);assert.equal(applied.enhancement.scale,2);assert.equal(applied.x,5);assert.equal(applied.brightness,.06);
  await cleanUI();await page.keyboard.press('Control+z');await page.waitForFunction(()=>!document.querySelector('.preview-gpu-stage').previewRuntime.project.clips[0].enhancement);assert.equal((await editedClip()).mediaId,source.id);
  await page.keyboard.press('Control+Shift+z');await page.waitForFunction(()=>!!document.querySelector('.preview-gpu-stage').previewRuntime.project.clips[0].enhancement);
  await selectClip();await page.getByRole('button',{name:'화질 향상 해제',exact:true}).click();assert.equal((await editedClip()).mediaId,source.id);await page.keyboard.press('Control+z');await page.waitForFunction(()=>!!document.querySelector('.preview-gpu-stage').previewRuntime.project.clips[0].enhancement);
  checks.push('Normal selected-clip UI applies all 15 independently inferred opaque HD frames across transport batches with exact PTS/duration/PCM and preserves edits through undo/redo and original restoration');
  const saved=path.join(root,'enhanced.sluproj');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},saved);await page.keyboard.press('Control+Shift+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();const serialized=JSON.parse(await fs.readFile(saved,'utf8'));assertProject(serialized);await openProject(saved,project.id);assert.deepEqual((await editedClip()).enhancement,serialized.clips[0].enhancement);await captureElectron(app,{path:path.join(root,'actual-applied.png')});
  checks.push('Actual save/reopen retains the derived file and bounded original-source provenance');

  assert.deepEqual(await children(previewRoot),[]);
  const beforeCancel=await app.evaluate(()=>globalThis.actualEnhancementAudit.children.length);
  cancelJob=await page.evaluate(source=>window.studio.enhanceMedia(source,{start:0,duration:.1,scale:2,preview:true}),source);
  const cancelling=await waitForActiveWorker(cancelJob.jobId,beforeCancel);
  await page.evaluate(id=>window.studio.cancelJob(id),cancelJob.jobId);
  const cancelledEvents=await terminal(cancelJob.jobId);assert.equal(cancelledEvents.at(-1).status,'cancelled');assert.ok(cancelledEvents.every(event=>event.preview===true));
  assert.equal(await exists(cancelling.directory),false);assert.deepEqual(await children(previewRoot),[]);
  checks.push('Normal cancel IPC during an actual native worker produces a terminal cancelled event and removes its owned preview directory');

  // Finish expensive verification before starting the shutdown fixture so it
  // cannot finish inference while source hashes are being collected.
  assert.deepEqual(await app.evaluate(()=>globalThis.actualEnhancementAudit.downloads),[]);assert.deepEqual(errors,[]);
  await verifyEditorBuild(evidence);await verifyNativeSources();
  const nativeBefore=await app.evaluate(()=>globalThis.actualEnhancementAudit.children.length);
  shutdownJob=await page.evaluate(source=>window.studio.enhanceMedia(source,{start:0,duration:.1,scale:2,preview:true}),source);
  const shuttingDown=await waitForActiveWorker(shutdownJob.jobId,nativeBefore);
  await app.close();closed=true;
  assert.deepEqual(await children(previewRoot),[]);assert.equal(await exists(fullResult.path),true);assert.equal(await hashFile(sourceFile),sourceSha256);assert.equal(await hashFile(fullResult.path),fullEvidence.fileSha256);
  const nativeAudit=(await fs.readFile(auditFile,'utf8')).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const started=nativeAudit.filter(event=>event.event==='spawn'&&event.pid),finished=new Set(nativeAudit.filter(event=>event.event==='close').map(event=>event.childId));
  assert.ok(started.some(event=>path.basename(event.command).toLowerCase()==='python.exe'));
  // The process close event establishes this child's exit. Windows may reuse
  // an earlier numeric PID during the long installation/model run.
  for(const event of started){assert.ok(finished.has(event.childId),`Owned child ${event.childId}/${event.pid} did not close`);if(path.basename(event.command).toLowerCase()==='python.exe'){assert.equal(event.offline.HF_HUB_OFFLINE,'1');assert.equal(event.offline.TRANSFORMERS_OFFLINE,'1');}}
  assert.ok(!nativeAudit.some(event=>event.event==='blocked-fetch'));
  assert.ok(!nativeAudit.some(event=>event.event==='worker-observer-error'));
  for(const processed of [previewEvidence,fullEvidence]){
    const ready=nativeAudit.filter(event=>event.event==='worker-ready'&&event.childId===processed.worker.childId);assert.equal(ready.length,1);assert.deepEqual(ready[0].result,processed.worker.ready);
  }
  assert.ok(nativeAudit.some(event=>event.event==='before-quit'&&event.activeChildren.includes(shuttingDown.worker.childId)),'Shutdown must begin while its native worker is still active');
  for(const active of [cancelling,shuttingDown])assert.ok(nativeAudit.some(event=>event.event==='kill'&&event.childId===active.worker.childId),'Running worker must receive termination before exit');
  await runtimeInventory(runtimeEvidence);await verifyNativeSources();await verifyEditorBuild(evidence);
  checks.push('Closing the application during a real worker job cancels it, removes owned temporary previews and closes every observed child while retaining saved media');
  result={...evidence,root,profile,checks,errors,sourceSha256,manifestSha256,workerSha256,nativeSourceHashes,fixture:{sourceWidth,sourceHeight,outputWidth,outputHeight,proxyWidth,proxyHeight,fps,duration,frameCount},nativeInputReferenceFile:path.join(root,'native-input-reference.json'),runtimeEvidenceFile:path.join(root,'runtime.json'),runtimeAfterFile:path.join(root,'runtime-after.json'),archives:archiveEvidence,preview:previewEvidence,full:fullEvidence,cancelJob,cancelledEvents,cancelling,shutdownJob,shuttingDown,nativeAudit};
}catch(error){
  const events=await page.evaluate(()=>window.actualEnhancementEvents).catch(()=>undefined);if(!closed)await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});
  await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({root,profile,evidence,checks,errors,events,jobs,previewResult,fullResult,cancelJob,shutdownJob,error:String(error),stack:error.stack},null,2));throw error;
}finally{if(!closed)await app.close();}
await fs.writeFile(path.join(root,'results.json'),JSON.stringify({...result,passed:true,completedAt:new Date().toISOString()},null,2));
await fs.writeFile(pointer,root+'\n');
console.log(JSON.stringify({root,checks:checks.length,errors,profile}));
