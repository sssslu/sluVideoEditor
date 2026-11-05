import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';

import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';

// This test launches the packaged application and invokes its real preload/IPC
// export handlers. The spawn wrapper only records child arguments/results;
// every decoder, compositor, native audio worker and encoder runs unchanged.
const root=path.resolve('.test-artifacts/packaged-transitions');
const executable=path.resolve(process.env.SLU_TEST_EXE||'release/win-unpacked/SLU Studio.exe');
const expectedVersion=JSON.parse(await fs.readFile('package.json','utf8')).version;
const profile=path.join(root,`profile-${Date.now()}`),run=promisify(execFile),checks=[],errors=[],details=[];
await fs.mkdir(root,{recursive:true});await fs.access(executable);
const env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
let app,page,version,resources,audit=[];
const digest=data=>createHash('sha256').update(data).digest('hex');
const samePath=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const near=(a,b,tolerance)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} differs from ${b}`);
async function binary(file,args,maxBuffer=64*1024*1024){return run(file,args,{windowsHide:true,encoding:'buffer',maxBuffer,timeout:120000});}

try{
  app=await launchTestElectron({executablePath:executable,args:electronTestArgs(true),env,timeout:90000});page=await app.firstWindow();
  page.on('pageerror',error=>errors.push(String(error)));page.on('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
  const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,executable:process.execPath,resources:process.resourcesPath,appPath:app.getAppPath()}));
  assert.equal(runtime.packaged,true);assert.ok(samePath(runtime.executable,executable));assert.ok(runtime.appPath.endsWith('app.asar'));resources=runtime.resources;
  const system=await page.evaluate(()=>window.studio.getSystemInfo());version=system.version;assert.equal(version,expectedVersion);assert.ok(system.encoders.includes('h264_nvenc'),'This hardware verification requires the known RTX NVENC encoder');
  checks.push('Packaged EXE launches its ASAR application and bundled runtime with the expected release version');

  await app.evaluate(async()=>{
    const {createRequire,syncBuiltinESMExports}=process.getBuiltinModule('module');const require=createRequire(process.execPath),cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    globalThis.packagedTransitionAudit=[];globalThis.packagedTransitionPhase='setup';globalThis.packagedTransitionOriginalSpawn=cp.spawn;
    cp.spawn=function(file,args,options){
      const commandArgs=Array.isArray(args)?args.slice():[],entry={phase:globalThis.packagedTransitionPhase,startedAt:new Date().toISOString(),file:String(file),args:commandArgs,cwd:options?.cwd||null};
      const graphAt=commandArgs.indexOf('-filter_complex_script');if(graphAt>=0&&options?.cwd){try{
        entry.filterGraph=fs.readFileSync(path.resolve(options.cwd,commandArgs[graphAt+1]),'utf8');entry.shaders=[];
        for(const match of entry.filterGraph.matchAll(/program_opencl=source=([^:;,]+)/g)){const source=fs.readFileSync(path.join(options.cwd,match[1]),'utf8');entry.shaders.push({name:match[1],sha256:crypto.createHash('sha256').update(source).digest('hex'),source});}
      }catch(error){entry.observationError=String(error);}}
      const child=Reflect.apply(globalThis.packagedTransitionOriginalSpawn,this,arguments);entry.pid=child.pid;globalThis.packagedTransitionAudit.push(entry);
      child.once('error',error=>{entry.error=String(error);});child.once('close',(code,signal)=>{entry.exitCode=code;entry.signal=signal;entry.closedAt=new Date().toISOString();});return child;
    };syncBuiltinESMExports();
  });

  const ffmpeg=path.join(resources,'bin','ffmpeg.exe'),ffprobe=path.join(resources,'bin','ffprobe.exe'),source=path.join(root,'packaged-source.mkv');
  await binary(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=640x360:r=60:d=8','-f','lavfi','-i',"aevalsrc='0.18*sin(2*PI*437*t)|if(between(t,2.13,2.17)+between(t,4.13,4.17),0.5*sin(2*PI*3000*t),0.12*sin(2*PI*997*t+if(gt(t,4),PI/2,0)))':s=48000:d=8",'-c:v','libx264','-preset','ultrafast','-crf','12','-c:a','pcm_f32le',source]);
  const [imported]=await page.evaluate(files=>window.studio.importMedia(files),[source]);assert.equal(imported.kind,'video');assert.equal(imported.hasAudio,true);assert.match(imported.sourceRevision,/^[a-f0-9]{64}$/);
  const media=await page.evaluate(media=>window.studio.analyzeVideoRange(media),imported);near(media.videoStart,0,.001001);near(media.videoEnd,8,.001001); // Matroska timestamps use a 1 ms time base.
  checks.push('Real media-import and video-range IPC read the packaged-runtime source, stereo audio and exact video handles');

  const base={trackId:'video-1',mediaId:media.id,name:'Packaged video',duration:2,speed:1,volume:.7,fadeIn:0,fadeOut:0,opacity:1,scale:1,x:0,y:0,rotation:0,fit:'contain',flipH:false,flipV:false,brightness:0,contrast:1,saturation:1,blur:0,preset:'none',fontSize:36,fontFamily:'Malgun Gothic',color:'#ffffff',textBackground:'#171923',textStyle:'bold',align:'center',animation:'none',keyframes:[]};
  const clips=[0,1,2].map(i=>({...base,id:`packaged-clip-${i}`,start:i*2,in:1+i*2,name:`Packaged clip ${i+1}`}));
  clips[0].mask={type:'ellipse',x:.5,y:.5,width:.9,height:.9,feather:.04,invert:false};clips[0].scale=.9;clips[0].rotation=-4;clips[0].fadeIn=.2;
  clips[1].speedCurve=[{position:0,speed:.7},{position:.5,speed:1.3},{position:1,speed:.7}];clips[1].opacity=.8;clips[1].rotation=4;clips[1].scale=.95;clips[2].fadeOut=.3;
  const project={version:3,id:randomUUID(),name:'Packaged transition runtime',width:640,height:360,fps:30,background:'#112233',media:[media],tracks:[{id:'video-1',name:'영상',type:'video',hidden:false,muted:false,locked:false}],clips,transitions:[{id:'packaged-slide',fromClipId:clips[0].id,toClipId:clips[1].id,kind:'slide',direction:'left',durationFrames:30,easing:'ease-in-out',audio:'equal-power'},{id:'packaged-zoom',fromClipId:clips[1].id,toClipId:clips[2].id,kind:'zoom',durationFrames:30,easing:'ease-in-out',audio:'linear'}],updatedAt:new Date().toISOString()};
  await fs.writeFile(path.join(root,'fixture.sluproj'),JSON.stringify(project,null,2));
  await page.evaluate(()=>{window.packagedTransitionJobs=[];window.packagedTransitionOff=window.studio.onJob(event=>window.packagedTransitionJobs.push(event));});

  const outputs=[];
  for(const processing of ['auto','cpu']){
    const phase=`export-${processing}`,output=path.join(root,`${phase}.mp4`),settings={width:640,height:360,fps:30,format:'mp4',codec:'h264',encoder:'nvenc',quality:'high',transitionProcessing:processing};
    await app.evaluate(({dialog},{phase,output})=>{globalThis.packagedTransitionPhase=phase;dialog.showSaveDialog=async()=>({canceled:false,filePath:output});},{phase,output});
    const started=Date.now(),job=await page.evaluate(({project,settings})=>window.studio.exportProject(project,settings),{project,settings});assert.ok(job?.jobId);assert.ok(samePath(job.path,output));
    await page.waitForFunction(id=>window.packagedTransitionJobs.some(event=>event.id===id&&['complete','error','cancelled'].includes(event.status)),job.jobId,{timeout:180000});
    const event=await page.evaluate(id=>window.packagedTransitionJobs.find(event=>event.id===id&&['complete','error','cancelled'].includes(event.status)),job.jobId);assert.equal(event.status,'complete',event.message);
    const elapsedSeconds=(Date.now()-started)/1000,observed=await app.evaluate((_,phase)=>globalThis.packagedTransitionAudit.filter(entry=>entry.phase===phase),phase);
    const windows=observed.filter(entry=>entry.filterGraph),gpuWindows=windows.filter(entry=>entry.filterGraph.includes('program_opencl=')),encoders=observed.filter(entry=>entry.args.includes('h264_nvenc')&&entry.args.some(arg=>String(arg).includes('.partial.mp4'))),workers=observed.filter(entry=>path.basename(entry.file)==='slu-audio-stretch.exe');
    assert.ok(windows.length>0);assert.ok(windows.every(entry=>entry.exitCode===0&&!entry.observationError));assert.equal(encoders.length,1);assert.equal(encoders[0].exitCode,0);assert.ok(workers.length>0);assert.ok(workers.every(entry=>entry.exitCode===0));
    for(const child of [...windows,...encoders,...workers])assert.ok(path.resolve(child.file).toLowerCase().startsWith(path.resolve(resources,'bin').toLowerCase()+path.sep),'Child process escaped bundled runtime');
    if(processing==='auto'){
      assert.ok(gpuWindows.length>0,'No actual OpenCL rendering window ran');assert.equal(gpuWindows.reduce((sum,entry)=>sum+entry.shaders.length,0),2);assert.ok(gpuWindows.every(entry=>entry.args.includes('-init_hw_device')&&entry.shaders.every(shader=>shader.source.includes('cl_khr_fp64')&&shader.source.includes('FP_CONTRACT OFF'))));
      checks.push('Packaged main launches successful OpenCL slide and zoom windows using fp64 kernels and bundled FFmpeg');
    }else{assert.equal(gpuWindows.length,0);assert.ok(windows.every(entry=>!entry.args.includes('-init_hw_device')));checks.push('CPU transition override removes GPU window processing while retaining the actual NVENC encoder');}

    const probe=JSON.parse((await binary(ffprobe,['-v','error','-count_frames','-show_streams','-show_format','-of','json',output])).stdout.toString()),video=probe.streams.find(stream=>stream.codec_type==='video');assert.equal(video.codec_name,'h264');assert.equal(video.width,640);assert.equal(video.height,360);assert.equal(Number(video.nb_read_frames),180);assert.equal(video.avg_frame_rate,'30/1');near(Number(probe.format.duration),6,.04);assert.ok(probe.streams.some(stream=>stream.codec_type==='audio'&&stream.channels===2));
    const pcm=(await binary(ffmpeg,['-v','error','-i',output,'-map','0:a:0','-ac','2','-ar','48000','-f','f32le','pipe:1'])).stdout;assert.ok(pcm.length/8>=288000&&pcm.length/8<=289024);const energy=[0,0];for(let i=0;i<pcm.length;i+=8){energy[0]+=pcm.readFloatLE(i)**2;energy[1]+=pcm.readFloatLE(i+4)**2;}const audioRms=energy.map(value=>Math.sqrt(value/(pcm.length/8)));assert.ok(audioRms.every(value=>value>.02));
    const frames=(await binary(ffmpeg,['-v','error','-i',output,'-vf',"select='eq(n,15)+eq(n,60)+eq(n,120)+eq(n,165)'",'-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;assert.equal(frames.length,640*360*3*4);
    outputs.push({processing,pcm,frames});details.push({processing,output,elapsedSeconds,frames:Number(video.nb_read_frames),fps:video.avg_frame_rate,duration:Number(probe.format.duration),audioSamples:pcm.length/8,audioRms,audioSha256:digest(pcm),gpuWindowPids:gpuWindows.map(entry=>entry.pid),windowPids:windows.map(entry=>entry.pid),encoder:encoders[0].args[encoders[0].args.indexOf('-c:v')+1],encoderPid:encoders[0].pid,nativeAudioPids:workers.map(entry=>entry.pid),kernelCount:gpuWindows.reduce((sum,entry)=>sum+entry.shaders.length,0)});
    checks.push(`${processing}: real exported file has180 frames, six-second duration and non-silent stereo curve/fade audio from the bundled native worker`);
  }
  assert.ok(outputs[0].pcm.equals(outputs[1].pcm),'GPU/CPU transition selection changed decoded stereo audio');let difference=0;for(let i=0;i<outputs[0].frames.length;i++)difference+=Math.abs(outputs[0].frames[i]-outputs[1].frames[i]);const sampledMeanRgbDifference=difference/outputs[0].frames.length;assert.ok(sampledMeanRgbDifference<.8,`GPU/CPU encoded frame difference ${sampledMeanRgbDifference}`);
  details.push({comparison:{audioByteIdentical:true,sampledFrames:[15,60,120,165],sampledMeanRgbDifference}});checks.push('GPU and CPU packaged exports retain byte-identical decoded stereo audio and matching sampled video geometry');
  audit=await app.evaluate(()=>globalThis.packagedTransitionAudit);await fs.writeFile(path.join(root,'spawn-audit.json'),JSON.stringify(audit,null,2));
  const bundleHashes={asar:digest(await fs.readFile(path.join(resources,'app.asar'))),ffmpeg:digest(await fs.readFile(path.join(resources,'bin','ffmpeg.exe'))),audioStretch:digest(await fs.readFile(path.join(resources,'bin','slu-audio-stretch.exe')))};
  assert.deepEqual(errors,[]);await captureElectron(app,{path:path.join(root,'packaged-app.png')});await fs.writeFile(path.join(root,'results.json'),JSON.stringify({version,executable,recordedAt:new Date().toISOString(),timingContext:'Concurrent packaged UI correctness checks; elapsed times are not isolated performance benchmarks.',checks,errors,details,profile,resources,bundleHashes,spawnAudit:path.join(root,'spawn-audit.json')},null,2));console.log(JSON.stringify({version,executable,checks,errors,details},null,2));
}catch(error){
  errors.push(String(error));if(page)await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});if(app)audit=await app.evaluate(()=>globalThis.packagedTransitionAudit||[]).catch(()=>[]);await fs.writeFile(path.join(root,'spawn-audit.json'),JSON.stringify(audit,null,2));await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({version,executable,checks,errors,details,profile},null,2));throw error;
}finally{
  if(app){await app.evaluate(async()=>{const {createRequire,syncBuiltinESMExports}=process.getBuiltinModule('module');const cp=createRequire(process.execPath)('node:child_process');if(globalThis.packagedTransitionOriginalSpawn){cp.spawn=globalThis.packagedTransitionOriginalSpawn;syncBuiltinESMExports();}}).catch(()=>{});await app.close();}
}
