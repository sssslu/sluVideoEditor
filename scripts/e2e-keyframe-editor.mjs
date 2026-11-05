import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {editorEvidence,verifyEditorBuild} from './e2e-release-evidence.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {newProject,newClip} from '../shared/project.ts';
import {defaultCaptionStyle} from '../shared/captions.ts';
import {assertProject} from '../shared/validation.ts';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';

const root=path.resolve('.test-artifacts/keyframe-editor-ui',Date.now().toString());
await fs.mkdir(root,{recursive:true});
const pointer=path.resolve(`.test-artifacts/keyframe-editor-ui-current-${process.env.SLU_TEST_EXE?'packaged':'source'}.txt`);
await fs.rm(pointer,{force:true});
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const env={...process.env,SLU_TEST_BACKGROUND:'1',SLU_USER_DATA:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000});
const page=await app.firstWindow(),checks=[],errors=[];
page.on('pageerror',error=>errors.push(String(error)));
const current=()=>page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project);
const animated=project=>project.clips.find(clip=>clip.id==='animated');
const keys=async()=>animated(await current()).keyframes;
async function expectKeys(expected){
  await page.waitForFunction(expected=>JSON.stringify(document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.find(c=>c.id==='animated').keyframes)===JSON.stringify(expected),expected);
}
async function select(id){
  await dismissToasts(page);
  const p=await current(),clip=p.clips.find(c=>c.id===id);
  await page.locator(`[data-track-id="${clip.trackId}"]`).scrollIntoViewIfNeeded();
  await page.locator(`[data-clip-id="${id}"]`).focus();
  await page.locator(`[data-clip-id="${id}"]`).press('Enter');
}
async function open(file,id){
  await dismissToasts(page);
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
  await page.keyboard.press('Control+o');
  await page.waitForFunction(id=>document.querySelector('.preview-gpu-stage')?.previewRuntime.project.id===id,id);
  await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();
  await dismissToasts(page);
}
async function pointBox(index){
  const point=page.getByRole('button',{name:`키프레임 ${index+1} 그래프 점`,exact:true});
  await point.scrollIntoViewIfNeeded();const box=await point.boundingBox();assert.ok(box);
  return {x:box.x+box.width/2,y:box.y+box.height/2};
}
async function drag(index,dx,dy){
  const origin=await pointBox(index);await page.mouse.move(origin.x,origin.y);await page.mouse.down();
  await page.mouse.move(origin.x+dx,origin.y+dy,{steps:8});await page.mouse.up();
  return origin;
}
const point=(time,x)=>({time,x,y:x/2,scale:1+x/200,opacity:.8-x/500,rotation:x,easing:'ease-in-out',easingStart:.15,easingEnd:.85});
const project=newProject();project.id='keyframe-editor';project.name='키프레임 검사';project.width=640;project.height=360;project.fps=30;
project.clips=[{...newClip('text-1'),id:'animated',name:'그래프',text:'키프레임',start:0,duration:4,fontSize:28,captionStyle:defaultCaptionStyle(),keyframes:[point(0,0),point(2,100),point(4,40)]},{...newClip('text-1'),id:'other',name:'다른 클립',text:'다른 클립',start:5,duration:2,fontSize:28,captionStyle:defaultCaptionStyle()}];
assertProject(project);
const file=path.join(root,'input.sluproj');await fs.writeFile(file,JSON.stringify(project));
let evidence,result;
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
  evidence=await editorEvidence(app,import.meta.url);
  await open(file,project.id);await select('animated');
  const initial=await keys();
  for(const [property,label] of [['x','위치 X'],['y','위치 Y'],['scale','크기'],['rotation','회전'],['opacity','불투명도']]){
    await page.getByLabel('키프레임 속성',{exact:true}).selectOption(property);
    assert.equal(await page.getByRole('group',{name:`${label} 키프레임 그래프`,exact:true}).count(),1);
    assert.equal(await page.locator('[data-keyframe-point]').count(),3);
    assert.deepEqual(await keys(),initial);
  }
  checks.push('Five property graphs display the existing coupled keys without changing project data');
  await page.getByLabel('키프레임 속성',{exact:true}).selectOption('x');
  await drag(1,22,-18);
  const dragged=await keys();assert.ok(dragged[1].time>2&&dragged[1].time<4);assert.ok(dragged[1].x>100);
  assert.ok(Math.abs(dragged[1].time*30-Math.round(dragged[1].time*30))<1e-9);
  for(const property of ['y','scale','opacity','rotation','easing','easingStart','easingEnd'])assert.equal(dragged[1][property],initial[1][property]);
  await page.keyboard.press('Control+z');await expectKeys(initial);
  await page.keyboard.press('Control+Shift+z');await expectKeys(dragged);
  checks.push('Real multi-step pointer drag changes only selected value/common time and is exactly one undoable edit');

  // Multiple native-style pointer events can arrive before React commits props.
  const beforeBurst=await keys(),origin=await pointBox(1);
  await page.mouse.move(origin.x,origin.y);await page.mouse.down();
  await page.evaluate(origin=>{
    for(const dy of [-3,-9,-18])window.dispatchEvent(new PointerEvent('pointermove',{clientX:origin.x,clientY:origin.y+dy,buttons:1,bubbles:true}));
    window.dispatchEvent(new PointerEvent('pointerup',{clientX:origin.x,clientY:origin.y-18,buttons:0,bubbles:true}));
  },origin);
  await page.mouse.up();
  const afterBurst=await keys();
  const graph=await page.locator('.keyframe-graph').boundingBox();assert.ok(graph);
  const high=Math.max(0,...beforeBurst.map(k=>k.x)),low=Math.min(0,...beforeBurst.map(k=>k.x));
  const range=Math.max(200,(high-low)*1.25),expectedDelta=18/graph.height*142/(142-12-23)*range;
  assert.ok(Math.abs(afterBurst[1].x-beforeBurst[1].x-expectedDelta)<.2,JSON.stringify({before:beforeBurst[1].x,after:afterBurst[1].x,expectedDelta}));
  await page.keyboard.press('Control+z');await expectKeys(beforeBurst);
  checks.push('Batched pointer moves reach their final position and remain one undo operation');

  const beforeUndoDrag=await keys(),undoOrigin=await pointBox(1);
  await page.mouse.move(undoOrigin.x,undoOrigin.y);await page.mouse.down();await page.mouse.move(undoOrigin.x+4,undoOrigin.y-4);
  await page.keyboard.press('Control+z');await expectKeys(beforeUndoDrag);
  await page.mouse.move(undoOrigin.x+30,undoOrigin.y-30);await page.mouse.up();await expectKeys(beforeUndoDrag);
  checks.push('Undo during an active drag cancels pending pointer edits and cannot be overwritten by later motion');

  await page.getByLabel('키프레임 속성',{exact:true}).selectOption('opacity');
  const beforeKeyboard=await keys(),middle=page.getByRole('button',{name:'키프레임 2 그래프 점',exact:true});
  await middle.focus();await middle.press('ArrowUp');
  const keyboard=await keys();assert.ok(Math.abs(keyboard[1].opacity-beforeKeyboard[1].opacity-.01)<1e-9);assert.equal(keyboard[1].time,beforeKeyboard[1].time);
  assert.equal((await current()).clips.length,2);assert.equal(animated(await current()).start,0);
  await page.keyboard.press('Control+z');await expectKeys(beforeKeyboard);
  await drag(1,0,-180);assert.equal((await keys())[1].opacity,1);
  await page.keyboard.press('Control+z');await expectKeys(beforeKeyboard);
  await middle.focus();await middle.press('Delete');assert.equal((await keys()).length,2);assert.equal((await current()).clips.length,2);
  await page.keyboard.press('Control+z');await expectKeys(beforeKeyboard);
  checks.push('Graph keyboard edits and deletion leave the clip intact, and pointer values clamp to existing limits');

  await page.getByLabel('키프레임 1 보간',{exact:true}).selectOption('ease-in');
  const eased=await keys();assert.equal(eased[0].easing,'ease-in');assert.equal(eased[0].easingStart,undefined);assert.equal(eased[0].easingEnd,undefined);
  await page.getByTitle('이전 키프레임',{exact:true}).click();
  const time=await page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.time());assert.ok(time<.01);
  await page.getByTitle('현재 키프레임 삭제',{exact:true}).click();assert.equal((await keys()).length,2);
  await page.getByTitle('현재 위치에 키프레임 추가',{exact:true}).click();assert.equal((await keys()).length,3);
  await page.keyboard.press('Control+z');await page.keyboard.press('Control+z');await expectKeys(eased);
  checks.push('Existing easing, navigation and current-position add/delete controls remain functional');

  await page.getByLabel('키프레임 속성',{exact:true}).selectOption('x');
  const changing=await pointBox(1);await page.mouse.move(changing.x,changing.y);await page.mouse.down();
  await page.mouse.move(changing.x+4,changing.y-4);
  await select('other');const selectionState=await current();
  await page.mouse.move(changing.x+28,changing.y-24);await page.mouse.up();
  assert.deepEqual((await current()).clips,selectionState.clips);
  assert.equal((await current()).clips.find(c=>c.id==='other').keyframes.length,0);
  checks.push('Changing clip selection during a drag cancels the old gesture without editing the newly selected clip');

  await select('animated');const locking=await pointBox(1);await page.mouse.move(locking.x,locking.y);await page.mouse.down();await page.mouse.move(locking.x+3,locking.y-3);
  const trackRow=page.locator('.track-row').filter({has:page.getByLabel('트랙 이름 text-1',{exact:true})});
  const lock=trackRow.getByTitle('트랙 잠금',{exact:true});await lock.focus();await lock.press('Enter');
  const locked=await current();assert.equal(locked.tracks.find(t=>t.id==='text-1').locked,true);
  await page.mouse.move(locking.x+40,locking.y-40);await page.mouse.up();assert.deepEqual((await current()).clips,locked.clips);
  assert.equal(await page.getByRole('button',{name:'키프레임 2 그래프 점',exact:true}).getAttribute('aria-disabled'),'true');
  await trackRow.getByTitle('트랙 잠금 해제',{exact:true}).click();
  checks.push('Locking the track cancels an active drag and disables further graph edits');

  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setSize(1100,720);if(win.isVisible())throw Error('Test window became visible');});
  await page.getByLabel('키프레임 속성',{exact:true}).selectOption('scale');
  const minimumPoint=await pointBox(1);
  const hit=await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.getAttribute('data-keyframe-point'),minimumPoint);assert.equal(hit,'1');
  const minimumBefore=await keys();await drag(1,0,-5);assert.ok((await keys())[1].scale>minimumBefore[1].scale);
  await captureElectron(app,{path:path.join(root,'keyframes-minimum.png')});
  checks.push('At the supported minimum window size the point remains visible, hittable and editable');

  const saved=path.join(root,'saved.sluproj');await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},saved);
  await page.keyboard.press('Control+Shift+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();
  const beforeSave=await current(),persisted=JSON.parse(await fs.readFile(saved,'utf8'));assertProject(persisted);
  assert.deepEqual(persisted.clips,JSON.parse(JSON.stringify(beforeSave.clips)));
  await open(saved,project.id);assert.deepEqual(JSON.parse(JSON.stringify((await current()).clips)),JSON.parse(JSON.stringify(beforeSave.clips)));
  checks.push('Actual project save and reopen preserve all edited keyframes and easing metadata');
  assert.deepEqual(errors,[]);await verifyEditorBuild(evidence);
  result={root,...evidence,checks,errors};
}catch(error){
  await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});
  await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({root,checks,errors,error:String(error),project:await current().catch(()=>null),evidence},null,2));
  throw error;
}finally{await app.close();}
await fs.writeFile(path.join(root,'results.json'),JSON.stringify({...result,passed:true,completedAt:new Date().toISOString()},null,2));
await fs.writeFile(pointer,root+'\n');
console.log(JSON.stringify({root,checks:checks.length,errors}));
