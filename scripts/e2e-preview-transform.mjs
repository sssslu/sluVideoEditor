// Program monitor direct manipulation: click to select, drag to move with snap guides,
// corner handles to scale, the rotate handle to rotate, and empty space to deselect.
import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=path.resolve('.test-artifacts/preview-transform');await fs.mkdir(root,{recursive:true});
const profile=path.join(root,'profile-'+Date.now()),env={...process.env,SLU_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const example=JSON.parse(await fs.readFile('examples/AURORA.sluproj','utf8'));
const video=example.clips.find(c=>c.trackId==='video-1'),title=example.clips.find(c=>c.text==='편집 예제');
const project={...example,id:'preview-transform-'+Date.now(),media:example.media.map(m=>({...m,path:path.resolve('examples',m.name).replaceAll('\\','/')})),clips:[{...video,scale:.5},{...title,x:200,y:-200}]};
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000}),page=await app.firstWindow(),errors=[],checks=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
// Page functions reach the runtime through the DOM; the app CSP forbids eval.
const runtime=null;
const clipState=id=>page.evaluate(([r,id])=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.find(c=>c.id===id),[runtime,id]);
const region=id=>page.evaluate(([r,id])=>document.querySelector('.preview-gpu-stage').previewRuntime.renderer.hitRegions.find(h=>h.clip.id===id)?.geometry,[runtime,id]);
const selected=()=>page.locator('.timeline-clip.selected').evaluateAll(nodes=>nodes.map(n=>n.dataset.clipId));
const settle=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const near=(actual,expected,tolerance,label)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} != ${expected}`);
let stage,unit;
const screen=([x,y])=>[stage.x+x/unit,stage.y+y/unit];
async function drag(from,to,options={}){await page.mouse.move(...screen(from));await page.mouse.down();if(options.ctrl)await page.keyboard.down('Control');await page.mouse.move(...screen(to),{steps:8});await settle();await page.mouse.up();if(options.ctrl)await page.keyboard.up('Control');await settle();}
const corners=g=>{const c=Math.cos(g.rotation),s=Math.sin(g.rotation),at=(lx,ly)=>{const x=(lx+g.offset[0])*g.scale[0],y=(ly+g.offset[1])*g.scale[1];return [g.center[0]+c*x-s*y,g.center[1]+s*x+c*y];};return {center:at(0,0),se:at(g.size[0]/2,g.size[1]/2),bottom:at(0,g.size[1]/2)};};
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1500,940));
  const file=path.join(root,project.id+'.sluproj');await fs.writeFile(file,JSON.stringify(project));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');try{await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor({timeout:15000});}catch(error){console.error('TOASTS',await page.locator('body').innerText().then(t=>t.slice(0,3000)));throw error;}await dismissToasts(page);
  await page.evaluate(r=>document.querySelector('.preview-gpu-stage').previewRuntime.seek(1.5),runtime);
  await page.waitForFunction(([r,ids])=>{const rt=document.querySelector('.preview-gpu-stage').previewRuntime;return rt.ready()&&ids.every(id=>rt.renderer.hitRegions.some(h=>h.clip.id===id));},[runtime,[video.id,title.id]],{timeout:30000});await settle();
  stage=await page.locator('.preview-gpu-stage').boundingBox();unit=project.width/stage.width;
  const wrap=await page.locator('.gpu-preview-wrap').boundingBox(),overlay=await page.locator('.gpu-preview-wrap>canvas.gpu-preview-selection').boundingBox();
  assert.ok(overlay&&Math.abs(overlay.width-wrap.width)<1&&Math.abs(overlay.height-wrap.height)<1,'selection overlay covers the whole monitor area');

  // Click selects the clip under the pointer, and the cursor advertises dragging.
  let text=corners(await region(title.id));await page.mouse.click(...screen(text.center));await settle();assert.deepEqual(await selected(),[title.id]);
  assert.equal(await page.locator('.gpu-preview-wrap').evaluate(e=>e.style.cursor),'move');
  checks.push('Clicking text in the program monitor selects it');

  // Moving near the frame centre snaps to it and shows guides; Ctrl suppresses snapping.
  const start=await clipState(title.id);await drag(text.center,[project.width/2+3*unit,project.height/2-4*unit]);
  let moved=await clipState(title.id);near(moved.x,0,1e-6,'snapped x');near(moved.y,0,1e-6,'snapped y');assert.equal(moved.scale,start.scale);
  // Wait for the re-rendered hit region too, not just the project state, before grabbing the text again.
  await page.keyboard.press('Control+z');await page.waitForFunction(([r,id,x])=>{const rt=document.querySelector('.preview-gpu-stage').previewRuntime;return rt.project.clips.find(c=>c.id===id).x===200&&Math.abs(rt.renderer.hitRegions.find(h=>h.clip.id===id)?.geometry.center[0]-x)<1e-6;},[runtime,title.id,project.width/2+200]);
  checks.push('Dragging text moves it, snaps its centre to the frame centre, and undoes in one step');
  // Pick a move whose edges and centre all stay clear of every snap line.
  const titleBox=await page.evaluate(([r,id])=>{const g=document.querySelector('.preview-gpu-stage').previewRuntime.renderer.hitRegions.find(h=>h.clip.id===id).geometry;return {minX:g.center[0]-g.size[0]*g.scale[0]/2,maxX:g.center[0]+g.size[0]*g.scale[0]/2,minY:g.center[1]-g.size[1]*g.scale[1]/2,maxY:g.center[1]+g.size[1]*g.scale[1]/2};},[runtime,title.id]);
  const clear=(min,max,d,size)=>[min,(min+max)/2,max].every(edge=>[0,size/2,size].every(t=>Math.abs(edge+d-t)>12*unit));
  const free=[[-137,43],[-91,57],[-163,29],[-55,71]].find(([dx,dy])=>clear(titleBox.minX,titleBox.maxX,dx,project.width)&&clear(titleBox.minY,titleBox.maxY,dy,project.height));assert.ok(free,'a snap-free move exists');
  text=corners(await region(title.id));await drag(text.center,[text.center[0]+free[0],text.center[1]+free[1]]);moved=await clipState(title.id);near(moved.x,200+free[0],unit*.6,'free x');near(moved.y,-200+free[1],unit*.6,'free y');
  await drag(corners(await region(title.id)).center,[project.width/2+3*unit,project.height/2+60],{ctrl:true});moved=await clipState(title.id);near(moved.x,3*unit,unit*.6,'ctrl keeps x off-centre');
  checks.push('Positions away from guides follow the pointer; holding Ctrl disables snapping');

  // Corner handle scales uniformly around the clip centre.
  await page.mouse.click(...screen([project.width/2-280,project.height/2+150]));await settle();assert.deepEqual(await selected(),[video.id]);
  let box=corners(await region(video.id));await page.mouse.move(...screen(box.se));assert.equal(await page.locator('.gpu-preview-wrap').evaluate(e=>e.style.cursor),'nwse-resize');
  await drag(box.se,[box.center[0]+(box.se[0]-box.center[0])*1.5,box.center[1]+(box.se[1]-box.center[1])*1.5]);
  let resized=await clipState(video.id);near(resized.scale,.75,.01,'scaled');near(resized.x,0,1e-6,'scale keeps x');near(resized.y,0,1e-6,'scale keeps y');
  checks.push('Dragging a corner handle resizes the video around its centre');
  await captureElectron(app,{path:path.join(root,'handles.png')});

  // Rotate handle sits just below the box (or inside it when clipped) and turns the clip.
  await page.waitForFunction(([r,id,scale])=>Math.abs(document.querySelector('.preview-gpu-stage').previewRuntime.renderer.hitRegions.find(h=>h.clip.id===id)?.geometry.scale[0]-scale)<1e-6,[runtime,video.id,resized.scale]);
  const g=await region(video.id);box=corners(g);const gap=24*unit,below=box.bottom[1]+gap,handle=below+12*unit<=project.height+((wrap.y+wrap.height)-(stage.y+stage.height))*unit?[box.center[0],below]:[box.center[0],box.bottom[1]-gap];
  await page.mouse.move(...screen(handle));assert.equal(await page.locator('.gpu-preview-wrap').evaluate(e=>e.style.cursor),'grab');
  const radius=handle[1]-box.center[1];await page.mouse.down();for(let i=1;i<=12;i++){const a=Math.PI/2+i/12*Math.PI/2;await page.mouse.move(...screen([box.center[0]+Math.cos(a)*radius,box.center[1]+Math.sin(a)*radius]));}await settle();await page.mouse.up();await settle();
  const rotated=await clipState(video.id);near(rotated.rotation,90,1e-6,'rotation snaps to 90°');
  checks.push('Dragging the rotate handle rotates the clip with right-angle snapping');
  await captureElectron(app,{path:path.join(root,'rotated.png')});

  // Empty space deselects, like CapCut.
  await page.mouse.click(wrap.x+8,wrap.y+wrap.height/2);await settle();assert.deepEqual(await selected(),[]);
  checks.push('Clicking empty monitor space clears the selection');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks},null,2));
}finally{await app.close();}
