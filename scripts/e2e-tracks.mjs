// CapCut-style tracks: one track to start, overlapping drops make tracks, dragging above every
// track makes a top track, emptied tracks vanish, upper tracks cover lower ones in the preview,
// and trimming stops at the neighbouring clip.
import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const root=path.resolve('.test-artifacts/tracks-ui');await fs.mkdir(root,{recursive:true});
const colors={red:'0xd03030',green:'0x30b050',blue:'0x3060d0'},files={};
for(const [name,value] of Object.entries(colors)){files[name]=path.join(root,`${name}.mp4`);execFileSync(path.resolve('resources/bin/ffmpeg.exe'),['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i',`color=c=${value}:s=320x180:r=30:d=4`,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',files[name]]);}
const env={...process.env,SLU_USER_DATA:path.join(root,`profile-${Date.now()}`),SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000}),page=await app.firstWindow();
const errors=[],checks=[];page.on('pageerror',error=>errors.push(String(error)));page.on('dialog',d=>d.accept());
const project=()=>page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project);
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);};
const clipOf=async name=>(await project()).clips.find(c=>c.name===`${name}.mp4`);
// Bottom-to-top layer order of the picture clips, by name.
const layers=async()=>{const p=await project();return p.tracks.filter(t=>t.type==='video').map(t=>p.clips.filter(c=>c.trackId===t.id).map(c=>c.name.replace('.mp4','')).join('+'));};
async function drop(name,laneIndex=0){
  await page.evaluate(()=>{if(!document.getElementById('e2e-file')){const input=document.createElement('input');input.type='file';input.id='e2e-file';input.style.display='none';document.body.append(input);}});
  await page.setInputFiles('#e2e-file',[files[name]]);
  const count=(await project()).clips.length;
  await page.evaluate(index=>{const t=new DataTransfer();for(const f of document.getElementById('e2e-file').files)t.items.add(f);const lane=document.querySelectorAll('.track-lane.lane-video')[index],r=lane.getBoundingClientRect(),init={bubbles:true,cancelable:true,dataTransfer:t,clientX:r.left+2,clientY:r.top+r.height/2};lane.dispatchEvent(new DragEvent('dragover',init));lane.dispatchEvent(new DragEvent('drop',init));},laneIndex);
  await page.waitForFunction(count=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===count+1,count,{timeout:60000});
  await dismissToasts(page);
}
async function centreColour(){
  await page.getByRole('button',{name:'프로그램',exact:true}).first().click();await page.keyboard.press('Home');await page.keyboard.press('Shift+ArrowRight');
  await page.waitForFunction(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime;return Math.abs(r.time()-1)<1e-6&&r.nodes.size>0&&[...r.nodes.values()].every(n=>n.loaded&&!n.element.seeking&&n.element.readyState>=2);},null,{timeout:30000});
  await page.waitForTimeout(300);
  return page.evaluate(async()=>{const url=document.querySelector('.preview-gpu-stage').previewRuntime.snapshot(),image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const g=canvas.getContext('2d');g.drawImage(image,0,0);const [r,gr,b]=g.getImageData(image.width>>1,image.height>>1,1,1).data;return r>gr&&r>b?'red':gr>r&&gr>b?'green':'blue';});
}
async function dragClip(name,to){
  const box=await page.locator(`[data-clip-id="${(await clipOf(name)).id}"]`).boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  for(let i=1;i<=8;i++)await page.mouse.move(box.x+box.width/2+(to.x-box.x-box.width/2)*i/8,box.y+box.height/2+(to.y-box.y-box.height/2)*i/8);
  const hint=await page.locator('.new-track-hint').count();await page.mouse.up();await page.waitForTimeout(200);return hint;
}
try{
  await page.waitForLoadState('domcontentloaded');await page.locator('.track-lane').first().waitFor();
  check('a new project has one track',await page.locator('.track-lane').count()===1,await page.locator('.track-lane').count());
  // Three files dropped on the same spot of the one track stack up as three tracks, newest on top.
  await drop('red');await drop('green');await drop('blue');
  check('overlapping drops make new tracks above',JSON.stringify(await layers())==='["red","green","blue"]',await layers());
  check('the top track is drawn on top',await centreColour()==='blue',null);
  // Drag the bottom clip above every track: it gets a new top track and its old track goes away.
  const first=await page.locator('.track-lane').first().boundingBox();
  const hinted=await dragClip('red',{x:(await page.locator(`[data-clip-id="${(await clipOf('red')).id}"]`).boundingBox()).x+40,y:first.y-12});
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.tracks.length===3);
  check('dragging above every track makes a new top track',hinted===1&&JSON.stringify(await layers())==='["green","blue","red"]',{hinted,layers:await layers()});
  check('the moved clip now covers the others',await centreColour()==='red',null);
  // Drop the green clip onto the blue track where it overlaps: it lands on a new track right above blue.
  const blueLane=await page.locator(`[data-clip-id="${(await clipOf('blue')).id}"]`).boundingBox();
  await dragClip('green',{x:blueLane.x+blueLane.width/2,y:blueLane.y+blueLane.height/2});
  await page.waitForFunction(()=>{const p=document.querySelector('.preview-gpu-stage').previewRuntime.project;return p.tracks.filter(t=>t.type==='video').length===3&&p.tracks[0].id===p.clips.find(c=>c.name==='blue.mp4').trackId;});
  check('a clip dropped onto an occupied spot moves up a track',JSON.stringify(await layers())==='["blue","green","red"]',await layers());
  // Deleting the only clip of a track removes the track.
  await page.locator(`[data-clip-id="${(await clipOf('red')).id}"]`).click();await page.keyboard.press('Delete');
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.tracks.length===2);
  check('an emptied track is removed',JSON.stringify(await layers())==='["blue","green"]',await layers());
  // Text goes on its own track on top.
  await page.getByRole('button',{name:'텍스트',exact:true}).first().click();await page.getByRole('button',{name:'텍스트 추가'}).click();
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.some(c=>c.text!==undefined));
  const p=await project();check('text gets a track above the pictures',p.tracks.at(-1).type==='text'&&p.tracks.length===3,p.tracks.map(t=>t.type));
  // Trimming the end of a piece stops at the next piece.
  await page.getByRole('button',{name:'미디어',exact:true}).first().click();
  await page.locator(`[data-clip-id="${(await clipOf('blue')).id}"]`).click();await page.getByRole('button',{name:'프로그램',exact:true}).first().click();await page.keyboard.press('Home');await page.keyboard.press('Shift+ArrowRight');await page.keyboard.press('Control+b');
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.filter(c=>c.name==='blue.mp4').length===2);
  const left=(await project()).clips.find(c=>c.name==='blue.mp4'&&c.start===0),handle=page.locator(`[data-clip-id="${left.id}"]`).getByTitle('끝점 트리밍',{exact:true});
  await page.locator(`[data-clip-id="${left.id}"]`).click();const edge=await handle.boundingBox();
  await page.mouse.move(edge.x+edge.width/2,edge.y+edge.height/2);await page.mouse.down();await page.mouse.move(edge.x+60,edge.y+edge.height/2,{steps:6});await page.mouse.up();await page.waitForTimeout(200);
  const trimmed=(await project()).clips.find(c=>c.id===left.id);
  check('trimming stops at the next clip',Math.abs(trimmed.duration-1)<1e-6,trimmed.duration);
  check('no page errors',!errors.length,errors);
}finally{
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({checks,errors},null,2));
  await app.close();
}
console.log(`tracks UI: ${checks.filter(c=>c.ok).length}/${checks.length} checks passed`);
