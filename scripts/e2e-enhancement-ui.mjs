import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {editorEvidence,verifyEditorBuild} from './e2e-release-evidence.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {newProject,newClip} from '../shared/project.ts';
import {assertProject} from '../shared/validation.ts';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

// Controlled IPC isolates renderer ownership/history races. The comparison uses
// actual browser-decoded files, but these fixtures are not AI quality evidence.
const root=path.resolve('.test-artifacts/enhancement-ui',Date.now().toString());await fs.mkdir(root,{recursive:true});
const pointer=path.resolve(`.test-artifacts/enhancement-ui-current-${process.env.SLU_TEST_EXE?'packaged':'source'}.txt`);
await fs.rm(pointer,{force:true});
const run=promisify(execFile),sourceFile=path.join(root,'source.mp4'),resultFile=path.join(root,'result.mp4');
await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=128x72:r=10:d=4','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',sourceFile],{windowsHide:true,timeout:30000});
await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-y','-i',sourceFile,'-ss','1','-t','2','-vf','scale=256:144','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',resultFile],{windowsHide:true,timeout:30000});
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null,env={...process.env,SLU_USER_DATA:path.join(root,'profile'),SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000});
const page=await app.firstWindow(),checks=[],errors=[],observations=[];page.on('pageerror',error=>errors.push(String(error)));
const current=()=>page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project);
const clip=async()=>(await current()).clips.find(c=>c.id==='enhancement-clip');
const dialog=page.getByRole('dialog',{name:'AI 화질 향상',exact:true});
const mediaSection=page.locator('.inspector').getByRole('button',{name:'미디어',exact:true});
async function clean(){await dismissToasts(page);if(await page.getByTitle('작업 패널 닫기',{exact:true}).count())await page.getByTitle('작업 패널 닫기',{exact:true}).click();}
async function select(){await clean();await page.locator('[data-clip-id="enhancement-clip"]').focus();await page.locator('[data-clip-id="enhancement-clip"]').press('Enter');if(await mediaSection.getAttribute('aria-expanded')==='false')await mediaSection.click();}
async function show(){await select();await page.getByRole('button',{name:'AI 화질 향상',exact:true}).click();await dialog.waitFor();}
async function open(file,id){await clean();await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');await page.waitForFunction(id=>document.querySelector('.preview-gpu-stage')?.previewRuntime.project.id===id,id);await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();await clean();}
async function configure(config){await app.evaluate((_electron,config)=>Object.assign(globalThis.enhancementAudit,config),config);}
async function audit(){return app.evaluate(()=>{const a=globalThis.enhancementAudit;return {calls:a.calls.map(({resolve,...call})=>call),cancelled:a.cancelled,discarded:a.discarded};});}
async function emit(id,status,media){await app.evaluate(({BrowserWindow},{id,status,media})=>{const call=globalThis.enhancementAudit.calls.find(c=>c.id===id);BrowserWindow.getAllWindows()[0].webContents.send('job:progress',{id,type:call.type,preview:call.options?.preview===true,status,progress:status==='running'?.3:1,message:status==='error'?'제어된 화질 향상 오류':'제어된 화질 향상 작업',...(media?{media}:{})});},{id,status,media});}
async function resolve(id){await app.evaluate((_electron,id)=>globalThis.enhancementAudit.calls.find(c=>c.id===id).resolve?.({jobId:id}),id);}
let seenCalls=0;
async function lastCall(){
  const call=await app.evaluate(async(_electron,seen)=>{
    const end=Date.now()+10000;while(globalThis.enhancementAudit.calls.length<=seen&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));
    const calls=globalThis.enhancementAudit.calls;if(calls.length<=seen)throw Error('Enhancement IPC did not arrive');
    const {resolve,...last}=calls.at(-1);return {count:calls.length,last};
  },seenCalls);seenCalls=call.count;return call.last;
}
async function waitAudit(field,id){await app.evaluate(async(_electron,{field,id})=>{const end=Date.now()+10000;while(!globalThis.enhancementAudit[field].includes(id)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));if(!globalThis.enhancementAudit[field].includes(id))throw Error(`Missing ${field} ${id}`);},{field,id});}
async function waitApplied(){await page.waitForFunction(()=>!!document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.find(c=>c.id==='enhancement-clip').enhancement);}
let evidence,report;
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();evidence=await editorEvidence(app,import.meta.url);
  const [source,result]=await page.evaluate(files=>window.studio.importMedia(files),[sourceFile,resultFile]);
  const project=newProject();project.id='enhancement-ui';project.name='화질 향상 검사';project.width=256;project.height=144;project.fps=10;project.media=[source];project.clips=[{...newClip('video-1',source),id:'enhancement-clip',in:1,duration:2,x:12,brightness:.12}];assertProject(project);
  const fixture=path.join(root,'input.sluproj');await fs.writeFile(fixture,JSON.stringify(project));
  await app.evaluate(({ipcMain,BrowserWindow},result)=>{
    const audit=globalThis.enhancementAudit={installed:false,canRun:true,deviceSupported:true,message:undefined,hardwareRequests:[],hold:false,early:false,calls:[],cancelled:[],discarded:[],result};
    for(const channel of ['enhancement:info','enhancement:install','media:enhance','enhancement:discard-preview','job:cancel'])ipcMain.removeHandler(channel);
    ipcMain.handle('enhancement:info',(_event,request)=>{audit.hardwareRequests.push(request);return {installed:audit.installed,downloadBytes:2000000,model:'controlled-test-model',deviceSupported:audit.deviceSupported,canRun:audit.canRun,message:audit.message};});
    const start=(type,media,options)=>{
      const id=`controlled-enhancement-${audit.calls.length+1}`,call={id,type,media,options};audit.calls.push(call);
      if(audit.early){if(type==='enhancement-install')audit.installed=true;BrowserWindow.getAllWindows()[0].webContents.send('job:progress',{id,type,preview:options?.preview===true,status:'complete',progress:1,message:'제어된 조기 완료',...(type==='enhance'?{media:options.preview?{...audit.result,id:`preview-${id}`}:{...audit.result}}:{})});}
      if(audit.hold)return new Promise(resolve=>{call.resolve=resolve;});
      return {jobId:id};
    };
    ipcMain.handle('enhancement:install',()=>start('enhancement-install'));
    ipcMain.handle('media:enhance',(_event,media,options)=>start('enhance',media,options));
    ipcMain.handle('enhancement:discard-preview',(_event,id)=>{audit.discarded.push(id);});
    ipcMain.handle('job:cancel',(_event,id)=>{audit.cancelled.push(id);});
  },result);
  await open(fixture,project.id);
  const heading=page.locator('.gpu-preview-panel .panel-heading');
  assert.equal(await heading.getByRole('button').count(),0);
  for(const label of ['색상 스코프','오디오 레벨','재생 성능','플레이어 전체 화면 (Ctrl+Shift+F)'])assert.equal(await page.getByTitle(label,{exact:true}).count(),0);
  const stageBounds=await page.getByLabel('영상 캔버스',{exact:true}).boundingBox();
  assert.ok(stageBounds&&stageBounds.width>200&&stageBounds.height>100,'Program monitor must retain its visible area after feature removal');
  checks.push('Resolution heading has no removed feature buttons and the monitor retains its visible area');
  const multiple={...project,id:'enhancement-multiple',clips:[...project.clips,{...project.clips[0],id:'enhancement-second',start:2,name:'두 번째 영상'}]};
  const multipleFile=path.join(root,'multiple.sluproj');await fs.writeFile(multipleFile,JSON.stringify(multiple));
  await open(multipleFile,multiple.id);
  await page.locator('[data-clip-id="enhancement-clip"]').click();
  await page.locator('[data-clip-id="enhancement-second"]').click({modifiers:['Shift']});
  await page.locator('[data-clip-id="enhancement-second"]').click({button:'right'});
  await page.getByRole('menuitem',{name:'AI 화질 향상',exact:true}).click();
  await dialog.waitFor();
  assert.equal(await page.locator('.timeline-clip.selected').count(),1);
  assert.equal(await page.locator('.timeline-clip.selected').getAttribute('data-clip-id'),'enhancement-second');
  await dialog.getByRole('button',{name:'닫기',exact:true}).click();
  checks.push('A multi-selection context action targets the right-clicked video');
  await open(fixture,project.id);
  await page.locator('[data-clip-id="enhancement-clip"]').click({button:'right'});
  await page.getByRole('menuitem',{name:'AI 화질 향상',exact:true}).click();
  await dialog.waitFor();
  await dialog.getByRole('button',{name:'닫기',exact:true}).click();
  checks.push('Timeline video right-click opens its AI enhancement dialog');
  await page.locator('[data-clip-id="enhancement-clip"]').click({button:'right'});
  const menuBounds=await page.getByRole('menu').boundingBox();
  const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  assert.ok(menuBounds&&menuBounds.x>=0&&menuBounds.y>=0&&menuBounds.x+menuBounds.width<=viewport.width&&menuBounds.y+menuBounds.height<=viewport.height,'Context menu must remain within the viewport');
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'프로그램',exact:true}).click();
  await page.keyboard.press('Home');
  await page.waitForFunction(()=>!document.querySelector('.preview-gpu-stage').previewRuntime.stats()?.seeking);
  await page.getByLabel('영상 캔버스',{exact:true}).click({button:'right'});
  await page.getByRole('menuitem',{name:'AI 화질 향상',exact:true}).click();
  await dialog.waitFor();await dialog.getByRole('button',{name:'닫기',exact:true}).click();
  checks.push('Video object right-click in the monitor opens AI enhancement');
  await configure({canRun:false,message:'RAM 부족 · 필요 9.4 GiB / 여유 1.0 GiB'});
  await show();await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.getByRole('button',{name:'클립에 적용',exact:true}).isDisabled(),true);
  assert.equal(await dialog.getByRole('button',{name:/초 비교/}).isDisabled(),true);
  assert.equal(await dialog.getByRole('button',{name:/AI 엔진 설치/}).isDisabled(),true);
  assert.equal((await audit()).calls.length,0);
  await captureElectron(app,{path:path.join(root,'hardware-blocked.png')});
  await configure({canRun:true,message:undefined});
  await dialog.getByRole('button',{name:'사양 다시 확인',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.enhancement-hardware-warning'));
  await dialog.getByLabel('화질 향상 배율',{exact:true}).selectOption('4');
  await page.waitForFunction(()=>!document.querySelector('.modal [role="status"]'));
  const requested=await app.evaluate(()=>globalThis.enhancementAudit.hardwareRequests.at(-1));
  assert.deepEqual(requested,{width:128,height:72,scale:4});
  await dialog.getByRole('button',{name:'닫기',exact:true}).click();
  checks.push('Resource shortages block install, comparison and apply, and retry/scale changes recheck hardware');
  await show();
  await configure({hold:true,early:false});await dialog.getByRole('button',{name:/AI 엔진 설치/}).click();let call=await lastCall();
  await dialog.getByRole('button',{name:'닫기',exact:true}).click();await resolve(call.id);
  await waitAudit('cancelled',call.id);assert.ok((await audit()).cancelled.includes(call.id));await emit(call.id,'cancelled');
  checks.push('Closing during pending installation IPC cancels only that owned installation once its ID arrives');

  await configure({hold:true,early:true});await show();await dialog.getByRole('button',{name:/AI 엔진 설치/}).click();call=await lastCall();await resolve(call.id);
  // The preview button already exists before installation. Completion refreshes
  // engine info through another IPC; wait for that renderer state, not visibility.
  await dialog.getByRole('button',{name:/AI 엔진 설치/}).waitFor({state:'hidden',timeout:10000});
  await dialog.getByRole('button',{name:'2.0초 비교',exact:true}).click({trial:true,timeout:10000});assert.equal(await dialog.getByRole('button',{name:'2.0초 비교',exact:true}).isEnabled(),true);
  checks.push('First-use installation completed before IPC response refreshes the engine state and enables preview');

  const beforePreview=await current();await dialog.getByRole('button',{name:'2.0초 비교',exact:true}).click();call=await lastCall();assert.equal(call.options.start,1);assert.equal(call.options.duration,2);assert.equal(call.options.scale,2);await resolve(call.id);
  await dialog.getByRole('button',{name:'비교 재생',exact:true}).waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('.enhancement-pictures video')].length===2&&[...document.querySelectorAll('.enhancement-pictures video')].every(v=>v.readyState>=2&&!v.seeking));
  assert.deepEqual((await current()).clips,beforePreview.clips);assert.equal((await current()).media.length,1);assert.equal((await current()).updatedAt,beforePreview.updatedAt);
  await dialog.getByRole('button',{name:'비교 재생',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.enhancement-pictures video')[0].currentTime>1.25);
  await page.evaluate(()=>document.querySelector('.enhancement-pictures video').dispatchEvent(new Event('waiting')));
  const bufferingPause=dialog.getByRole('button',{name:'비교 일시 정지',exact:true});await bufferingPause.waitFor();
  const pauseDisabled=await bufferingPause.isDisabled();observations.push({injectedWaitingEvent:true,pauseDisabled});
  if(!process.argv.includes('--observe-buffering-pause'))assert.equal(pauseDisabled,false,'Pause must remain available while a playing comparison buffers');
  await page.evaluate(()=>document.querySelector('.enhancement-pictures video').dispatchEvent(new Event('canplay')));
  await dialog.getByRole('button',{name:'비교 일시 정지',exact:true}).click();
  const clocks=await page.evaluate(()=>[...document.querySelectorAll('.enhancement-pictures video')].map(v=>v.currentTime));assert.ok(Math.abs(clocks[0]-1-clocks[1])<=.16,JSON.stringify(clocks));
  await dialog.getByLabel('화질 향상 비교 위치',{exact:true}).fill('0.5');await page.waitForFunction(()=>{const [a,b]=document.querySelectorAll('.enhancement-pictures video');return !a.seeking&&!b.seeking&&Math.abs(a.currentTime-1.5)<.02&&Math.abs(b.currentTime-.5)<.02;});
  await page.waitForFunction(()=>!document.querySelector('[aria-label="비교 재생"]').disabled);
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setSize(1100,720);if(win.isVisible())throw Error('Window became visible');});
  await captureElectron(app,{path:path.join(root,'enhancement-comparison-minimum.png')});
  const applyBox=await dialog.getByRole('button',{name:'클립에 적용',exact:true}).boundingBox();assert.ok(applyBox&&applyBox.y+applyBox.height<=720);
  checks.push('Early preview completion stays outside library/history and actual video comparison preserves the selected source offset at minimum layout');

  const previewId=`preview-${call.id}`;await dialog.getByLabel('화질 향상 배율',{exact:true}).selectOption('4');await waitAudit('discarded',previewId);assert.ok((await audit()).discarded.includes(previewId));
  await configure({hold:true,early:false});await dialog.getByRole('button',{name:'2.0초 비교',exact:true}).click();call=await lastCall();assert.equal(call.options.scale,4);
  await dialog.getByRole('button',{name:'닫기',exact:true}).click();await resolve(call.id);await emit(call.id,'complete',{...result,id:`preview-${call.id}`});
  await waitAudit('cancelled',call.id);await waitAudit('discarded',`preview-${call.id}`);const disposed=await audit();assert.ok(disposed.cancelled.includes(call.id));assert.equal(disposed.discarded.filter(id=>id===`preview-${call.id}`).length,1);assert.equal((await current()).media.length,1);
  checks.push('Changing scale disposes the prior preview, and closing pending preview cancels/discards its late result without a library edit');

  await configure({hold:false,early:false});await show();await dialog.getByRole('button',{name:'2.0초 비교',exact:true}).click();call=await lastCall();await emit(call.id,'error');await dialog.getByText('제어된 화질 향상 오류',{exact:true}).waitFor();
  await configure({early:true});await dialog.getByRole('button',{name:'2.0초 비교',exact:true}).click();await lastCall();await dialog.getByRole('button',{name:'비교 재생',exact:true}).waitFor();
  assert.equal(await dialog.getByText('제어된 화질 향상 오류',{exact:true}).count(),0);await dialog.getByRole('button',{name:'닫기',exact:true}).click();
  checks.push('Preview failure is actionable and a real retry clears the old error');

  await configure({hold:true,early:true});await show();await dialog.getByRole('button',{name:'클립에 적용',exact:true}).click();call=await lastCall();await resolve(call.id);await dialog.waitFor({state:'hidden'});await waitApplied();
  const applied=await clip();assert.equal(applied.mediaId,result.id);assert.equal(applied.enhancement.scale,2);assert.equal(applied.x,12);assert.equal(applied.brightness,.12);assert.equal(applied.in,0);assert.equal(applied.enhancement.sourceIn,1);
  await emit(call.id,'complete',result);await clean();assert.equal((await current()).media.length,2);
  await page.keyboard.press('Control+z');await page.waitForFunction(()=>!document.querySelector('.preview-gpu-stage').previewRuntime.project.clips[0].enhancement);assert.equal((await current()).media.length,1);
  await page.keyboard.press('Control+Shift+z');await waitApplied();
  checks.push('Full completion before IPC response applies once, preserves effects/source provenance and remains one undoable edit');

  await select();await page.getByRole('button',{name:'화질 향상 해제',exact:true}).click();assert.equal((await clip()).mediaId,source.id);assert.equal((await clip()).in,1);
  await page.keyboard.press('Control+z');await waitApplied();
  const saved=path.join(root,'enhanced.sluproj');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},saved);await page.keyboard.press('Control+Shift+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();const serialized=JSON.parse(await fs.readFile(saved,'utf8'));assertProject(serialized);await open(saved,project.id);assert.deepEqual((await clip()).enhancement,serialized.clips[0].enhancement);
  checks.push('Restore, undo and actual save/reopen retain a bounded original-source connection');

  for(const kind of ['locked','trimmed','deleted','reopened','revision']){
    await open(fixture,project.id);await configure({hold:false,early:false});await show();await dialog.getByRole('button',{name:'클립에 적용',exact:true}).click();call=await lastCall();await dialog.waitFor({state:'hidden'});await clean();await select();
    if(kind==='locked')await page.locator('.track-row').filter({has:page.getByLabel('트랙 이름 video-1',{exact:true})}).getByTitle('트랙 잠금',{exact:true}).click();
    if(kind==='trimmed'){const field=page.getByRole('spinbutton',{name:'길이',exact:true});await field.fill('1.5');await field.press('Enter');}
    if(kind==='deleted'){await page.locator('[data-clip-id="enhancement-clip"]').focus();await page.keyboard.press('Delete');}
    if(kind==='reopened')await open(fixture,project.id);
    if(kind==='revision'){
      const stat=await fs.stat(source.path);await fs.utimes(source.path,stat.atime,new Date(stat.mtimeMs+1000));
      await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},source.path);
      await page.getByRole('button',{name:'가져오기',exact:true}).first().click();await page.getByText('1개 미디어를 가져왔습니다.',{exact:true}).waitFor();
      assert.notEqual((await current()).media.find(m=>m.id===source.id).sourceRevision,source.sourceRevision);
    }
    await emit(call.id,'complete',result);await page.waitForTimeout(150);const final=await current();assert.ok(final.clips.every(c=>!c.enhancement));assert.equal(final.media.length,kind==='reopened'||kind==='revision'?1:2);
    checks.push(`Completion after ${kind} preserves current edits and ${kind==='reopened'||kind==='revision'?'rejects stale-session/source results':'retains the result only in the library'}`);
  }
  assert.deepEqual(errors,[]);await verifyEditorBuild(evidence);
  report={root,...evidence,mode:'controlled-ipc-real-renderer-and-decoder',checks,errors,observations,audit:await audit()};
}catch(error){await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({root,evidence,checks,errors,observations,error:String(error),project:await current().catch(()=>null),audit:await audit().catch(()=>null)},null,2));throw error;}
finally{await app.close();}
await fs.writeFile(path.join(root,'results.json'),JSON.stringify({...report,passed:true,completedAt:new Date().toISOString()},null,2));
await fs.writeFile(pointer,root+'\n');
console.log(JSON.stringify({root,checks:checks.length,errors,observations}));
