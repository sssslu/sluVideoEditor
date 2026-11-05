import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newClip,newProject,splitClip,projectDuration} from '../shared/project';
import {clipTimelineTime,clipSourceSpan,clipSourceTime} from '../shared/speed';
import {clipSourceOffset,clipSpeedAt} from '../shared/speed';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {probeMedia,renderProject,runProcess,type EngineContext} from '../electron/media';
import type {ExportSettings} from '../shared/types';

const root=path.resolve('.test-artifacts/speed-render');
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false};
const settings=(name:string):ExportSettings=>({outputPath:path.join(root,name),width:160,height:90,fps:60,format:'mp4',codec:'h264',encoder:'cpu',quality:'high'});
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{maxOutputBytes:64*1024*1024});

test('speed-curve video follows inverse time mapping and is invariant across render windows', {timeout:60000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const source=path.join(root,'landmarks.mp4'),sourceMarks=[1.073,2.073,4.073,7.073];
  const gate=sourceMarks.map(time=>`between(t,${time},${time+.08})`).join('+');await ff(['-f','lavfi','-i',`color=black:s=160x90:r=120:d=9,drawbox=c=white:t=fill:enable='${gate}'`,'-c:v','libx264','-preset','ultrafast','-crf','0',source]);
  const media=await probeMedia(source,ctx,undefined,{derivatives:false}),p=newProject();p.width=160;p.height=90;p.fps=60;p.media=[media];const c=newClip('video-1',media,.137);c.in=.073;c.duration=8;c.volume=0;c.speed=7;c.speedCurve=[{position:0,speed:.5},{position:.5,speed:1.5},{position:1,speed:.5}];p.clips=[c];assert.equal(clipSourceSpan(c),8);
  for(const window of [1,6])await renderProject(p,settings(`curve-window${window}.mp4`),{...ctx,maxWindowSeconds:window});
  const hashes=async(name:string)=>(await ff(['-i',path.join(root,name),'-map','0:v:0','-f','framemd5','pipe:1'])).stdout.toString().split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>line.split(',').at(-1));
  const a=await hashes('curve-window1.mp4'),b=await hashes('curve-window6.mp4');assert.equal(a.length,Math.ceil(projectDuration(p)*60));assert.deepEqual(a,b,'Speed curve changed frames at render window boundaries');
  const events=async(name:string)=>{const raw=(await ff(['-i',path.join(root,name),'-vf','scale=1:1','-pix_fmt','gray','-f','rawvideo','pipe:1'])).stdout;const starts:number[]=[];for(let frame=0;frame<raw.length;frame++)if(raw[frame]>180&&(frame===0||raw[frame-1]<=180))starts.push(frame/60);return starts;};
  const expected=sourceMarks.map(sourceTime=>c.start+clipTimelineTime(c,sourceTime)),actual=await events('curve-window1.mp4');assert.equal(actual.length,expected.length);const errors=actual.map((time,i)=>time-expected[i]);assert.ok(errors.every(error=>Math.abs(error)<=1/60+.002),JSON.stringify({expected,actual,errors}));
  p.clips=splitClip(c,c.start+3.137)!;await renderProject(p,settings('curve-split.mp4'),ctx);const split=await events('curve-split.mp4');assert.equal(split.length,expected.length);assert.ok(split.every((time,i)=>Math.abs(time-expected[i])<=1/60+.002),JSON.stringify({expected,split}));
  const result={frames:a.length,windowFrameDifferences:0,expected,actual,errors,split};await fs.writeFile(path.join(root,'video-results.json'),JSON.stringify(result,null,2));t.diagnostic(JSON.stringify(result));
});

const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
function frequency(data:Buffer,from:number,length=.2){
  const start=Math.round(from*48000),count=Math.min(Math.round(length*48000),data.length/4-start);let best=0,pitch=0;
  for(let hz=420;hz<=460;hz+=.25){const coefficient=2*Math.cos(2*Math.PI*hz/48000);let a=0,b=0;for(let i=0;i<count;i++){const sample=data.readInt16LE((start+i)*4)/32768*(.5-.5*Math.cos(2*Math.PI*i/(count-1))),value=sample+coefficient*a-b;b=a;a=value;}const power=a*a+b*b-coefficient*a*b;if(power>best){best=power;pitch=hz;}}
  return pitch;
}

test('variable-speed audio preserves landmarks/sample counts and standard curves preserve pitch', {timeout:180000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const reports:Record<string,unknown>[]=[];
  for(const name of ['moderate','slow','slow-ramp','fast','extreme','zigzag'] as const){
    const p=newProject();p.width=160;p.height=90;p.fps=60;const c=newClip('audio-1');c.duration=name.startsWith('slow')?12:8;c.speed=7;c.volume=1;
    c.speedCurve=name==='moderate'?[{position:0,speed:.5},{position:.5,speed:1.5},{position:1,speed:.5}]:name==='slow'?[{position:0,speed:.1},{position:1,speed:.1}]:name==='slow-ramp'?[{position:0,speed:.1},{position:.5,speed:.3},{position:1,speed:.1}]:name==='fast'?[{position:0,speed:16},{position:1,speed:16}]:name==='zigzag'?Array.from({length:64},(_,i)=>({position:i/63,speed:i%2?16:.1})):[{position:0,speed:.1},{position:.5,speed:16},{position:1,speed:.1}];
    const timelineMarks=name==='moderate'?[1,2,4,7].map(source=>clipTimelineTime(c,source)):[1,2,4,6,7],sourceMarks=timelineMarks.map(time=>clipSourceOffset(c,time)),sourceFrames=Math.round(clipSourceSpan(c)*48000),raw=Buffer.alloc(sourceFrames*8),width=name==='moderate'?.08:.03;
    for(let frame=0;frame<sourceFrames;frame++){const time=frame/48000;raw.writeFloatLE(.2*Math.sin(2*Math.PI*440*time),frame*8);raw.writeFloatLE(sourceMarks.some(mark=>time>=mark&&time<mark+width)?.7*Math.sin(2*Math.PI*3000*time):0,frame*8+4);}
    const source=path.join(root,`audio-${name}.wav`),rawPath=path.join(root,`audio-${name}.f32`);await fs.writeFile(rawPath,raw);await ff(['-f','f32le','-ar','48000','-ac','2','-i',rawPath,'-c:a','pcm_f32le',source]);const asset=await probeMedia(source,ctx,undefined,{derivatives:false});c.mediaId=asset.id;c.text=undefined;p.media=[asset];p.clips=[c];
    const events:Record<string,unknown>[]=[],output={...settings(`audio-${name}-out.wav`),format:'wav' as const};await renderProject(p,output,{...ctx,diagnostics:event=>events.push(event)});
    const pcm=(await ff(['-i',output.outputPath!,'-f','s16le','pipe:1'])).stdout;assert.equal(pcm.length,Math.round(c.duration*48000)*4);
    const landmarks=timelineMarks.map((time,index)=>{const expected=clipTimelineTime(c,sourceMarks[index]+width/2),radius=name.startsWith('slow')?.45:.15;let energy=0,moment=0;for(let frame=Math.max(0,Math.floor((time-radius)*48000));frame<Math.min(pcm.length/4,Math.ceil((time+radius)*48000));frame++){const value=(pcm.readInt16LE(frame*4+2)/32768)**2;energy+=value;moment+=value*frame/48000;}const actual=moment/energy;assert.ok(energy>.001,`${name}: audio landmark disappeared`);return {expected,actual,error:actual-expected};});
    t.diagnostic(`${name} maximum landmark error ${Math.max(...landmarks.map(mark=>Math.abs(mark.error)))}`);
    const pitches=Array.from({length:14},(_,i)=>.7+i*.5).map(time=>frequency(pcm,time));t.diagnostic(`${name} pitch ${pitches.join(', ')}`);
    const chunks=events.filter(event=>event.event==='audio-chunk');assert.ok(chunks.length>=16);assert.ok(chunks.every(event=>Number(event.bufferBytes)<16*1024*1024));
    if(name==='moderate'){const other={...output,outputPath:path.join(root,'audio-moderate-window1.wav')};await renderProject(p,other,{...ctx,maxWindowSeconds:1});const otherPcm=(await ff(['-i',other.outputPath,'-f','s16le','pipe:1'])).stdout;assert.equal(digest(pcm),digest(otherPcm),'Video window size changed the speed curve audio');}
    reports.push({name,duration:c.duration,sourceDuration:clipSourceSpan(c),samples:pcm.length/4,landmarks,pitches,pitchPreservation:name==='zigzag'?'known-quality-limitation':'verified',maximumPitchErrorHz:Math.max(...pitches.map(hz=>Math.abs(hz-440))),maximumPitchErrorCents:Math.max(...pitches.map(hz=>Math.abs(1200*Math.log2(hz/440)))),chunkCount:chunks.length,peakBufferBytes:Math.max(...chunks.map(event=>Number(event.bufferBytes)))});
  }
  await fs.writeFile(path.join(root,'audio-results.json'),JSON.stringify(reports.filter(report=>report.name!=='zigzag'),null,2));t.diagnostic(JSON.stringify(reports));assert.ok(reports.every(report=>(report.landmarks as Array<{error:number}>).every(mark=>Math.abs(mark.error)<=1/60)),'Audio landmark drift exceeded one60fps frame');assert.ok(reports.filter(report=>report.name!=='zigzag').every(report=>(report.pitches as number[]).every(hz=>Math.abs(hz-440)<=2)),'Standard curve pitch drift exceeded2Hz; inspect audio-results.json');
  const aggressive=reports.find(report=>report.name==='zigzag')!;await fs.writeFile(path.join(root,'rapid-results.json'),JSON.stringify({...aggressive,qualityLimit:true,pointCount:64,minimumRate:.1,maximumRate:16,secondsBetweenPoints:8/63,analysis:{sourceHz:440,windowSeconds:.2,frequencyResolutionHz:.25,sampleTimes:Array.from({length:14},(_,i)=>.7+i*.5)},limitation:'Rapid oscillation between extreme rates can cause audible pitch modulation despite correct source timing and exact output sample count. This diagnostic is excluded from the standard curves pitch-preservation assertion.'},null,2));
});

test('curved video and pitch-preserved audio retain synchronized source landmarks after mux and split',{timeout:60000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const marks=[1.073,2.073,4.073,7.073],width=.08,frames=9*48000,raw=Buffer.alloc(frames*8);
  for(let frame=0;frame<frames;frame++){const time=frame/48000;raw.writeFloatLE(.2*Math.sin(2*Math.PI*440*time),frame*8);raw.writeFloatLE(marks.some(mark=>time>=mark&&time<mark+width)?.7*Math.sin(2*Math.PI*3000*time):0,frame*8+4);}
  const rawPath=path.join(root,'mux-source.f32'),source=path.join(root,'mux-source.mkv');await fs.writeFile(rawPath,raw);
  const gate=marks.map(time=>`between(t,${time},${time+width})`).join('+');await ff(['-f','lavfi','-i',`color=black:s=160x90:r=120:d=9,drawbox=c=white:t=fill:enable='${gate}'`,'-f','f32le','-ar','48000','-ac','2','-i',rawPath,'-c:v','libx264','-preset','ultrafast','-crf','0','-c:a','pcm_f32le',source]);
  const media=await probeMedia(source,ctx,undefined,{derivatives:false}),p=newProject();p.width=160;p.height=90;p.fps=60;p.media=[media];const c=newClip('video-1',media,.137);c.in=.073;c.duration=8;c.speedCurve=[{position:0,speed:.5},{position:.5,speed:1.5},{position:1,speed:.5}];p.clips=[c];
  // Decode the real source's discrete frames and timestamps. Comparing the
  // displayed frame centroid with an ideal continuous pulse alone hides source
  // sampling and adds half an output frame to the measured video time.
  const sourcePixels=(await ff(['-i',source,'-map','0:v:0','-vf','scale=1:1','-fps_mode','passthrough','-pix_fmt','gray','-f','rawvideo','pipe:1'])).stdout;
  const sourceTimes=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',source])).stdout.toString()).frames.map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*1e6));
  assert.equal(sourceTimes.length,sourcePixels.length);
  const report=[];for(const split of [false,true]){
    p.clips=split?splitClip(c,c.start+3.137)!:[c];const output=settings(`mux-${split?'split':'whole'}.mp4`);await renderProject(p,output,{...ctx,maxWindowSeconds:1});
    const pixels=(await ff(['-i',output.outputPath!,'-map','0:v:0','-vf','scale=1:1','-pix_fmt','gray','-f','rawvideo','pipe:1'])).stdout;
    const pcm=(await ff(['-i',output.outputPath!,'-map','0:a:0','-f','s16le','-ac','2','-ar','48000','pipe:1'])).stdout;
    const sampled=Array.from({length:pixels.length},(_,frame)=>{if(frame/60<c.start||frame/60>=c.start+c.duration)return 0;const target=Math.round((clipSourceTime(c,frame/60-c.start)+(media.timing?.origin||0))*1e6),index=sourceTimes.findLastIndex((time:number)=>time<=target);return sourcePixels[Math.max(0,index)]>180?1:0;});
    const mismatches=sampled.flatMap((expected,frame)=>Number(pixels[frame]>180)===expected?[]:[frame]);assert.deepEqual(mismatches,[],`Mux/split changed the exact sampled source frames: ${split}`);
    const landmarks=marks.map(mark=>{const expected=c.start+clipTimelineTime(c,mark+width/2);let ve=0,vm=0,se=0,sm=0,ae=0,am=0;for(let frame=Math.floor((expected-.2)*60);frame<Math.ceil((expected+.2)*60);frame++){const power=pixels[frame]>180?1:0;ve+=power;vm+=power*(frame+.5)/60;se+=sampled[frame];sm+=sampled[frame]*(frame+.5)/60;}for(let frame=Math.floor((expected-.2)*48000);frame<Math.ceil((expected+.2)*48000);frame++){const power=(pcm.readInt16LE(frame*4+2)/32768)**2;ae+=power;am+=power*frame/48000;}const video=vm/ve,sampledVideo=sm/se,audio=am/ae;return {expected,video,sampledVideo,audio,syncError:audio-video,sampledSyncError:(audio-video)-(expected-sampledVideo),videoError:video-expected,audioError:audio-expected};});
    assert.ok(landmarks.every(event=>Math.abs(event.audioError)<=1/60&&event.video===event.sampledVideo&&Math.abs(event.sampledSyncError)<=1/60),JSON.stringify({split,landmarks}));report.push({split,landmarks,frames:pixels.length,sourceFrameMismatches:mismatches.length});
  }
  await fs.writeFile(path.join(root,'mux-results.json'),JSON.stringify(report,null,2));t.diagnostic(JSON.stringify(report));
});

test('cancelling a curve export closes decoder, native worker and encoder without publishing output',{timeout:30000},async()=>{
  await fs.mkdir(root,{recursive:true});const source=path.join(root,'cancel-source.wav');await ff(['-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=6','-c:a','pcm_f32le',source]);
  const asset=await probeMedia(source,ctx,undefined,{derivatives:false}),p=newProject(),c=newClip('audio-1',asset);c.duration=60;c.speedCurve=[{position:0,speed:.1},{position:1,speed:.1}];p.media=[asset];p.clips=[c];
  const control=new AbortController(),pids=new Set<number>(),events:Record<string,unknown>[]=[],output={...settings(`cancel-${Date.now()}.wav`),format:'wav' as const};
  await assert.rejects(renderProject(p,output,{...ctx,diagnostics:event=>{events.push(event);if(typeof event.pid==='number')pids.add(event.pid);if(event.event==='audio-chunk')control.abort();}},undefined,control.signal),{name:'AbortError'});
  assert.ok(events.some(event=>event.role==='stretch'&&event.event==='audio-start'));assert.ok(pids.size>=3);for(const pid of pids){let alive=false;try{process.kill(pid,0);alive=true;}catch{}assert.equal(alive,false,`Owned process ${pid} survived cancellation`);}
  await assert.rejects(fs.stat(output.outputPath!),{code:'ENOENT'});const leftovers=(await fs.readdir(root)).filter(name=>name.includes(path.basename(output.outputPath!,'.wav'))&&name.endsWith('.wav'));assert.deepEqual(leftovers,[]);
  await fs.writeFile(path.join(root,'cancel-results.json'),JSON.stringify({cancelled:true,ownedPids:[...pids],liveProcesses:0,publishedOutput:false},null,2));
});

test('native audio worker rejects malformed or truncated requests without hanging',{timeout:10000},async()=>{
  for(const request of ['SLURB2 999999999999 100 0 100 2 1 0\n','SLURB2 48000 48000 0 48000 2 1 0\n0 0\n1 1\n','SLURB2 48000 48000 0 48000 3 1 0\n0 1\n5e-324 1\n1 1\n','SLURB2 48000 48000 0 48000 2 1 0\n0 1\n1 1\n']){
    const result=await new Promise<{code:number|null;stderr:string}>((resolve,reject)=>{const child=spawn(path.resolve('resources/bin/slu-audio-stretch.exe'),[],{windowsHide:true,stdio:['pipe','ignore','pipe']}),timer=setTimeout(()=>{child.kill();reject(new Error('Native worker did not terminate on invalid input'));},3000);let stderr='';child.stderr.on('data',data=>stderr+=data);child.stdin.on('error',()=>{});child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve({code,stderr});});child.stdin.end(request);});assert.equal(result.code,1);assert.match(result.stderr,/limits|speed map|Incomplete audio/);
  }
});

test('maximum64 speed points render without expression-depth failures and retain window parity',{timeout:30000},async()=>{
  await fs.mkdir(root,{recursive:true});const source=path.join(root,'many-points-source.mp4');await ff(['-f','lavfi','-i','testsrc2=s=160x90:r=120:d=5','-c:v','libx264','-preset','ultrafast',source]);
  const media=await probeMedia(source,ctx,undefined,{derivatives:false}),p=newProject(),c=newClip('video-1',media,.1);p.width=160;p.height=90;p.fps=60;c.in=.073;c.duration=2;c.volume=0;c.speedCurve=Array.from({length:64},(_,index)=>({position:index/63,speed:index%2?4:.25}));p.media=[media];p.clips=[c];
  const decoded=[];for(const window of [.5,6]){const output=settings(`many-points-window${window}.mp4`);await renderProject(p,output,{...ctx,maxWindowSeconds:window});decoded.push((await ff(['-i',output.outputPath!,'-map','0:v:0','-f','framemd5','pipe:1'])).stdout.toString());}assert.equal(decoded[0],decoded[1]);
});

test('60-second continuous curve keeps PCM bounded and non-integer tones free of periodic seams',{timeout:60000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const source=path.join(root,'continuous60-source.wav');await ff(['-f','lavfi','-i','aevalsrc=0.18*sin(2*PI*437*t)+0.12*sin(2*PI*997*t)|0.09*sin(2*PI*437*t)+0.06*sin(2*PI*997*t):s=48000:d=61','-c:a','pcm_f32le',source]);
  const asset=await probeMedia(source,ctx,undefined,{derivatives:false}),p=newProject(),c=newClip('audio-1',asset,.113);c.in=.137;c.duration=60;c.speedCurve=Array.from({length:33},(_,i)=>({position:i/32,speed:1+.5*Math.sin(i*Math.PI/8)}));p.media=[asset];p.clips=[c];
  const output={...settings('continuous60.wav'),format:'wav' as const},events:Record<string,unknown>[]=[],workers=new Set<number>(),samples:Record<string,number>[]=[],started=performance.now();let done=false;
  const render=renderProject(p,output,{...ctx,diagnostics:event=>{events.push(event);if(event.role==='stretch'&&typeof event.pid==='number')workers.add(event.pid);}}).finally(()=>{done=true;});
  const monitor=(async()=>{while(!done){if(workers.size){const ids=[...workers].join(','),command=`$items = @(Get-Process -Id ${ids} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PeakWorkingSet64); ConvertTo-Json -Compress -InputObject $items`;const value=await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',command]);for(const item of JSON.parse(value.stdout.toString()||'[]'))samples.push({pid:item.Id,workingSetBytes:item.WorkingSet64,peakWorkingSetBytes:item.PeakWorkingSet64});}await new Promise(resolve=>setTimeout(resolve,100));}})();await render;const renderSeconds=(performance.now()-started)/1000;await monitor;
  const pcm=(await ff(['-i',output.outputPath!,'-f','f32le','-ac','2','-ar','48000','pipe:1'])).stdout;assert.equal(pcm.length/8,Math.round(projectDuration(p)*48000));const offset=Math.round(c.start*48000),sample=(frame:number,channel=0)=>pcm.readFloatLE((frame+offset)*8+channel*4);
  const rms=(center:number)=>{let energy=0;const from=Math.round((center-.01)*48000);for(let i=0;i<960;i++)energy+=sample(from+i)**2;return Math.sqrt(energy/960);};
  // Compare equal-density neighborhoods. Two incommensurate tones naturally
  // beat; comparing thousands of boundary samples with a sparse median would
  // misclassify ordinary amplitude variation as a periodic processing seam.
  const ordinary:number[]=[];for(let time=1;time<59;time+=.25)for(let delta=-.02;delta<=.020001;delta+=.002)ordinary.push(rms(time+.125+delta));ordinary.sort((a,b)=>a-b);const reference=ordinary[Math.floor(ordinary.length/2)];
  let minimumBoundaryRms=Infinity,maximumBoundaryDerivative=0,ordinaryDerivative=0,stereoError=0;for(let time=1;time<59;time+=.25){for(let delta=-.02;delta<=.020001;delta+=.002)minimumBoundaryRms=Math.min(minimumBoundaryRms,rms(time+delta));}
  for(let i=48000;i<59*48000;i++){const change=Math.abs(sample(i)-sample(i-1)),phase=(i/48000)%.25;if(phase<.02||phase>.23)maximumBoundaryDerivative=Math.max(maximumBoundaryDerivative,change);else ordinaryDerivative=Math.max(ordinaryDerivative,change);stereoError=Math.max(stereoError,Math.abs(sample(i,1)-.5*sample(i)));}
  const rmsRatio=minimumBoundaryRms/reference,derivativeRatio=maximumBoundaryDerivative/ordinaryDerivative,chunks=events.filter(event=>event.event==='audio-chunk'),peakBufferBytes=Math.max(...chunks.map(event=>Number(event.bufferBytes))),peakNativeWorkingSetBytes=Math.max(0,...samples.map(item=>item.peakWorkingSetBytes));
  const boundaryVsOrdinary=minimumBoundaryRms/ordinary[0],report={duration:projectDuration(p),curveDuration:c.duration,points:c.speedCurve.length,samples:pcm.length/8,renderSeconds,elapsedSeconds:(performance.now()-started)/1000,peakBufferBytes,peakNativeWorkingSetBytes,minimumBoundaryRmsRatio:rmsRatio,ordinaryMinimumRmsRatio:ordinary[0]/reference,boundaryVsOrdinaryMinimum:boundaryVsOrdinary,maximumBoundaryDerivativeRatio:derivativeRatio,stereoGainError:stereoError,memorySamples:samples};await fs.writeFile(path.join(root,'continuous60-results.json'),JSON.stringify(report,null,2));t.diagnostic(JSON.stringify(report));
  assert.ok(boundaryVsOrdinary>.95,`Periodic amplitude dip ${boundaryVsOrdinary}`);assert.ok(derivativeRatio<1.1,`Periodic derivative spike ${derivativeRatio}`);assert.ok(stereoError<.0002,`Stereo gain relationship changed ${stereoError}`);assert.ok(peakBufferBytes<512*1024);assert.ok(peakNativeWorkingSetBytes>0&&peakNativeWorkingSetBytes<128*1024*1024);
});
