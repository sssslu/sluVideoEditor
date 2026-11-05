import {electronTestArgs,launchTestElectron,queueConfirmResponses,readQuietDialogs} from './e2e-launch.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const expectedVersion=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const root=path.resolve('.test-artifacts/e2e');await fs.mkdir(root,{recursive:true});
const data=path.join(root,`profile-${Date.now()}`);await fs.mkdir(path.join(data,'models'),{recursive:true});
const model=path.resolve('.test-artifacts/services/models/ggml-base.bin');try{await fs.link(model,path.join(data,'models','ggml-base.bin'));}catch{}
const env={...process.env,SLU_USER_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(process.env.SLU_TEST_EXE?{executablePath:path.resolve(process.env.SLU_TEST_EXE),args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000});
const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
let saved=path.join(root,'ui-project.sluproj');const exportPath=path.join(root,'ui-export.mp4');
async function saveSnapshot(){await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},saved);await page.keyboard.press('Control+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();return JSON.parse(await fs.readFile(saved,'utf8'));}
async function setOpen(files){await app.evaluate(({dialog},files)=>{globalThis.testOpenCalls=0;dialog.showOpenDialog=async()=>{globalThis.testOpenCalls++;return {canceled:false,filePaths:files};};},files);}
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();await page.screenshot({path:path.join(root,'01-empty.png')});
  const media=path.resolve('examples/01 - Aurora motion.mp4');await setOpen([media]);await page.getByRole('button',{name:'가져오기',exact:true}).first().click();
  await page.getByTitle('01 - Aurora motion.mp4 타임라인에 추가').waitFor({timeout:60000});await page.locator('.media-card').first().hover();await page.getByTitle('01 - Aurora motion.mp4 타임라인에 추가').click();
  await page.locator('.gpu-media-decoders video').first().waitFor({state:'attached'});await page.waitForFunction(()=>{const v=document.querySelector('.gpu-media-decoders video');return v&&v.readyState>=2&&!v.error;},{timeout:30000});
  assert.equal(await page.locator('.timeline-clip').count(),1);
  await page.getByRole('button',{name:'프로그램',exact:true}).click();await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage')?.previewRuntime.time()>.3,null,{timeout:15000});await page.keyboard.press('Space');
  await page.keyboard.press('Home');await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('s');assert.equal(await page.locator('.timeline-clip').count(),2);
  await page.keyboard.press('Control+z');assert.equal(await page.locator('.timeline-clip').count(),1);await page.keyboard.press('Control+Shift+z');assert.equal(await page.locator('.timeline-clip').count(),2);
  await page.locator('.timeline-clip').last().click();await page.keyboard.press('Control+d');assert.equal(await page.locator('.timeline-clip').count(),3);await page.keyboard.press('Control+z');assert.equal(await page.locator('.timeline-clip').count(),2);
  await page.getByRole('button',{name:'텍스트',exact:true}).first().click();await page.getByRole('button',{name:'줄 배경 텍스트 삽입',exact:true}).click();await page.getByLabel('텍스트 내용',{exact:true}).fill('한국어 자막 테스트\n두 번째 줄');await page.getByLabel('텍스트 내용',{exact:true}).blur();
  const snapshot=await saveSnapshot();assert.equal(snapshot.media.length,1);assert.equal(snapshot.clips.length,3);assert.ok(snapshot.clips.some(c=>c.text?.includes('한국어 자막 테스트')));
  await page.keyboard.press('Shift+ArrowRight');await page.screenshot({path:path.join(root,'02-editing.png')});
  await page.getByRole('button',{name:'내보내기',exact:true}).click();await page.getByLabel('출력 너비',{exact:true}).fill('640');await page.getByLabel('출력 높이',{exact:true}).fill('360');
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exportPath);
  await page.getByRole('button',{name:'내보내기 시작',exact:true}).click();await page.getByText('영상 내보내기가 완료되었습니다.',{exact:true}).waitFor({timeout:120000});assert.ok((await fs.stat(exportPath)).size>10000);await page.screenshot({path:path.join(root,'03-export-complete.png')});
  // Exercise both save-confirmation branches through the real editor while
  // the test launcher handles the synchronous decision without a native box.
  const projectName=page.getByLabel('프로젝트 이름',{exact:true});
  await projectName.fill('저장 확인 검사');await projectName.blur();
  const confirmations=async()=> (await readQuietDialogs(app)).renderer.flatMap(item=>item.records).filter(item=>item.type==='confirm');
  const confirmationCount=(await confirmations()).length;
  await setOpen([path.resolve('examples/AURORA.sluproj')]);
  await queueConfirmResponses(page,[false]);await page.keyboard.press('Control+o');
  assert.equal(await projectName.inputValue(),'저장 확인 검사');
  assert.equal(await app.evaluate(()=>globalThis.testOpenCalls),0);
  const cancelledConfirmation=await confirmations();
  assert.equal(cancelledConfirmation.length,confirmationCount+1);
  assert.equal(cancelledConfirmation.at(-1).response,false);
  assert.ok(cancelledConfirmation.at(-1).message.includes('저장하지 않은 변경 사항'));
  await queueConfirmResponses(page,[true]);await page.keyboard.press('Control+o');
  await page.waitForFunction(()=>document.querySelector('input[aria-label="프로젝트 이름"]')?.value==='편집 예제');
  assert.equal(await app.evaluate(()=>globalThis.testOpenCalls),1);
  const acceptedConfirmation=await confirmations();
  assert.equal(acceptedConfirmation.length,confirmationCount+2);
  assert.equal(acceptedConfirmation.at(-1).response,true);
  await page.keyboard.press('Home');await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Shift+ArrowRight');await page.waitForFunction(()=>{const v=document.querySelector('.gpu-media-decoders video');return v&&v.readyState>=2&&Math.abs(v.currentTime-2)<.15;});await page.waitForTimeout(250);await page.screenshot({path:path.join(root,'04-demo.png')});
  await page.getByRole('button',{name:'설정',exact:true}).click();await page.getByText('NVIDIA GeForce RTX 4080 SUPER',{exact:true}).first().waitFor({timeout:60000});const system=await page.evaluate(()=>window.studio.getSystemInfo());assert.equal(system.version,expectedVersion,'Unexpected application version');assert.ok(system.encoders.includes('h264_nvenc'));assert.ok(system.modelReady);
  await page.getByTitle('키보드 단축키',{exact:true}).click();assert.ok(await page.getByRole('dialog').isVisible());await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({date:new Date().toISOString(),version:system.version,executable,system,checks:['Desktop launch and secure IPC','Import and decode real video','Playback clock advances','Split, undo, redo, duplicate','Style text with Korean and newline','Native save workflow roundtrip','Export dialog and actual output','Unsaved-project cancellation preserves edits and does not open the file picker','Unsaved-project acceptance opens the selected project through the real editor','Open sample project','Model ready and NVENC detection','Shortcut dialog'],errors,profile:data,output:exportPath},null,2));
  console.log('E2E passed:',root);
}catch(error){await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});console.error(await page.locator('body').innerText());throw error;}
finally{await app.close();}
