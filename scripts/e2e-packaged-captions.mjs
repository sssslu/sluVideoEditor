import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

// Observe the installed ASAR code and real preload/IPC. No source renderer or
// export implementation is injected. The source reference is used only as an oracle.
const root=path.resolve('.test-artifacts/packaged-captions');await fs.mkdir(root,{recursive:true});
const executable=path.resolve(process.env.SLU_TEST_EXE||'release/win-unpacked/SLU Studio.exe');
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const profile=await fs.mkdtemp(path.join(root,'profile-')),env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const fixtureFile=path.resolve('.test-artifacts/rich-captions/raw-fixture.json'),fixture=JSON.parse(await fs.readFile(fixtureFile,'utf8'));
const reference=await fs.readFile('.test-artifacts/rich-captions/actual.yuv'),checks=[],errors=[],details=[];
const hash=data=>createHash('sha256').update(data).digest('hex'),run=promisify(execFile);
const binary=(file,args)=>run(file,args,{windowsHide:true,encoding:'buffer',maxBuffer:64*1024*1024,timeout:120000});
function assertCaptionFaces(faces) {
  assert.equal(faces.length,4);
  assert.ok(faces.every(face=>face.status==='loaded'));
  assert.deepEqual(faces.map(face=>`${face.family.replace(/^(["'])(.*)\1$/,'$2')}|${face.weight}`).sort(),[
    'SLU Noto Sans KR|100 900','SLU Noto Color Emoji|100 900','SLU Gmarket Sans|400 500','SLU Gmarket Sans|600 800',
  ].sort());
}
let app,page,resources;
async function terminal(id){await page.waitForFunction(id=>window.captionJobs.some(e=>e.id===id&&e.status!=='running'),id,{timeout:120000});return page.evaluate(id=>window.captionJobs.find(e=>e.id===id&&e.status!=='running'),id);}
async function start(project,settings,output,phase){await app.evaluate(({dialog},{output,phase})=>{globalThis.captionPhase=phase;dialog.showSaveDialog=async()=>({canceled:false,filePath:output});},{output,phase});const job=await page.evaluate(({project,settings})=>window.studio.exportProject(project,settings),{project,settings});assert.ok(job?.jobId);return job;}
try{
  app=await launchTestElectron({executablePath:executable,args:electronTestArgs(true),env,timeout:90000});page=await app.firstWindow();page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
  const runtime=await app.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,appPath:app.getAppPath(),executable:process.execPath,resources:process.resourcesPath,visible:BrowserWindow.getAllWindows()[0].isVisible()}));
  assert.equal(runtime.packaged,true);assert.ok(runtime.appPath.endsWith('app.asar'));assert.equal(path.resolve(runtime.executable).toLowerCase(),executable.toLowerCase());assert.equal(runtime.visible,false);resources=runtime.resources;
  assert.equal((await page.evaluate(()=>window.studio.getSystemInfo())).version,version);
  checks.push('Actual packaged ASAR app and secure preload run the current version in an isolated hidden profile');
  await app.evaluate(({app,session})=>{
    globalThis.captionWindows=[];globalThis.captionSpawns=[];globalThis.captionRemoteRequests=[];
    session.defaultSession.webRequest.onBeforeRequest({urls:['https://*/*','http://*/*']},(details,callback)=>{globalThis.captionRemoteRequests.push(details.url);callback({cancel:true});});
    app.on('browser-window-created',(_event,window)=>{
      const entry={phase:globalThis.captionPhase,closed:false,preferences:window.webContents.getLastWebPreferences(),fontRequests:[]};globalThis.captionWindows.push(entry);
      window.webContents.session.webRequest.onCompleted(details=>{if(details.url.endsWith('.ttf'))entry.fontRequests.push({url:details.url,status:details.statusCode});});
      window.on('closed',()=>entry.closed=true);window.webContents.on('did-finish-load',()=>{
        entry.url=window.webContents.getURL();
        void window.webContents.executeJavaScript(`(async()=>{for(let i=0;i<100;i++){const fonts=[...document.fonts].map(f=>({family:f.family,weight:f.weight,status:f.status}));if(fonts.length===4&&fonts.every(f=>f.status==='loaded'))return {fonts,resources:performance.getEntriesByType('resource').map(e=>e.name)};await new Promise(r=>setTimeout(r,10));}throw Error('Bundled caption fonts did not load');})()`).then(result=>entry.fonts=result).catch(error=>entry.fontObservationError=String(error));
      });
    });
    const {createRequire,syncBuiltinESMExports}=process.getBuiltinModule('module'),cp=createRequire(process.execPath)('node:child_process');globalThis.captionOriginalSpawn=cp.spawn;
    cp.spawn=function(file,args){const entry={phase:globalThis.captionPhase,file:String(file),args:[...(args||[])]},child=Reflect.apply(globalThis.captionOriginalSpawn,this,arguments);entry.pid=child.pid;globalThis.captionSpawns.push(entry);child.on('close',(code,signal)=>Object.assign(entry,{code,signal}));return child;};syncBuiltinESMExports();
  });
  await page.evaluate(()=>{window.captionJobs=[];window.studio.onJob(e=>window.captionJobs.push(e));});
  const projectPath=path.join(root,'reference.sluproj');await fs.writeFile(projectPath,JSON.stringify(fixture.project));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},projectPath);await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.fonts.size===4&&[...document.fonts].every(f=>f.status==='loaded'));
  const ffmpeg=path.join(resources,'bin','ffmpeg.exe'),ffprobe=path.join(resources,'bin','ffprobe.exe');
  for(const encoder of ['cpu','nvenc']){
    const output=path.join(root,`${encoder}.mp4`),settings={...fixture.settings,encoder,outputPath:undefined};
    const job=await start(fixture.project,settings,output,encoder),event=await terminal(job.jobId);assert.equal(event.status,'complete',event.message);
    const probe=JSON.parse((await binary(ffprobe,['-v','error','-count_frames','-show_streams','-of','json',output])).stdout.toString()),video=probe.streams.find(s=>s.codec_type==='video');
    assert.equal(video.width,320);assert.equal(video.height,180);assert.equal(video.avg_frame_rate,'120/1');assert.equal(Number(video.nb_read_frames),73);
    const raw=(await binary(ffmpeg,['-v','error','-i',output,'-map','0:v:0','-pix_fmt','yuv420p','-f','rawvideo','pipe:1'])).stdout;assert.equal(raw.length,reference.length);
    const frameBytes=320*180*1.5;let maximumMean=0,maximumInkMean=0,maximumPixelsOver16=0;
    for(let f=0;f<73;f++){const offset=f*frameBytes;let total=0,ink=0,inkError=0,over=0;for(let i=0;i<frameBytes;i++)total+=Math.abs(raw[offset+i]-reference[offset+i]);for(let i=0;i<320*180;i++){const a=reference[offset+i],b=raw[offset+i];if(a>20||b>20){ink++;inkError+=Math.abs(a-b);if(Math.abs(a-b)>16)over++;}}maximumMean=Math.max(maximumMean,total/frameBytes);maximumInkMean=Math.max(maximumInkMean,ink?inkError/ink:0);maximumPixelsOver16=Math.max(maximumPixelsOver16,ink?over/ink:0);}
    assert.ok(maximumMean<2,`${encoder} whole-frame error ${maximumMean}`);assert.ok(maximumInkMean<7,`${encoder} caption-region error ${maximumInkMean}`);assert.ok(maximumPixelsOver16<.15,`${encoder} changed caption pixels ${maximumPixelsOver16}`);
    const observed=await app.evaluate((_,phase)=>({windows:globalThis.captionWindows.filter(w=>w.phase===phase),spawns:globalThis.captionSpawns.filter(s=>s.phase===phase)}),encoder);
    assert.equal(observed.windows.length,1);const window=observed.windows[0];assert.equal(window.closed,true);assert.ok(window.url.includes('app.asar/dist/caption-export.html'));assert.equal(window.preferences.sandbox,true);assert.equal(window.preferences.contextIsolation,true);assert.equal(window.preferences.nodeIntegration,false);assert.ok(window.fonts,window.fontObservationError);
    assertCaptionFaces(window.fonts.fonts);const fontUrls=window.fontRequests.map(item=>item.url);assert.equal(fontUrls.length,4);assert.ok(fontUrls.every(url=>url.includes('app.asar/dist/assets/')));
    const encoders=observed.spawns.filter(s=>s.args.includes(encoder==='nvenc'?'h264_nvenc':'libx264'));assert.equal(encoders.length,1);assert.equal(encoders[0].code,0);assert.equal(path.resolve(encoders[0].file),ffmpeg);
    details.push({encoder,output,frames:73,maximumMean,maximumInkMean,maximumPixelsOver16,windows:observed.windows,encoderPid:encoders[0].pid});
    checks.push(`${encoder}: real packaged renderer loads both caption families and emoji offline, exports73 frames at120fps matching source reference within codec tolerance, and closes its sandbox`);
  }
  const cancelOutput=path.join(root,`cancel-${Date.now()}.mp4`),cancelProject={...fixture.project,width:3840,height:2160,clips:fixture.project.clips.map(c=>({...c,start:0,duration:600,fontSize:200,keyframes:[],captionAnimation:undefined,animation:'none'}))};
  const job=await start(cancelProject,{...fixture.settings,width:3840,height:2160,fps:60,encoder:'nvenc'},cancelOutput,'cancel');
  for(let i=0;i<400;i++){if(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length>1&&globalThis.captionSpawns.some(s=>s.phase==='cancel'&&s.args.includes('h264_nvenc')&&s.code===undefined)))break;await new Promise(r=>setTimeout(r,25));}
  assert.ok(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length>1&&globalThis.captionSpawns.some(s=>s.phase==='cancel'&&s.args.includes('h264_nvenc')&&s.code===undefined)),'Cancellation must exercise both a live caption renderer and an actual running encoder');
  await page.evaluate(id=>window.studio.cancelJob(id),job.jobId);assert.equal((await terminal(job.jobId)).status,'cancelled');assert.equal(await fs.stat(cancelOutput).then(()=>true,()=>false),false);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);await page.waitForTimeout(150);
  const cancelSpawns=await app.evaluate(()=>globalThis.captionSpawns.filter(s=>s.phase==='cancel'));assert.ok(cancelSpawns.every(s=>s.code!==undefined||s.signal));
  checks.push('Cancellation while the private renderer exists closes it and all owned child processes without publishing output');
  const audit=await app.evaluate(()=>({windows:globalThis.captionWindows,spawns:globalThis.captionSpawns,remoteRequests:globalThis.captionRemoteRequests}));assert.deepEqual(audit.remoteRequests,[]);
  const fonts=await page.evaluate(()=>[...document.fonts].map(f=>({family:f.family,weight:f.weight,status:f.status})));assertCaptionFaces(fonts);
  checks.push('Editor fonts and export fonts work with external network requests blocked and no remote request attempted');
  await fs.writeFile(path.join(root,'audit.json'),JSON.stringify(audit,null,2));assert.deepEqual(errors,[]);
  const bundleHashes={asar:hash(await fs.readFile(path.join(resources,'app.asar'))),ffmpeg:hash(await fs.readFile(ffmpeg))};
  const report={version,executable,checks,errors,details,profile,bundleHashes,fixtureSha256:hash(await fs.readFile(fixtureFile)),referenceSha256:hash(reference)};await fs.writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({version,checks,details:details.map(({windows,...d})=>d)},null,2));
}catch(error){errors.push(String(error));await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({version,executable,checks,errors,details},null,2));if(app)await fs.writeFile(path.join(root,'failure-audit.json'),JSON.stringify(await app.evaluate(()=>({windows:globalThis.captionWindows,spawns:globalThis.captionSpawns})).catch(()=>({})),null,2));throw error;}
finally{
  if(page)await page.evaluate(async()=>{const ids=[...new Set((window.captionJobs||[]).map(e=>e.id))];await Promise.all(ids.map(id=>window.studio.cancelJob(id)));}).catch(()=>{});
  if(app)await app.close();
}
