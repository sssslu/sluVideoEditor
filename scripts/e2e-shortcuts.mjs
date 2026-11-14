// CapCut-style shortcuts (Ctrl+B, Q/W, ↑/↓, Ctrl+X, N, Ctrl+=/-, Shift+Z, Alt+G, Ctrl+E,
// Ctrl+I, Ctrl+N) and removing gaps from the track context menu.
import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const root=path.resolve('.test-artifacts/shortcuts-ui');await fs.mkdir(root,{recursive:true});
const video=path.join(root,'clip.mp4');
execFileSync(path.resolve('resources/bin/ffmpeg.exe'),['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=320x180:r=30:d=10','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=10','-c:v','libx264','-preset','ultrafast','-g','15','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
const env={...process.env,SLU_USER_DATA:path.join(root,`profile-${Date.now()}`),SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000}),page=await app.firstWindow();
const errors=[],checks=[];page.on('pageerror',error=>errors.push(String(error)));page.on('dialog',d=>d.accept());
const project=()=>page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project);
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);};
const near=(a,b,tolerance=1e-6)=>Math.abs(a-b)<=tolerance;
// [start, duration, in] of the video track's clips, in timeline order.
const layout=async()=>(await project()).clips.filter(c=>c.trackId==='video-1').sort((a,b)=>a.start-b.start).map(c=>[c.start,c.duration,c.in].map(v=>Math.round(v*1000)/1000));
const waitLayout=async expected=>{const want=JSON.stringify(expected);await page.waitForFunction(want=>JSON.stringify(document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.filter(c=>c.trackId==='video-1').sort((a,b)=>a.start-b.start).map(c=>[c.start,c.duration,c.in].map(v=>Math.round(v*1000)/1000)))===want,want,{timeout:10000}).catch(()=>{});return layout();};
const time=()=>page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.time());
const focusProgram=()=>page.getByRole('button',{name:'프로그램',exact:true}).first().click();
async function seekTo(seconds){await focusProgram();await page.keyboard.press('Home');for(let i=0;i<seconds;i++)await page.keyboard.press('Shift+ArrowRight');await page.waitForFunction(s=>Math.abs(document.querySelector('.preview-gpu-stage').previewRuntime.time()-s)<1e-6,seconds);}
async function clipAt(seconds){const p=await project();return p.clips.find(c=>c.trackId==='video-1'&&c.start<=seconds&&c.start+c.duration>seconds);}
async function laneX(seconds){const lane=await page.locator('.track-lane.lane-video').first().boundingBox(),first=(await project()).clips.filter(c=>c.trackId==='video-1').sort((a,b)=>a.start-b.start)[0],box=await page.locator(`[data-clip-id="${first.id}"]`).boundingBox();const perSecond=box.width/first.duration;return {x:box.x-first.start*perSecond+seconds*perSecond,y:lane.y+lane.height/2};}
async function laneMenu(seconds,item){const {x,y}=await laneX(seconds);await page.mouse.click(x,y,{button:'right'});const entry=page.getByRole('menuitem',{name:item});await entry.waitFor();const label=await entry.innerText();await entry.click();return label;}
try{
  await page.waitForLoadState('domcontentloaded');await page.locator('.track-lane.lane-video').first().waitFor();
  await page.evaluate(()=>{const input=document.createElement('input');input.type='file';input.id='e2e-file';input.style.display='none';document.body.append(input);});
  await page.setInputFiles('#e2e-file',[video]);
  await page.evaluate(()=>{const t=new DataTransfer();for(const f of document.getElementById('e2e-file').files)t.items.add(f);const lane=document.querySelector('.track-lane.lane-video'),r=lane.getBoundingClientRect(),init={bubbles:true,cancelable:true,dataTransfer:t,clientX:r.left+2,clientY:r.top+10};lane.dispatchEvent(new DragEvent('dragover',init));lane.dispatchEvent(new DragEvent('drop',init));});
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===1,null,{timeout:60000});await dismissToasts(page);

  // Ctrl+B splits under the playhead, then only the selected piece.
  await focusProgram();await page.keyboard.press('Escape');await seekTo(2);await page.keyboard.press('Control+b');
  check('Ctrl+B splits at the playhead',JSON.stringify(await waitLayout([[0,2,0],[2,8,2]]))==='[[0,2,0],[2,8,2]]',await layout());
  await seekTo(4);await page.keyboard.press('Control+b');
  check('Ctrl+B splits the selected piece',JSON.stringify(await waitLayout([[0,2,0],[2,2,2],[4,6,4]]))==='[[0,2,0],[2,2,2],[4,6,4]]',await layout());
  // ↑ / ↓ walk clip boundaries.
  const walk=[];for(const key of ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowDown']){await page.keyboard.press(key);await page.waitForTimeout(80);walk.push(Math.round(await time()*1000)/1000);}
  check('↑ / ↓ jump between edit points',JSON.stringify(walk)==='[2,0,2,4,10]',walk);

  // Delete the middle piece, then close that one gap from the lane menu.
  await page.locator(`[data-clip-id="${(await clipAt(3)).id}"]`).click();await page.keyboard.press('Delete');
  await waitLayout([[0,2,0],[4,6,4]]);
  const single=await laneMenu(3,/이 여백 제거/);
  check('lane menu removes the gap under the pointer',single.includes('2.00초')&&JSON.stringify(await waitLayout([[0,2,0],[2,6,4]]))==='[[0,2,0],[2,6,4]]',{single,layout:await layout()});

  // Q / W trim at the playhead; with ripple on, Q pulls the rest back.
  await focusProgram();await page.keyboard.press('Escape');await seekTo(3);await page.keyboard.press('q');
  check('Q deletes left of the playhead',JSON.stringify(await waitLayout([[0,2,0],[3,5,5]]))==='[[0,2,0],[3,5,5]]',await layout());
  await seekTo(6);await page.keyboard.press('w');
  check('W deletes right of the playhead',JSON.stringify(await waitLayout([[0,2,0],[3,3,5]]))==='[[0,2,0],[3,3,5]]',await layout());
  await page.getByTitle('리플 삭제',{exact:true}).click();await seekTo(4);await page.keyboard.press('q');
  check('Q with ripple closes the space and moves the playhead',JSON.stringify(await waitLayout([[0,2,0],[3,2,6]]))==='[[0,2,0],[3,2,6]]'&&near(await time(),3),{layout:await layout(),time:await time()});
  await page.getByTitle('리플 삭제',{exact:true}).click();

  // Remove every gap on the track.
  const all=await laneMenu(7,/이 트랙 여백 전체 제거/);
  check('lane menu removes all gaps on the track',all.includes('1곳')&&JSON.stringify(await waitLayout([[0,2,0],[2,2,6]]))==='[[0,2,0],[2,2,6]]',{all,layout:await layout()});

  // Ctrl+X cuts; Ctrl+V pastes at the playhead.
  await page.locator(`[data-clip-id="${(await clipAt(1)).id}"]`).click();await page.keyboard.press('Control+x');
  await waitLayout([[2,2,6]]);await seekTo(4);await page.keyboard.press('Control+v');
  check('Ctrl+X then Ctrl+V moves a clip',JSON.stringify(await waitLayout([[2,2,6],[4,2,0]]))==='[[2,2,6],[4,2,0]]',await layout());

  // N, Ctrl+= / Ctrl+-, Shift+Z.
  const snap=page.getByTitle('스냅 전환 (N) · Alt 드래그로 일시 해제',{exact:true}),snapped=async()=>(await snap.getAttribute('class')).includes('active');
  const before=await snapped();await focusProgram();await page.keyboard.press('n');await page.waitForTimeout(100);
  check('N toggles snapping',(await snapped())!==before,{before,after:await snapped()});await page.keyboard.press('n');
  const zoom=()=>page.getByLabel('타임라인 확대 비율',{exact:true}).inputValue().then(Number);
  const z0=await zoom();await page.keyboard.press('Control+Equal');await page.waitForTimeout(150);const z1=await zoom();await page.keyboard.press('Control+Minus');await page.keyboard.press('Control+Minus');await page.waitForTimeout(150);const z2=await zoom();
  await page.keyboard.press('Shift+Z');await page.waitForTimeout(150);const z3=await zoom();
  check('Ctrl+= / Ctrl+- zoom and Shift+Z fits',z1>z0&&z2<z1&&z3!==z2,{z0,z1,z2,z3});

  // Combine only from the menu or Alt+G; the inspector no longer offers it.
  await page.locator(`[data-clip-id="${(await clipAt(3)).id}"]`).click();await page.keyboard.press('Control+a');
  check('the inspector has no combine button',!(await page.getByRole('button',{name:'선택 항목 합치기 (렌더링)'}).count()),null);
  await page.locator(`[data-clip-id="${(await clipAt(3)).id}"]`).click({button:'right'});
  check('the clip menu offers combining the selection',await page.getByRole('menuitem',{name:/선택한 2개 합치기 \(렌더링\)/}).count()===1,null);
  await page.keyboard.press('Escape');
  await page.locator(`[data-clip-id="${(await clipAt(3)).id}"]`).click();await page.keyboard.press('Control+a');await page.keyboard.press('Alt+g');
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===1&&!!document.querySelector('.preview-gpu-stage').previewRuntime.project.clips[0].compound,null,{timeout:180000});
  await focusProgram();await page.keyboard.press('Alt+Shift+G');
  check('Alt+G combines and Alt+Shift+G restores',JSON.stringify(await waitLayout([[2,2,6],[4,2,0]]))==='[[2,2,6],[4,2,0]]',await layout());
  await dismissToasts(page);

  // Ctrl+E, ?, Ctrl+I, Ctrl+N.
  await focusProgram();await page.keyboard.press('Control+e');
  check('Ctrl+E opens export',await page.getByRole('dialog').getByText('내보내기',{exact:false}).first().isVisible(),null);await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Slash');const shortcuts=await page.getByRole('dialog').innerText();
  check('the shortcut list shows the CapCut keys',['Ctrl + B','Q / W','Alt + G','↑ / ↓','Shift + Z','Ctrl + E'].every(key=>shortcuts.includes(key)),shortcuts.slice(0,200));await page.keyboard.press('Escape');
  await app.evaluate(({dialog})=>{globalThis.__importAsked=0;dialog.showOpenDialog=async()=>{globalThis.__importAsked++;return {canceled:true,filePaths:[]};};});
  await focusProgram();await page.keyboard.press('Control+i');await page.waitForTimeout(500);
  check('Ctrl+I opens import',await app.evaluate(()=>globalThis.__importAsked)===1,null);
  await page.keyboard.press('Control+n');await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===0,null,{timeout:10000});
  check('Ctrl+N starts a new project',true,null);
  check('no page errors',!errors.length,errors);
}finally{
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({checks,errors},null,2));
  await app.close();
}
console.log(`shortcuts UI: ${checks.filter(c=>c.ok).length}/${checks.length} checks passed`);
