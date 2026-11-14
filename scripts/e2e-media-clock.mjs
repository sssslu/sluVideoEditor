import {installAudioProbe} from './audio-test-probe.mjs';
import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const root=path.resolve('.test-artifacts/media-clock-ui');await fs.mkdir(root,{recursive:true});
const fixtures=JSON.parse(await fs.readFile('.test-artifacts/media-clock/fixtures.json','utf8')),version=JSON.parse(await fs.readFile('package.json','utf8')).version;assert.equal(fixtures.version,version);
const profile=path.join(root,`profile-${Date.now()}`),env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(process.env.SLU_TEST_EXE?{executablePath:path.resolve(process.env.SLU_TEST_EXE),args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000}),page=await app.firstWindow();
const checks=[],errors=[],frames=[],playback=[],exports=[],run=promisify(execFile),digest=data=>createHash('sha256').update(data).digest('hex');
page.on('pageerror',e=>errors.push(String(e)));page.on('dialog',d=>d.accept());
const template=JSON.parse(await fs.readFile('examples/AURORA.sluproj','utf8'));
const base={...template.clips.find(c=>c.mediaId),id:'clock-clip',trackId:'video-1',start:0,in:.2,duration:3.5,speed:1,volume:1,fadeIn:0,fadeOut:0,opacity:1,scale:1,x:0,y:0,rotation:0,brightness:0,contrast:1,saturation:1,blur:0,preset:'none',keyframes:[],speedCurve:undefined,crop:undefined,mask:undefined,colorGrade:undefined,animation:'none',audioEQ:undefined,sourceClipOffset:undefined,sourceClipDuration:undefined};
async function open(media,label,legacy=false,options={}){
  await dismissToasts(page);const project={...template,version:6,id:`clock-${label}`,name:label,width:160,height:90,fps:options.fps||10,media:[legacy?{...media,timing:undefined}:media],clips:[{...base,mediaId:media.id,trackId:media.kind==='audio'?'audio-1':'video-1',...options.clip}],transitions:undefined};const file=path.join(root,`${label}.sluproj`);await fs.writeFile(file,JSON.stringify(project));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage')?.previewRuntime?.project?.clips[0]?.id==='clock-clip');return project;
}
async function seek(time){const fps=await page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.fps);await page.keyboard.press('Home');for(let i=0;i<Math.floor(time);i++)await page.keyboard.press('Shift+ArrowRight');for(let i=0;i<Math.round((time-Math.floor(time))*fps);i++)await page.keyboard.press('ArrowRight');await page.waitForFunction(time=>{const r=document.querySelector('.preview-gpu-stage')?.previewRuntime,n=r?.nodes.get('clock-clip');return r&&Math.abs(r.time()-time)<1e-6&&n?.loaded&&!n.element.seeking&&n.element.readyState>=2;},time);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function reference(media){
 const bin=path.resolve('resources/bin'),info=JSON.parse((await run(path.join(bin,'ffprobe.exe'),['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',media.path],{windowsHide:true})).stdout);
 const raw=(await run(path.join(bin,'ffmpeg.exe'),['-v','error','-i',media.path,'-map','0:v:0','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:16*1024*1024})).stdout;
 const times=info.frames.map(f=>Number(f.best_effort_timestamp_time)-media.timing.origin);assert.equal(raw.length,times.length*160*90*3);
 for(let frame=0;frame<times.length;frame++){let code=0;for(let bit=0;bit<8;bit++){const p=(frame*160*90+5*160+bit*20+10)*3;if((raw[p]+raw[p+1]+raw[p+2])/3>128)code|=1<<bit;}assert.equal(code,frame,'Reference frame-number barcode');}
 return {times,raw};
}
async function compareFrame(media,ref,time,label,clip=base){
 await seek(time);const sample=await page.evaluate(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime,n=r.nodes.get('clock-clip'),v=n.element,c=document.createElement('canvas');c.width=160;c.height=90;const ctx=c.getContext('2d');ctx.drawImage(v,0,0,160,90);return {time:r.time(),source:v.currentTime,offset:n.media.timing?.previewOffset||0,proxy:!!n.media.proxyPath,url:n.url,rgba:Array.from(ctx.getImageData(0,0,160,90).data)};});
 let best=-1,error=Infinity;const size=160*90*3;for(let frame=0;frame<ref.times.length;frame++){let difference=0;for(let pixel=0;pixel<160*90;pixel++)for(let channel=0;channel<3;channel++)difference+=Math.abs(sample.rgba[pixel*4+channel]-ref.raw[frame*size+pixel*3+channel]);if(difference<error){error=difference;best=frame;}}
 let code=0;for(let bit=0;bit<8;bit++){const p=(5*160+bit*20+10)*4;if((sample.rgba[p]+sample.rgba[p+1]+sample.rgba[p+2])/3>128)code|=1<<bit;}
 const expected=ref.times.findLastIndex(t=>Math.round((t+media.timing.origin)*1e6)<=Math.round((clip.in+(time-clip.start)*clip.speed+media.timing.origin)*1e6));frames.push({label,time,source:sample.source,expectedFrame:expected,actualFrame:code,nearestFrame:best,meanDifference:error/size});assert.equal(code,expected,`${label} timeline${time} source${sample.source}: frame code${code}, expected${expected}`);assert.equal(best,expected,`${label}: nearest reference frame`);return sample;
}
async function exportFrames(project,media,ref,label,encoder){
 const auditFrom=await app.evaluate(()=>globalThis.clockSpawnAudit.length);
 const output=path.join(root,`${label}-${encoder}.mp4`);await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},output);
 const job=await page.evaluate(({project,encoder})=>window.studio.exportProject(project,{width:160,height:90,fps:project.fps,format:'mp4',codec:'h264',encoder,quality:'high'}),{project,encoder});assert.ok(job);
 await page.waitForFunction(id=>window.clockJobs.some(e=>e.id===id&&['complete','error','cancelled'].includes(e.status)),job.jobId,{timeout:120000});const event=await page.evaluate(id=>window.clockJobs.find(e=>e.id===id&&['complete','error','cancelled'].includes(e.status)),job.jobId);assert.equal(event.status,'complete',event.message);
 const raw=(await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-i',output,'-map','0:v:0','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:16*1024*1024})).stdout,clip=project.clips[0],count=raw.length/(160*90*3),mismatches=[];assert.equal(count,Math.ceil((clip.start+clip.duration)*project.fps-1e-7));
 for(let frame=0;frame<count;frame++){const time=frame/project.fps;if(time<clip.start||time>=clip.start+clip.duration)continue;const target=Math.round((clip.in+(time-clip.start)*clip.speed+media.timing.origin)*1e6),expected=ref.times.findLastIndex(t=>Math.round((t+media.timing.origin)*1e6)<=target);let code=0;for(let bit=0;bit<8;bit++){const p=(frame*160*90+5*160+bit*20+10)*3;if((raw[p]+raw[p+1]+raw[p+2])/3>128)code|=1<<bit;}if(code!==expected)mismatches.push({frame,actual:code,expected});}
 const encoders=await app.evaluate((_,from)=>globalThis.clockSpawnAudit.slice(from).filter(row=>row.args.includes('-c:v')&&row.args.some(arg=>String(arg).endsWith('.partial.mp4'))).map(row=>({codec:row.args[row.args.indexOf('-c:v')+1],cuda:row.args.includes('-hwaccel'),code:row.code})),auditFrom);
 assert.ok(encoders.some(row=>row.codec===(encoder==='nvenc'?'h264_nvenc':'libx264')&&row.code===0),JSON.stringify(encoders));
 if(label.startsWith('native-30-tagged')&&encoder==='nvenc')assert.ok(encoders.some(row=>row.cuda),'The fully tagged single clip must exercise the direct CUDA path');
 exports.push({label,encoder,frames:count,mismatches,output,encoders});assert.deepEqual(mismatches,[],`${label} ${encoder} actual IPC export frame identity`);
}
try{
 await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();await page.evaluate(()=>{window.clockJobs=[];window.studio.onJob(e=>window.clockJobs.push(e));});
 await app.evaluate(()=>{const {createRequire,syncBuiltinESMExports}=process.getBuiltinModule('module'),cp=createRequire(process.execPath)('node:child_process');globalThis.clockOriginalSpawn=cp.spawn;globalThis.clockSpawnAudit=[];cp.spawn=function(file,args,options){const row={file,args:[...(args||[])]},child=Reflect.apply(globalThis.clockOriginalSpawn,this,arguments);globalThis.clockSpawnAudit.push(row);child.once('close',code=>row.code=code);return child;};syncBuiltinESMExports();});
 const system=await page.evaluate(()=>window.studio.getSystemInfo());assert.equal(system.version,version);
 const imported={};for(const [name,file] of Object.entries(fixtures.files)){const [asset]=await page.evaluate(files=>window.studio.importMedia(files),[file]);imported[name]=asset;assert.ok(asset.timing);}
 assert.equal(imported.shifted.timing.previewOffset,2);assert.equal(imported.shifted.duration,4);assert.equal(imported.mp3.timing.previewOffset,0);assert.ok(imported.mp3.timing.origin>0);checks.push('Actual import distinguishes shifted MKV/MP4 clock origins from MP3 codec priming and corrects MKV duration');
 for(const name of ['base','shifted','mp4','mp4-shifted']){
  const media=imported[name],ref=await reference(media);await open(media,name,name==='shifted');
  for(const time of [.3,.9,1.5,2.5]){const sample=await compareFrame(media,ref,time,name);assert.ok(Math.abs(sample.source-(base.in+time+media.timing.previewOffset))<.003);}
  checks.push(`${name}: four paused timeline seeks decode the correct original frame at the normalized source time`);
  if(name==='shifted'){
   const hydrated=await page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.media[0]);assert.deepEqual(hydrated.timing,media.timing);assert.equal(hydrated.id,media.id);checks.push('Opening a legacy project hydrates timing metadata while preserving source identity and clip trims');
   await seek(0);await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.time()>.65);const moving=await page.evaluate(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime,n=r.nodes.get('clock-clip');return {timeline:r.time(),source:n.element.currentTime,lag:r.lastStatsValue.maxSourceLagSeconds};});assert.ok(moving.timeline<1.4);assert.ok(Math.abs(moving.source-moving.timeline-base.in-2)<.04);assert.ok(moving.lag<.2);playback.push(moving);await page.keyboard.press('Space');checks.push('Playback uses the corrected audible source clock without skipping ahead by the two-second absolute origin');
   await page.locator('.media-card').first().click();await page.getByRole('button',{name:/소스 ·/}).waitFor();await page.waitForFunction(()=>document.querySelector('.source-monitor video')?.readyState>=2);
   const scrubber=page.getByLabel('소스 재생 위치',{exact:true});await scrubber.focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>Math.abs(document.querySelector('.source-monitor video').currentTime-2.3)<.003);
   await page.locator('.source-view').click();await page.keyboard.press('i');assert.equal(Number(await page.getByLabel('소스 시작점',{exact:true}).inputValue()),.3);checks.push('Source monitor seeks in normalized time and I/O marks exclude the original absolute timestamp');
   await page.getByRole('button',{name:'프로그램',exact:true}).first().click();await seek(0);
   const job=await page.evaluate(m=>window.studio.generateProxy(m),media);await page.waitForFunction(id=>window.clockJobs.some(e=>e.id===id&&['complete','error','cancelled'].includes(e.status)),job.jobId,{timeout:120000});const event=await page.evaluate(id=>window.clockJobs.find(e=>e.id===id&&['complete','error','cancelled'].includes(e.status)),job.jobId);assert.equal(event.status,'complete',event.message);assert.ok(event.media.proxyPath);
   await open(event.media,'proxy');for(const time of [.3,1.5,2.5]){const sample=await compareFrame(event.media,ref,time,'proxy');assert.ok(sample.url.includes(encodeURIComponent(path.basename(event.media.proxyPath)).replaceAll('%2D','-'))||sample.url.includes('proxy.mp4'));assert.ok(Math.abs(sample.source-(base.in+time))<.003);}
   checks.push('Actual generated proxy selects the same source frames and uses zero offset, while retaining original metadata');
  }
 }
 // Rational frame boundaries, slow seeks and fractional placement must agree
 // with Chromium's actual decoded frame, not only an analytical timestamp.
 for(const [rate,fps,sourceIn,speed,start] of [['30',30,0,1,0],['30',30,.06,1,0],['30',60,.137,1,0],['30000-1001',30,.06,1,0],['10',30,.137,.1,0],['30',30,.137,1,.015],['30-tagged',30,0,1,0]]){
  const [media]=await page.evaluate(files=>window.studio.importMedia(files),[path.resolve(`.test-artifacts/render-clock/source-${rate}.mp4`)]),ref=await reference(media),label=`native-${rate}-${fps}-${sourceIn}-${speed}-${start}`,project=await open(media,label,false,{fps,clip:{in:sourceIn,speed,start,duration:1}});
  for(const n of [1,2,7,11,20,27])await compareFrame(media,ref,n/fps,label,project.clips[0]);
  await exportFrames(project,media,ref,label,'cpu');if(system.encoders.includes('h264_nvenc'))await exportFrames(project,media,ref,label,'nvenc');
  checks.push(`${label}: six actual native seeks and complete CPU${system.encoders.includes('h264_nvenc')?'/NVENC':''} IPC exports preserve the exact source frame identity`);
 }
 for(const name of ['shifted','mp4-shifted']){const media=imported[name],ref=await reference(media),project=await open(media,`export-${name}`,false,{fps:30,clip:{in:.06,duration:1}});await exportFrames(project,media,ref,name,'cpu');if(system.encoders.includes('h264_nvenc'))await exportFrames(project,media,ref,name,'nvenc');}
 checks.push('Shifted MKV and MP4 actual CPU/NVENC exports retain normalized fractional source trims');
 await installAudioProbe(page);
 for(const name of ['mp3','m4a','opus']){
  const media=imported[name],raw=(await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-i',media.path,'-ss','1.5','-t','0.2','-ac','2','-ar','48000','-f','f32le','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:1024*1024})).stdout;
  const reference=[0,1].map(channel=>{let peak=0,sum=0;for(let i=channel*4;i<raw.length;i+=8){const sample=raw.readFloatLE(i);peak=Math.max(peak,Math.abs(sample));sum+=sample*sample;}return {peak:20*Math.log10(peak),rms:20*Math.log10(Math.sqrt(sum/(raw.length/8)))};});
  await open(media,name);await seek(1.3);const paused=await page.evaluate(()=>{const n=document.querySelector('.preview-gpu-stage').previewRuntime.nodes.get('clock-clip');return {source:n.element.currentTime,offset:n.media.timing.previewOffset};});assert.ok(Math.abs(paused.source-(1.5+paused.offset))<.003);
  await page.keyboard.press('Space');await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.time()>1.55);
  const moving=await page.evaluate(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime,n=r.nodes.get('clock-clip');return {timeline:r.time(),source:n.element.currentTime,offset:n.media.timing.previewOffset,levels:window.__audioLevels()};});
  assert.ok(moving.timeline<1.8);assert.ok(Math.abs(moving.source-moving.offset-moving.timeline-.2)<.04);assert.equal(moving.levels.length,2);
  for(let channel=0;channel<2;channel++){assert.ok(Math.abs(moving.levels[channel].peak-reference[channel].peak)<.6,`${name} channel${channel} peak`);assert.ok(Math.abs(moving.levels[channel].rms-reference[channel].rms)<.6,`${name} channel${channel} RMS`);}
  playback.push({name,...moving,reference});await page.keyboard.press('Space');
  if(name==='mp3'){
   await page.locator('.media-card').first().click();await page.waitForFunction(()=>document.querySelector('.source-monitor audio')?.readyState>=2);const scrubber=page.getByLabel('소스 재생 위치',{exact:true});await scrubber.focus();await page.keyboard.press('End');await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>Math.abs(document.querySelector('.source-monitor audio').currentTime-3.9)<.003&&!document.querySelector('.source-monitor audio').error);await page.getByRole('button',{name:'프로그램',exact:true}).first().click();
   checks.push('MP3 source monitor seeks near EOF through the same lossless preview remux');
  }
 }
 checks.push('MP3, M4A and Opus audio retain normalized seek and playback clocks');
 checks.push('Actual stereo audio peaks and RMS at the requested source interval match independently decoded FFmpeg PCM');
 assert.deepEqual(errors,[]);await captureElectron(app,{path:path.join(root,'clock.png')});const sourceHashes={};for(const file of ['shared/media-clock.ts','electron/media-timing.ts','electron/media.ts','electron/video-color.ts','electron/video-input.ts','electron/audio-preview.ts','electron/main.ts','electron/project-sources.ts','src/preview/runtime.ts','src/SourceMonitor.tsx','scripts/e2e-media-clock.mjs','tests/media-clock.test.ts','tests/render-clock.test.ts','tests/audio-preview.test.ts'])sourceHashes[file]=digest(await fs.readFile(file));
 const asar=await app.evaluate(({app})=>app.isPackaged?app.getAppPath():null);await fs.writeFile(path.join(root,'results.json'),JSON.stringify({version,executable:process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null,checks,errors,frames,playback,exports,sourceHashes,asarSha256:asar?digest(await fs.readFile(asar)):null,profile},null,2));console.log(JSON.stringify({checks,errors,frames,playback,exports},null,2));
}catch(error){errors.push(String(error));await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({checks,errors,frames,playback,exports,profile},null,2));throw error;}finally{await app.evaluate(()=>{const {createRequire,syncBuiltinESMExports}=process.getBuiltinModule('module'),cp=createRequire(process.execPath)('node:child_process');if(globalThis.clockOriginalSpawn){cp.spawn=globalThis.clockOriginalSpawn;syncBuiltinESMExports();}}).catch(()=>{});await app.close();}
