// Speed in percent (single clip, 5000% scrub preview, whole selection), files dropped from
// Explorer straight onto a track, and rendering a selection into one clip and back.
import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const root=path.resolve('.test-artifacts/speed-combine-ui');await fs.mkdir(root,{recursive:true});
const ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),video=path.join(root,'clip.mp4'),tone=path.join(root,'tone.wav');
const ff=args=>execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args]);
ff(['-f','lavfi','-i','testsrc2=s=640x360:r=30:d=6','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=6','-c:v','libx264','-preset','ultrafast','-g','15','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
ff(['-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=3','-c:a','pcm_s16le',tone]);
const long=path.join(root,'long.mp4');ff(['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=40','-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=40','-c:v','libx264','-preset','ultrafast','-g','10','-pix_fmt','yuv420p','-c:a','aac','-shortest',long]);
const profile=path.join(root,`profile-${Date.now()}`),env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000}),page=await app.firstWindow();
const errors=[],issues=[],checks=[];page.on('pageerror',error=>errors.push(String(error)));page.on('dialog',d=>d.accept());
page.on('console',message=>{if(/NotSupportedError|playback rate/i.test(message.text()))issues.push(message.text());});
const project=()=>page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project);
const check=(name,ok,detail)=>{checks.push({name,ok:!!ok,detail});assert.ok(ok,`${name}: ${JSON.stringify(detail)}`);};
const near=(a,b,tolerance=1e-6)=>Math.abs(a-b)<=tolerance;
const clip=id=>page.locator(`[data-clip-id="${id}"]`);
async function drop(files,laneSelector,x){
  await page.evaluate(()=>{if(!document.getElementById('e2e-drop-files')){const input=document.createElement('input');input.type='file';input.multiple=true;input.id='e2e-drop-files';input.style.display='none';document.body.append(input);}});
  await page.setInputFiles('#e2e-drop-files',files);
  await page.evaluate(({laneSelector,x})=>{
    const input=document.getElementById('e2e-drop-files'),transfer=new DataTransfer();for(const file of input.files)transfer.items.add(file);
    const lane=document.querySelector(laneSelector),rect=lane.getBoundingClientRect(),init={bubbles:true,cancelable:true,dataTransfer:transfer,clientX:x??rect.left+2,clientY:rect.top+rect.height/2};
    lane.dispatchEvent(new DragEvent('dragenter',init));lane.dispatchEvent(new DragEvent('dragover',init));lane.dispatchEvent(new DragEvent('drop',init));
  },{laneSelector,x});
}
try{
  await page.waitForLoadState('domcontentloaded');await page.locator('.track-lane.lane-video').first().waitFor();

  // Files dropped on the video track: the video lands there, the WAV on the audio track, both at 0.
  await drop([video,tone],'.track-lane.lane-video');
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===2,null,{timeout:60000});
  let p=await project();const videoClip=p.clips.find(c=>p.media.find(m=>m.id===c.mediaId)?.kind==='video'),toneClip=p.clips.find(c=>c.id!==videoClip.id);
  check('drop places the video on the dropped track',videoClip.trackId==='video-1'&&videoClip.start===0&&p.media.length===2,videoClip);
  check('drop places audio on an audio track at the same point',p.tracks.find(t=>t.id===toneClip.trackId)?.type==='audio'&&toneClip.start===0,toneClip);
  check('drop overlay is gone',!(await page.locator('.drop-overlay').count()),null);
  // A second drop at the video clip's end snaps there.
  const end=await clip(videoClip.id).boundingBox();
  await drop([tone],'.track-lane.lane-audio',end.x+end.width);
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===3,null,{timeout:60000});
  p=await project();const tone2=p.clips.find(c=>c.id!==videoClip.id&&c.id!==toneClip.id);
  check('drop at a position places the clip there',tone2.trackId===toneClip.trackId&&near(tone2.start,6,1/30),tone2);
  check('reimporting a file reuses its media',p.media.length===2,p.media.map(m=>m.name));
  await dismissToasts(page);

  // Single clip: 5000% in the basic tab, then the speed tab's presets.
  await clip(videoClip.id).click();
  const speed=page.getByLabel('속도',{exact:true});await speed.fill('5000');await speed.press('Enter');
  await page.waitForFunction(id=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.find(c=>c.id===id).speed===50,videoClip.id);
  p=await project();let v=p.clips.find(c=>c.id===videoClip.id);
  check('5000% sets 50x speed and a 0.12 s clip',near(v.duration,.12,1e-6),v);
  check('timeline badge shows percent',(await clip(videoClip.id).innerText()).includes('5000%'),await clip(videoClip.id).innerText());
  // Preview plays it by stepping frames without errors (Chromium caps playbackRate at 16).
  await page.getByRole('button',{name:'프로그램',exact:true}).first().click();await page.keyboard.press('Home');
  await page.getByTitle('재생 (Space)',{exact:true}).click();
  const scrubbed=await page.waitForFunction(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime;return [...r.nodes.values()].some(n=>n.scrub)||r.time()>.12;},null,{timeout:15000}).then(()=>true,()=>false);
  await page.waitForTimeout(400);
  if(await page.getByTitle('일시 정지 (Space)',{exact:true}).count())await page.getByTitle('일시 정지 (Space)',{exact:true}).click();
  check('5000% preview runs without playback-rate errors',scrubbed&&!issues.length&&!errors.length,{issues,errors});
  await page.getByRole('button',{name:'속도',exact:true}).click();
  check('curve editor is under a collapsed advanced section',await page.getByRole('button',{name:'고급 · 속도 커브'}).getAttribute('aria-expanded')==='false',null);
  await page.getByRole('group',{name:'속도 빠른 선택'}).getByRole('button',{name:'100%',exact:true}).click();
  await page.waitForFunction(id=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.find(c=>c.id===id).speed===1,videoClip.id);
  p=await project();v=p.clips.find(c=>c.id===videoClip.id);check('100% preset restores 6 s',near(v.duration,6,1e-6),v);
  await page.getByRole('button',{name:'기본',exact:true}).click();
  // A 40 s clip at 2500% (1.6 s) plays by stepping frames through seeks, silently.
  const videoEnd=await clip(videoClip.id).boundingBox();
  await drop([long],'.track-lane.lane-video',videoEnd.x+videoEnd.width);
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===4,null,{timeout:60000});
  p=await project();const longClip=p.clips.find(c=>c.name==='long.mp4');
  await clip(longClip.id).click();await speed.fill('2500');await speed.press('Enter');
  await page.waitForFunction(id=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.find(c=>c.id===id).speed===25,longClip.id);
  await clip(longClip.id).dblclick();
  await page.waitForFunction(at=>Math.abs(document.querySelector('.preview-gpu-stage').previewRuntime.time()-at)<1e-6,longClip.start);
  await page.getByTitle('재생 (Space)',{exact:true}).click();
  const observed=await page.evaluate(async id=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime,times=new Set(),seen={scrub:false,maxGain:0,element:'',frames:0,missing:0};let draws=r.draws;const until=performance.now()+1200;
    while(performance.now()<until){const n=[...r.nodes.values()].find(n=>n.clip.id===id&&!n.audioOnly);const t=r.time(),drawn=r.draws!==draws;draws=r.draws;if(drawn&&t>n?.clip.start+.05&&t<n.clip.start+n.clip.duration-.05){seen.frames++;if(!r.renderer.hitRegions.some(h=>h.clip.id===id))seen.missing++;}if(n){seen.scrub||=!!n.scrub;if(n.scrub){seen.maxGain=Math.max(seen.maxGain,n.lastGain);seen.element=`${n.element.paused}:${n.element.playbackRate}`;times.add(n.element.currentTime.toFixed(2));}}await new Promise(f=>requestAnimationFrame(f));}
    return {...seen,distinct:times.size,time:r.time()};},longClip.id);
  if(await page.getByTitle('일시 정지 (Space)',{exact:true}).count())await page.getByTitle('일시 정지 (Space)',{exact:true}).click();
  check('2500% preview steps frames by seeking',observed.scrub&&observed.distinct>=4&&observed.element.startsWith('true:16'),observed);
  check('2500% preview never drops the clip while seeking (no flicker)',observed.frames>20&&observed.missing===0,observed);
  check('2500% preview is silent and error free',observed.maxGain===0&&!issues.length&&!errors.length,{observed,issues,errors});
  await clip(longClip.id).click();await page.keyboard.press('Delete');
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===3);

  // The whole selection at 200%: everything halves and keeps its relative place.
  await clip(videoClip.id).click();await page.keyboard.press('Control+a');
  const group=page.getByLabel('선택 항목 속도',{exact:true});await group.waitFor();
  check('a uniform selection shows its speed',await group.inputValue()==='100',await group.inputValue());
  await group.fill('200');await group.press('Enter');
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.every(c=>c.speed===2));
  p=await project();const by=id=>p.clips.find(c=>c.id===id);
  check('selection at 200% halves every clip',near(by(videoClip.id).duration,3)&&near(by(toneClip.id).duration,1.5)&&near(by(tone2.id).duration,1.5),p.clips);
  check('selection at 200% keeps relative places',near(by(tone2.id).start,3,1/60),by(tone2.id));
  // A caption after the picture ends (3–6 s): the combined frame there is transparent but for the text.
  await clip(tone2.id).dblclick();
  await page.waitForFunction(()=>Math.abs(document.querySelector('.preview-gpu-stage').previewRuntime.time()-3)<1e-6);
  await page.getByRole('button',{name:'텍스트',exact:true}).first().click();await page.getByRole('button',{name:'텍스트 추가'}).click();
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===4);
  p=await project();const caption=p.clips.find(c=>c.text!==undefined);
  check('caption added after the picture',caption.start===3&&!!caption.captionStyle,{start:caption.start,style:!!caption.captionStyle});
  await page.getByRole('button',{name:'미디어',exact:true}).first().click();
  await clip(videoClip.id).click();await page.keyboard.press('Control+a');await page.getByLabel('선택 항목 속도',{exact:true}).waitFor();
  const before=structuredClone(p.clips);

  // Combine all three into one rendered clip, then put them back.
  await dismissToasts(page);await page.keyboard.press('Control+g');
  await page.waitForFunction(()=>{const p=document.querySelector('.preview-gpu-stage').previewRuntime.project;return p.clips.length===1&&!!p.clips[0].compound;},null,{timeout:240000});
  p=await project();const combined=p.clips[0],asset=p.media.find(m=>m.id===combined.mediaId);
  check('combined clip covers the selection',combined.start===0&&near(combined.duration,6,1/30)&&combined.compound.clips.length===4,{start:combined.start,duration:combined.duration});
  // Read frames of the rendered file: opaque over the picture, transparent around the caption.
  const alpha=at=>{const raw=execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-ss',String(at),'-i',asset.path,'-frames:v','1','-vf','scale=480:270:flags=neighbor','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{maxBuffer:64*1024*1024});let opaque=0;for(let i=3;i<raw.length;i+=4)if(raw[i]>0)opaque++;return {corner:raw[3],opaque,total:raw.length/4};};
  const picture=alpha(1),text=alpha(4);
  check('combined frames keep the picture opaque',picture.corner===255&&picture.opaque===picture.total,picture);
  check('combined frames are transparent around the caption',text.corner===0&&text.opaque>50&&text.opaque<text.total*.2,text);
  check('combined media is a transparent FFV1 intermediate with a preview proxy',asset.codec==='ffv1'&&asset.hasAlpha===true&&!!asset.proxyPath&&asset.hasAudio,asset);
  await page.waitForFunction(id=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime;const n=[...r.nodes.values()].find(n=>n.clip.id===id);return n&&n.loaded&&!n.failed;},combined.id,{timeout:60000});
  check('combined clip shows its badge',(await clip(combined.id).innerText()).includes('합침'),await clip(combined.id).innerText());
  await clip(combined.id).click();
  await page.getByRole('button',{name:'합치기 풀기',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===4);
  p=await project();
  const same=before.every(o=>JSON.stringify(p.clips.find(c=>c.id===o.id))===JSON.stringify(o));
  check('uncombining restores the original clips exactly',same,p.clips);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===1);
  check('undo brings the combined clip back',true,null);
  check('no page errors',!errors.length,errors);
}finally{
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({checks,errors,issues},null,2));
  await app.close();
}
console.log(`speed/combine UI: ${checks.filter(c=>c.ok).length}/${checks.length} checks passed`);
