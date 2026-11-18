import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {editorEvidence,verifyEditorBuild} from './e2e-release-evidence.mjs';

const root=path.resolve('.test-artifacts/usability-ui');await fs.mkdir(root,{recursive:true});
const work=await fs.mkdtemp(path.join(root,'run-')),profile=path.join(work,'profile'),recovery=path.join(profile,'recovery.sluproj');
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null,env={...process.env,SLU_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000});
const page=await app.firstWindow(),checks=[],errors=[];page.on('pageerror',e=>errors.push(String(e)));
const number=async(label,value)=>{const input=page.getByLabel(label,{exact:true});await input.fill(String(value));await input.press('Enter');return input;};
async function snapshot(predicate){let last;for(const start=Date.now();Date.now()-start<20000;){try{last=JSON.parse(await fs.readFile(recovery,'utf8'));if(predicate(last))return last;}catch{}await new Promise(r=>setTimeout(r,80));}throw Error(`Snapshot timeout: ${JSON.stringify(last)?.slice(0,1600)}`);}
async function open(file){await dismissToasts(page);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();}
async function beginDrag(locator,dx,dy){await dismissToasts(page);await locator.scrollIntoViewIfNeeded();const b=await locator.boundingBox(),x=b.x+b.width/2,y=b.y+b.height/2;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y+dy,{steps:5});return {x,y};}
const state=()=>page.evaluate(()=>structuredClone(document.querySelector('.preview-gpu-stage').previewRuntime.project));
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1520,980));
  const evidence=await editorEvidence(app,import.meta.url),system=await page.evaluate(()=>window.studio.getSystemInfo());
  assert.equal(await (await number('너비',1919)).inputValue(),'1920');
  assert.equal(await (await number('너비',2001)).inputValue(),'2002');await snapshot(p=>p.width===2002);
  const width=page.getByLabel('너비',{exact:true});await width.fill('5000');await width.press('Escape');assert.equal(await width.inputValue(),'2002');
  checks.push('Numeric fields show the applied rounded value even when the parent value does not change; Escape preserves the project value');

  const f=JSON.parse(await fs.readFile('.test-artifacts/color-render/fixture.json','utf8')),original=f.project.clips[0];
  const fixture={...f.project,id:'usability-color',colorLuts:[],clips:[{...original,id:'usability-video',duration:Math.min(original.duration,4),colorGrade:undefined}]};
  const file=path.join(work,'color.sluproj');await fs.writeFile(file,JSON.stringify(fixture));await open(file);await snapshot(p=>p.id===fixture.id);
  await page.locator('[data-clip-id="usability-video"]').click();await page.locator('.inspector-tabs').getByRole('button',{name:'색상',exact:true}).click();
  const slider=page.getByLabel('밝기',{exact:true}),before=(await state()).clips[0].brightness;await slider.focus();
  for(let i=0;i<6;i++)await page.keyboard.down('ArrowRight');await page.keyboard.up('ArrowRight');await snapshot(p=>p.clips[0].brightness>before);
  await page.getByRole('button',{name:'프로그램',exact:true}).click();await page.keyboard.press('Control+z');await snapshot(p=>p.clips[0].brightness===before);
  checks.push('Holding a slider arrow is one undoable gesture');

  const point=page.getByRole('button',{name:'색상 제어점 2',exact:true}),beforeCurve=(await state()).clips[0].colorGrade;
  let origin=await beginDrag(point,-8,35);await snapshot(p=>!!p.clips[0].colorGrade);await page.keyboard.press('Control+z');
  await page.mouse.move(origin.x-15,origin.y+60);await page.mouse.up();await snapshot(p=>JSON.stringify(p.clips[0].colorGrade)===JSON.stringify(beforeCurve));
  assert.deepEqual((await state()).clips[0].colorGrade,beforeCurve);checks.push('Undo during a color curve drag cancels the drag and preserves the undone value');
  origin=await beginDrag(point,-8,25);const escaped=(await state()).clips[0].colorGrade;await page.keyboard.press('Escape');await page.mouse.move(origin.x-15,origin.y+65);await page.mouse.up();
  assert.deepEqual((await state()).clips[0].colorGrade,escaped);checks.push('Escape ends the active color curve drag');

  const videoPath=path.resolve('examples/01 - Aurora motion.mp4');await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},videoPath);await page.getByRole('button',{name:'가져오기',exact:true}).first().click();
  const imported=await snapshot(p=>p.media.some(m=>m.path===videoPath)),video=imported.media.find(m=>m.path===videoPath),proxy=path.join(work,'external-color-proxy.mp4');await fs.copyFile(video.path,proxy);video.proxyPath=proxy;await fs.writeFile(file,JSON.stringify(imported));await open(file);
  await page.getByRole('button',{name:'미디어',exact:true}).first().click();await page.getByRole('button',{name:video.name+' 소스 열기',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.source-monitor video')?.readyState>=2);
  await page.locator('.source-view').click();await page.keyboard.press('Shift+ArrowRight');const sourceTime=Number(await page.getByLabel('소스 재생 위치',{exact:true}).inputValue());
  await page.keyboard.press('i');await page.getByRole('button',{name:'설정',exact:true}).click();await page.getByRole('switch',{name:'프록시 우선 미리보기',exact:true}).uncheck();
  await page.waitForFunction(()=>document.querySelector('.source-monitor video')?.readyState>=2);
  assert.equal(Number(await page.getByLabel('소스 재생 위치',{exact:true}).inputValue()),sourceTime);
  assert.equal(Number(await page.getByLabel('소스 시작점',{exact:true}).inputValue()),sourceTime);
  const actualTime=await page.locator('.source-monitor video').evaluate(el=>el.currentTime);assert.ok(Math.abs(actualTime-sourceTime)<.04);
  checks.push('Switching an existing source proxy preserves source position and I/O range');
  await page.getByTitle('소스 재생 (Space)',{exact:true}).click();await page.getByRole('button',{name:'프로그램',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.source-monitor video').paused);checks.push('Leaving source mode pauses playback');

  await open(path.resolve('.test-artifacts/audio-fixture/fixture.sluproj'));await page.locator('[data-clip-id="eq-audio-clip"]').click();await page.locator('.inspector-tabs').getByRole('button',{name:'오디오',exact:true}).click();
  const eqPoint=page.getByRole('slider',{name:'EQ 밴드 3 주파수',exact:true}),eqBefore=(await state()).clips.find(c=>c.id==='eq-audio-clip').audioEQ;
  origin=await beginDrag(eqPoint,25,-15);await snapshot(p=>!!p.clips.find(c=>c.id==='eq-audio-clip').audioEQ);await page.keyboard.press('Control+z');
  await page.mouse.move(origin.x+50,origin.y-25);await page.mouse.up();await snapshot(p=>JSON.stringify(p.clips.find(c=>c.id==='eq-audio-clip').audioEQ)===JSON.stringify(eqBefore));
  assert.deepEqual((await state()).clips.find(c=>c.id==='eq-audio-clip').audioEQ,eqBefore);checks.push('Undo during an EQ drag releases capture and preserves the undone value');
  origin=await beginDrag(eqPoint,25,-15);const eqEscaped=(await state()).clips.find(c=>c.id==='eq-audio-clip').audioEQ;await page.keyboard.press('Escape');await page.mouse.move(origin.x+50,origin.y-25);await page.mouse.up();
  assert.deepEqual((await state()).clips.find(c=>c.id==='eq-audio-clip').audioEQ,eqEscaped);checks.push('Escape ends the active EQ drag');
  assert.deepEqual(errors,[]);await captureElectron(app,{path:path.join(work,'editor.png')});await verifyEditorBuild(evidence);
  const result={...evidence,version:system.version,executable,checks,errors,passed:true};await fs.writeFile(path.join(root,'results.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(work,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({checks,errors}));
}catch(error){await fs.writeFile(path.join(work,'failure.json'),JSON.stringify({checks,errors,error:String(error)},null,2));throw error;}finally{await app.close();}
