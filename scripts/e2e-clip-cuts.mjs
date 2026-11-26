// Playback across cuts that jump in the source (a silence-trimmed recording): each next piece is
// prerolled while ahead, so the picture never flashes the background between pieces, a piece
// that starts is not sought again, and a late first frame keeps the previous picture up.
// The timeline scrolls like a horizontal editor: the wheel moves along time, Shift+wheel between tracks.
import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const root=path.resolve('.test-artifacts/clip-cuts-ui');await fs.mkdir(root,{recursive:true});
const work=await fs.mkdtemp(path.join(root,'run-')),video=path.join(work,'lecture.mp4');
execFileSync(path.resolve('resources/bin/ffmpeg.exe'),['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=640x360:r=30:d=12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=12','-c:v','libx264','-preset','ultrafast','-g','30','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
const env={...process.env,SLU_USER_DATA:path.join(work,'profile'),SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000}),page=await app.firstWindow();
const errors=[],checks=[];page.on('pageerror',error=>errors.push(String(error)));page.on('dialog',d=>d.accept());
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);};
const program=()=>page.getByRole('button',{name:'프로그램',exact:true}).first().click();
try{
  await page.locator('.track-lane.lane-video').first().waitFor();
  // Import by dropping the file on the video track.
  await page.evaluate(()=>{const input=document.createElement('input');input.type='file';input.id='e2e-drop-files';input.style.display='none';document.body.append(input);});
  await page.setInputFiles('#e2e-drop-files',[video]);
  await page.evaluate(()=>{const input=document.getElementById('e2e-drop-files'),transfer=new DataTransfer();for(const file of input.files)transfer.items.add(file);const lane=document.querySelector('.track-lane.lane-video'),rect=lane.getBoundingClientRect(),init={bubbles:true,cancelable:true,dataTransfer:transfer,clientX:rect.left+2,clientY:rect.top+rect.height/2};for(const type of ['dragenter','dragover','drop'])lane.dispatchEvent(new DragEvent(type,init));});
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===1,null,{timeout:60000});
  await dismissToasts(page);
  const saved=path.join(work,'source.sluproj');
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},saved);
  await program();await page.keyboard.press('Control+Shift+s');await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();

  // Four 1.5 s pieces taken 3 s apart in the source and placed back to back, as silence trimming leaves them.
  const project=JSON.parse(await fs.readFile(saved,'utf8')),[clip]=project.clips;
  project.id='clip-cuts';project.clips=[.5,3.5,6.5,9.5].map((from,index)=>({...clip,id:`piece-${index}`,start:index*1.5,in:from,duration:1.5,sourceClipOffset:from,sourceClipDuration:clip.duration}));
  // Empty tracks above make the timeline taller than its panel.
  project.tracks=[...project.tracks,...Array.from({length:9},(_,i)=>({...project.tracks[0],id:`video-extra-${i}`,name:`트랙 ${i+2}`}))];
  const cuts=path.join(work,'cuts.sluproj');await fs.writeFile(cuts,JSON.stringify(project));
  await dismissToasts(page);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},cuts);
  await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===4);
  await program();await page.keyboard.press('Home');
  await page.waitForFunction(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime;return r.stats()&&!r.stats().seeking;},null,{timeout:30000});

  // Play through all four pieces, watching every drawn frame and every seek of an on-screen piece.
  await page.getByTitle('재생 (Space)',{exact:true}).click();
  const observed=await page.evaluate(async()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime,seen={frames:0,blank:[],pieces:{},activeSeeks:[]};
    const seeking=event=>{const node=[...r.nodes.values()].find(n=>n.element===event.target);if(node?.active&&!node.audioOnly&&r.running&&!r.waitingToStart)seen.activeSeeks.push({clip:node.clip.id,at:+r.time().toFixed(3),to:+event.target.currentTime.toFixed(3)});};
    document.addEventListener('seeking',seeking,true);
    // Piece 3's first frame arrives 120 ms late, as from a slow disk: the previous picture must stay up meanwhile.
    const frameFor=r.frameFor;r.frameFor=function(node){return node.clip.id==='piece-2'&&performance.now()-node.activatedAt<120?undefined:frameFor.call(this,node);};let draws=r.draws;const until=performance.now()+9000,head=document.querySelector('.playhead');seen.playhead={moves:0,backwards:0,last:-Infinity,text:''};
    while(performance.now()<until&&(r.running||r.time()<.1)){const t=r.time();if(r.draws!==draws&&!r.waitingToStart&&t>.05){seen.frames++;const ids=r.renderer.hitRegions.map(h=>h.clip.id);if(!ids.length)seen.blank.push(+t.toFixed(3));for(const id of ids)seen.pieces[id]=(seen.pieces[id]||0)+1;}draws=r.draws;const shift=head?.style.transform||'';if(shift!==seen.playhead.text){const x=parseFloat(shift.replace('translateX(',''));if(x<seen.playhead.last-.01)seen.playhead.backwards++;seen.playhead.last=x;seen.playhead.text=shift;seen.playhead.moves++;}await new Promise(f=>requestAnimationFrame(f));}
    document.removeEventListener('seeking',seeking,true);r.frameFor=frameFor;return {...seen,held:r.held,end:r.time(),stats:r.stats()};});
  if(await page.getByTitle('일시 정지 (Space)',{exact:true}).count())await page.getByTitle('일시 정지 (Space)',{exact:true}).click();
  check('playback reaches the end of the last piece',observed.end>5.9,observed);
  check('every piece is drawn',[0,1,2,3].every(i=>observed.pieces[`piece-${i}`]>10),observed.pieces);
  check('the timeline playhead moves on every frame, never backwards',observed.playhead.moves>observed.end*25&&observed.playhead.backwards===0,observed.playhead);
  check('no frame shows the background between pieces',observed.frames>100&&observed.blank.length===0,observed);
  check('a piece whose first frame is late keeps the previous picture up',observed.held>0,observed.held);
  check('a prerolled piece starts without being sought again',observed.activeSeeks.length===0,observed.activeSeeks);
  const timeline=page.locator('.timeline-scroll'),area=await timeline.boundingBox();
  const scrolled=()=>timeline.evaluate(el=>({left:el.scrollLeft,top:el.scrollTop,wide:el.scrollWidth>el.clientWidth,tall:el.scrollHeight>el.clientHeight}));
  await page.mouse.move(area.x+area.width*.6,area.y+area.height*.6);
  await page.keyboard.down('Control');await page.mouse.wheel(0,-600);await page.mouse.wheel(0,-600);await page.keyboard.up('Control');
  await timeline.evaluate(el=>{el.scrollLeft=0;el.scrollTop=0;});const start=await scrolled();
  await page.mouse.wheel(0,300);await page.waitForTimeout(200);const sideways=await scrolled();
  check('the wheel scrolls the timeline sideways',start.wide&&sideways.left>0&&sideways.top===0,{start,sideways});
  await page.keyboard.down('Shift');await page.mouse.wheel(0,300);await page.keyboard.up('Shift');await page.waitForTimeout(200);const down=await scrolled();
  check('Shift+wheel scrolls between tracks',start.tall&&down.top>0&&down.left===sideways.left,{sideways,down});
  check('no page errors',!errors.length,errors);
}finally{
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({checks,errors},null,2));
  await app.close();
}
console.log(`clip cuts UI: ${checks.filter(c=>c.ok).length}/${checks.length} checks passed`);
