import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const root=path.resolve('.test-artifacts/stabilization-fidelity-ui');await fs.mkdir(root,{recursive:true});
const fixture=JSON.parse(await fs.readFile('.test-artifacts/stabilization-fidelity/fixtures.json','utf8')),version=JSON.parse(await fs.readFile('package.json','utf8')).version;
assert.equal(fixture.version,version);assert.equal(fixture.clock.length,8);assert.equal(fixture.colors.length,6);
const profile=path.join(root,`profile-${Date.now()}`),env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null,app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000}),page=await app.firstWindow();
const checks=[],errors=[],clock=[],colors=[],run=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const template=JSON.parse(await fs.readFile('examples/AURORA.sluproj','utf8'));
page.on('pageerror',e=>errors.push(String(e)));
const ff=async(args)=> (await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin',...args],{encoding:'buffer',windowsHide:true,maxBuffer:32*1024*1024,timeout:120000})).stdout;
const probe=async(file,args)=>JSON.parse((await run(path.resolve('resources/bin/ffprobe.exe'),['-v','error',...args,'-of','json',file],{windowsHide:true,timeout:60000})).stdout);
async function nativeFrames(file,width,height,times){return page.evaluate(async({file,width,height,times})=>{
  const video=document.createElement('video');video.crossOrigin='anonymous';video.muted=true;document.body.append(video);
  const wait=(event,start)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(Error(`Native ${event} timed out`));},15000),done=()=>{cleanup();resolve();},fail=()=>{cleanup();reject(Error(`Native decode failed ${video.error?.message||''}`));},cleanup=()=>{clearTimeout(timer);video.removeEventListener(event,done);video.removeEventListener('error',fail);};video.addEventListener(event,done,{once:true});video.addEventListener('error',fail,{once:true});start();});
  try{
    await wait('loadeddata',()=>{video.src=window.studio.mediaUrl(file);});
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d'),rows=[];
    for(const requested of times){const time=Math.round(requested*1e6)/1e6;if(Math.abs(video.currentTime-time)>1e-5)await wait('seeked',()=>{video.currentTime=time;});
      // The original shifted MP4 can revise its duration after the first seek.
      // Sample the requested time, not the temporary endpoint it was clamped to.
      // coldProgram independently checks the app handles this without test help.
      if(Math.abs(video.currentTime-time)>1e-5){if(video.duration<time)await wait('durationchange',()=>{});await wait('seeked',()=>{video.currentTime=time;});}if(Math.abs(video.currentTime-time)>1e-5)throw Error(`Native seek did not reach ${time}: ${video.currentTime}`);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));ctx.drawImage(video,0,0,width,height);const rgba=ctx.getImageData(0,0,width,height).data,frame=new VideoFrame(video),space=frame.colorSpace.toJSON();frame.close();let code=0;if(width===160&&height===90)for(let bit=0;bit<8;bit++){const at=(5*width+bit*20+10)*4;if((rgba[at]+rgba[at+1]+rgba[at+2])/3>128)code|=1<<bit;}
      const patches=Array.from({length:8},(_,i)=>{const at=(Math.floor(height/2)*width+Math.floor(width*(i+.5)/8))*4;return Array.from(rgba.slice(at,at+3));});rows.push({time,code,space,patches});
    }return rows;
  }finally{video.removeAttribute('src');video.load();video.remove();}
},{file,width,height,times});}
async function coldProgram(media,sourceIn,label){
  const clip={...template.clips.find(c=>c.mediaId),id:'fidelity-clip',mediaId:media.id,trackId:'video-1',start:0,in:sourceIn,duration:1,speed:1,speedCurve:undefined,volume:0,fadeIn:0,fadeOut:0,opacity:1,x:0,y:0,scale:1,rotation:0,brightness:0,contrast:1,saturation:1,blur:0,preset:'none',animation:'none',keyframes:[],crop:undefined,mask:undefined,colorGrade:undefined,audioEQ:undefined,sourceClipOffset:undefined,sourceClipDuration:undefined};
  const project={...template,version:6,id:`cold-${label}`,name:label,width:160,height:90,fps:10,media:[media],clips:[clip],transitions:undefined},file=path.join(root,`${project.id}.sluproj`);await fs.writeFile(file,JSON.stringify(project));await dismissToasts(page);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();
  await page.waitForFunction(id=>{const r=document.querySelector('.preview-gpu-stage')?.previewRuntime,n=r?.nodes.get('fidelity-clip');return r?.project.id===id&&n?.loaded&&n.element.readyState>=2&&!n.element.seeking;},project.id);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  return page.evaluate(()=>{const r=document.querySelector('.preview-gpu-stage').previewRuntime,n=r.nodes.get('fidelity-clip');r.snapshot();const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;const ctx=canvas.getContext('2d');ctx.drawImage(r.renderer.canvas,0,0,160,90);const rgba=ctx.getImageData(0,0,160,90).data;let code=0;for(let bit=0;bit<8;bit++)if(rgba[(5*160+bit*20+10)*4]>128)code|=1<<bit;return {code,sourceTime:n.element.currentTime};});
}
async function stabilize(media,start,duration){const job=await page.evaluate(({media,start,duration})=>window.studio.stabilizeMedia(media,{start,duration,smoothing:0,crop:'black',zoom:0}),{media,start,duration});await page.waitForFunction(id=>window.fidelityJobs.some(e=>e.id===id&&e.status!=='running'),job.jobId,{timeout:120000});const result=await page.evaluate(id=>window.fidelityJobs.find(e=>e.id===id&&e.status!=='running'),job.jobId);assert.equal(result.status,'complete',result.message);return result.media;}
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();assert.equal((await page.evaluate(()=>window.studio.getSystemInfo())).version,version);await page.evaluate(()=>{window.fidelityJobs=[];window.studio.onJob(e=>window.fidelityJobs.push(e));});
  await app.evaluate(()=>{const {createRequire,syncBuiltinESMExports}=process.getBuiltinModule('module'),cp=createRequire(process.execPath)('node:child_process');globalThis.fidelitySpawn=cp.spawn;globalThis.fidelityAudit=[];cp.spawn=function(file,args,options){const child=Reflect.apply(globalThis.fidelitySpawn,this,arguments);if(args?.includes('-read_intervals')){const row={file,args,stdout:'',stderr:''};globalThis.fidelityAudit.push(row);child.stdout?.on('data',data=>{row.stdout=(row.stdout+data.toString()).slice(-4096);});child.stderr?.on('data',data=>{row.stderr=(row.stderr+data.toString()).slice(-1024);});child.on('close',code=>{row.code=code;});}return child;};syncBuiltinESMExports();});
  for(const row of fixture.clock){
    const [media]=await page.evaluate(files=>window.studio.importMedia(files),[row.media.path]),output=await stabilize(media,row.start,row.duration);
    // Sample inside every actual displayed interval, including the held first
    // frame, short initial interval, sparse B-frame intervals and the last cut.
    const times=row.expectedTimes.map((pts,i)=>Math.min(row.duration-.0001,(pts/1e6+(row.expectedTimes[i+1]/1e6||row.duration))/2));
    const original=await nativeFrames(media.path,160,90,times.map(t=>media.timing.previewOffset+row.start+t)),derived=await nativeFrames(output.path,160,90,times),coldOriginal=await coldProgram(media,row.start,row.name+'-original'),coldDerived=await coldProgram(output,0,row.name+'-derived');
    await fs.writeFile(path.join(root,'last-native.json'),JSON.stringify({name:row.name,media,output,times,original,derived,coldOriginal,coldDerived,expected:row.expectedCodes},null,2));
    assert.equal(coldOriginal.code,row.expectedCodes[0],`${row.name}: cold original program frame`);assert.equal(coldDerived.code,row.expectedCodes[0],`${row.name}: cold stabilized program frame`);
    assert.deepEqual(original.map(r=>r.code),row.expectedCodes,`${row.name}: native original oracle`);assert.deepEqual(derived.map(r=>r.code),row.expectedCodes,`${row.name}: native stabilized frames`);
    const frames=(await probe(output.path,['-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time'])).frames.map(f=>Math.round(Number(f.best_effort_timestamp_time)*1e6));assert.deepEqual(frames,row.expectedTimes,`${row.name}: IPC output timestamps`);
    let audio;if(row.audio){const before=await ff(['-i',media.path,'-map','0:a:0','-f','f32le','pipe:1']),after=await ff(['-i',output.path,'-map','0:a:0','-f','f32le','pipe:1']),first=Number((await probe(media.path,['-select_streams','a:0','-show_frames','-show_entries','frame=best_effort_timestamp_time'])).frames[0].best_effort_timestamp_time),at=media.timing.origin+row.start,{channels,rate}=row.audio,from=Math.max(0,Math.round((at-first)*rate)),to=Math.min(before.length/(channels*4),Math.round((at+row.duration-first)*rate)),expected=before.subarray(from*channels*4,to*channels*4);assert.equal(after.length,expected.length);assert.equal(hash(after),hash(expected));audio={frames:after.length/(channels*4),sha256:hash(after)};}
    clock.push({name:row.name,source:media.path,output:output.path,times,original,derived,coldOriginal,coldDerived,frames,audio});checks.push(`${row.name}: cold program preview, native held/subsequent frames, presentation timestamps and available PCM audio retained`);
  }
  for(const row of fixture.colors){
    const [media]=await page.evaluate(files=>window.studio.importMedia(files),[row.media.path]),output=await stabilize(media,0,1),[original]=await nativeFrames(media.path,row.width,row.height,[.2]),[derived]=await nativeFrames(output.path,row.width,row.height,[.2]);
    const maximum=Math.max(...original.patches.flatMap((p,i)=>p.map((v,c)=>Math.abs(v-derived.patches[i][c]))));assert.ok(maximum<=2,`${row.name}: native flat RGB changed by ${maximum}`);assert.equal(derived.space.matrix,original.space.matrix);assert.equal(derived.space.fullRange,original.space.fullRange);
    colors.push({name:row.name,source:media.path,output:output.path,original,derived,maximum});checks.push(`${row.name}: native matrix, range and flat colors retained within 2/255`);
  }
  assert.deepEqual(errors,[]);await captureElectron(app,{path:path.join(root,'stabilization-fidelity.png')});
  const files=['electron/stabilization.ts','electron/video-frame.ts','electron/video-color.ts','electron/media-timing.ts','src/preview/runtime.ts','tests/stabilization.test.ts','tests/stabilization-fidelity.test.ts','scripts/e2e-stabilization-fidelity.mjs'];
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({version,executable,checks,errors,clock,colors,sourceHashes:Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await fs.readFile(file))]))),asarSha256:executable?hash(await fs.readFile(path.join(path.dirname(executable),'resources/app.asar'))):null,profile},null,2));console.log(JSON.stringify({checks,errors}));
}catch(error){await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});const audit=await app.evaluate(()=>globalThis.fidelityAudit).catch(()=>[]);await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({version,checks,errors,clock,colors,error:String(error),audit,profile},null,2));throw error;}finally{await app.evaluate(()=>{const {createRequire,syncBuiltinESMExports}=process.getBuiltinModule('module'),cp=createRequire(process.execPath)('node:child_process');if(globalThis.fidelitySpawn){cp.spawn=globalThis.fidelitySpawn;syncBuiltinESMExports();}}).catch(()=>{});await app.close();}
