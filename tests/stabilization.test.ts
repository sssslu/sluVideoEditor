import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {probeMedia,runProcess} from '../electron/media';
import {readSourceRevision} from '../electron/source-revision';
import {normalizeStabilizationOptions,stabilizeMedia,supportsStabilization,type StabilizationContext} from '../electron/stabilization';
import type {StabilizationOptions} from '../shared/types';

const root=path.resolve('.test-artifacts/stabilization');
const ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),ffprobe=path.resolve('resources/bin/ffprobe.exe');
const ff=(args:string[])=>runProcess(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{timeoutMs:60000,maxOutputBytes:128*1024*1024});
const sha=(buffer:Buffer)=>createHash('sha256').update(buffer).digest('hex');
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};

test('stabilization settings reject invalid ranges and injected filter parameters',()=>{
  assert.deepEqual(normalizeStabilizationOptions({},10),{start:0,duration:10,smoothing:30,accuracy:15,shakiness:5,crop:'auto',zoom:0});
  const invalid:StabilizationOptions[]=[{start:-1},{start:10},{duration:0},{start:9,duration:2},{smoothing:121},{smoothing:2.5},{accuracy:5,shakiness:10},{zoom:NaN},{shakiness:Infinity},{crop:'black;movie=secret' as 'black'}];
  for(const options of invalid)assert.throws(()=>normalizeStabilizationOptions(options,10));
  assert.deepEqual(normalizeStabilizationOptions({start:2,crop:'black',zoom:3,smoothing:0},10),{start:2,duration:8,smoothing:0,accuracy:15,shakiness:5,crop:'black',zoom:3});
  assert.equal(normalizeStabilizationOptions({start:200000,duration:30},300000).start,200000);
});

function pattern(width:number,height:number):Buffer {
  const data=Buffer.alloc(width*height*3);let seed=81421;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const gray=x%23<2||y%19<2?220:35+((seed>>>24)%115),at=(y*width+x)*3;
    data[at]=data[at+1]=data[at+2]=gray;
    if((Math.abs(x-width/2)<4&&Math.abs(y-height/2)<20)||(Math.abs(x-width/2)<20&&Math.abs(y-height/2)<4)){
      data[at]=245;data[at+1]=15;data[at+2]=245;
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`),data]);
}
function markerMotion(raw:Buffer,width:number,height:number) {
  const stride=width*height*3,positions:Array<{x:number;y:number}>=[];
  assert.equal(raw.length%stride,0);
  for(let frame=0;frame<raw.length/stride;frame++){
    let sumX=0,sumY=0,count=0;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const i=frame*stride+(y*width+x)*3;
      if(raw[i]>160&&raw[i+1]<100&&raw[i+2]>160){sumX+=x;sumY+=y;count++;}
    }
    assert.ok(count>100,`Missing stabilization marker in frame ${frame}`);positions.push({x:sumX/count,y:sumY/count});
  }
  const mean={x:positions.reduce((s,p)=>s+p.x,0)/positions.length,y:positions.reduce((s,p)=>s+p.y,0)/positions.length};
  const variance=positions.reduce((s,p)=>s+(p.x-mean.x)**2+(p.y-mean.y)**2,0)/positions.length;
  return {variance,positions};
}
async function timestamps(file:string) {
  const result=await runProcess(ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',file],{timeoutMs:30000});
  return JSON.parse(result.stdout.toString()).frames.map((f:{best_effort_timestamp_time:string})=>Number(f.best_effort_timestamp_time)) as number[];
}

test('real two-pass stabilization reduces measured shake while preserving selected frames, audio, source and cancellation cleanup',{timeout:120000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const work=await fs.mkdtemp(path.join(root,'run-'));
  const ctx:StabilizationContext={ffmpeg,ffprobe,cacheDir:path.join(work,'cache'),derivedDir:path.join(work,'permanent-derived')};
  assert.equal(await supportsStabilization(ctx),true);
  const image=path.join(work,'pattern.ppm'),source=path.join(work,'shaky-source.mov');await fs.writeFile(image,pattern(360,280));
  await ff(['-loop','1','-framerate','30','-i',image,'-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-t','4',
    '-vf',"crop=320:240:x='20+8*sin(n*2.1)+5*sin(n*.73)':y='20+7*cos(n*1.61)+4*sin(n*.91)':exact=1,format=yuv420p",
    '-c:v','libx264','-preset','veryfast','-crf','8','-c:a','pcm_f32le','-shortest',source]);
  const sourceHash=sha(await fs.readFile(source)),media=await probeMedia(source,ctx,undefined,{derivatives:false});
  const start=.137,duration=2.731,progress:Array<{value:number;message?:string}>=[],pids=new Set<number>();
  const begun=performance.now();const output=await stabilizeMedia(media,{start,duration,smoothing:15,accuracy:15,crop:'auto'},
    {...ctx,diagnostics:e=>{if(typeof e.pid==='number')pids.add(e.pid);}},(value,message)=>progress.push({value,message}));
  const seconds=(performance.now()-begun)/1000;
  assert.notEqual(output.id,media.id);assert.notEqual(output.path,source);assert.equal(output.width,320);assert.equal(output.height,240);assert.equal(output.hasAudio,true);
  assert.equal(output.sourceRevision,await readSourceRevision(output.path),'Published source revision must describe the final path after staging cleanup');
  assert.ok(output.duration>=duration-.001&&output.duration<duration+1/30+.003);
  assert.equal(sha(await fs.readFile(source)),sourceHash,'Source file was modified');
  assert.ok(progress.some(p=>p.value>=.45&&p.value<.95));assert.equal(progress.at(-1)?.value,1);
  for(let i=1;i<progress.length;i++)assert.ok(progress[i].value>=progress[i-1].value);
  const allTimes=await timestamps(source),first=allTimes.reduce((last,value,i)=>Math.round(value*1e6)<=Math.round(start*1e6)?i:last,-1),indices=allTimes.flatMap((value,i)=>i>=first&&value<start+duration?[i]:[]);
  const allRaw=(await ff(['-i',source,'-map','0:v:0','-an','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
  const stride=320*240*3,beforeRaw=Buffer.concat(indices.map(i=>allRaw.subarray(i*stride,(i+1)*stride)));
  const afterRaw=(await ff(['-i',output.path,'-map','0:v:0','-an','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
  const before=markerMotion(beforeRaw,320,240),after=markerMotion(afterRaw,320,240);
  assert.equal(after.positions.length,before.positions.length);
  assert.ok(after.variance<before.variance*.2,`Shake was not sufficiently reduced: before ${before.variance}, after ${after.variance}`);
  const inputTimes=indices.map(i=>Math.max(0,allTimes[i]-start)),outputTimes=await timestamps(output.path);
  // A cut between source frames shortens the first displayed interval. The
  // resulting average FPS can differ; actual presentation times are authoritative.
  assert.equal(outputTimes[0],0);assert.ok(outputTimes[1]<1/30);
  assert.equal(outputTimes.length,inputTimes.length);const maxTimestampError=Math.max(...inputTimes.map((v,i)=>Math.abs(v-outputTimes[i])));assert.ok(maxTimestampError<.001);
  const expectedPcm=(await ff(['-i',source,'-map','0:a:0','-af',`atrim=start_sample=${Math.round(start*48000)}:end_sample=${Math.round((start+duration)*48000)}`,'-f','f32le','pipe:1'])).stdout;
  const actualPcm=(await ff(['-i',output.path,'-map','0:a:0','-f','f32le','pipe:1'])).stdout;
  assert.equal(actualPcm.length,expectedPcm.length,'Selected audio sample count changed');
  assert.equal(sha(actualPcm),sha(expectedPcm),'Stabilization changed decoded audio samples');
  const outputInfo=JSON.parse((await runProcess(ffprobe,['-v','error','-show_streams','-of','json',output.path])).stdout.toString());
  const audio=outputInfo.streams.find((s:{codec_type:string})=>s.codec_type==='audio');assert.equal(audio.codec_name,'pcm_f32le');assert.equal(audio.sample_rate,'48000');assert.equal(audio.channels,1);assert.ok(Math.abs(Number(audio.start_time))<.001);
  const filesBefore=await fs.readdir(ctx.derivedDir!);const cancelResults=[];
  for(const phase of ['analyze','transform']){
    const control=new AbortController(),owned=new Set<number>();const cancelStart=performance.now();
    await assert.rejects(stabilizeMedia(media,{start,duration},{...ctx,diagnostics:event=>{if(typeof event.pid==='number'){owned.add(event.pid);if(event.phase===phase)control.abort();}}},undefined,control.signal),error=>error instanceof Error&&error.name==='AbortError');
    assert.ok(owned.size>0);assert.deepEqual([...owned].filter(alive),[]);assert.deepEqual(await fs.readdir(ctx.derivedDir!),filesBefore);
    cancelResults.push({phase,seconds:(performance.now()-cancelStart)/1000,processes:[...owned]});
  }
  assert.deepEqual([...pids].filter(alive),[]);assert.equal(sha(await fs.readFile(source)),sourceHash);
  await ff(['-ss','1','-i',source,'-frames:v','1',path.join(root,'before.png')]);await ff(['-ss',String(1-start),'-i',output.path,'-frames:v','1',path.join(root,'after.png')]);
  const report={backend:'FFmpeg libvidstab CPU, two passes',source,output:output.path,start,duration,outputDuration:output.duration,frames:after.positions.length,sourceHash,
    processingSeconds:seconds,translationVarianceBefore:before.variance,translationVarianceAfter:after.variance,reductionPercent:100*(1-after.variance/before.variance),maxTimestampErrorSeconds:maxTimestampError,
    audioSamples:actualPcm.length/4,audioSha256:sha(actualPcm),audioIdentical:true,originalUnchanged:true,cancellation:cancelResults,progress,
    notes:['Synthetic textured image with a magenta marker and known camera translation; this is not a general real-world quality score.','Output keeps resolution/frame timestamps; H264 CRF16 re-encoding is not lossless. Float32PCM avoids another lossy audio encode.','Static automatic zoom removes exposed edges by reducing visible field of view.']};
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));t.diagnostic(JSON.stringify({...report,progress:undefined}));
});

test('stabilization preserves delayed audio, variable frame timestamps and display geometry',{timeout:120000},async(t)=>{
  const previous=JSON.parse(await fs.readFile(path.join(root,'results.json'),'utf8')) as {source:string};
  const work=await fs.mkdtemp(path.join(root,'timing-'));
  const ctx:StabilizationContext={ffmpeg,ffprobe,cacheDir:path.join(work,'cache'),derivedDir:path.join(work,'derived')};
  const delayed=path.join(work,"source's [지연].mov");
  await ff(['-i',previous.source,'-itsoffset','0.25','-i',previous.source,'-map','0:v:0','-map','1:a:0','-c','copy','-t','4',delayed]);
  const media=await probeMedia(delayed,ctx,undefined,{derivatives:false});
  const output=await stabilizeMedia(media,{start:.137,duration:2.731,crop:'black'},ctx);
  const audio=JSON.parse((await runProcess(ffprobe,['-v','error','-select_streams','a:0','-show_streams','-of','json',output.path])).stdout.toString()).streams[0];
  assert.ok(Math.abs(Number(audio.start_time)-.113)<.001,'Audio was moved to a different source-relative start');
  const expected=(await ff(['-i',delayed,'-map','0:a:0','-af','atrim=start=0.137:end=2.868','-f','f32le','pipe:1'])).stdout;
  const actual=(await ff(['-i',output.path,'-map','0:a:0','-f','f32le','pipe:1'])).stdout;
  assert.equal(actual.length,expected.length);assert.equal(sha(actual),sha(expected));assert.equal(actual.length/4,125664);
  // MOV's default 1ms movie time base rounds delayed audio edit lists. Keep the
  // source delay within one audio sample even for a non-millisecond cut.
  const fractionalStart=.137123,fractional=await stabilizeMedia(media,{start:fractionalStart,duration:1,crop:'black'},ctx);
  const fractionalInfo=JSON.parse((await runProcess(ffprobe,['-v','error','-select_streams','a:0','-show_streams','-of','json',fractional.path])).stdout.toString()).streams[0];
  assert.ok(Math.abs(Number(fractionalInfo.start_time)-(.25-fractionalStart))<=1/48000,'Fractional audio delay exceeds one sample');
  const fractionalPcm=(await ff(['-i',fractional.path,'-map','0:a:0','-f','f32le','pipe:1'])).stdout;
  const originalPcm=(await ff(['-i',delayed,'-map','0:a:0','-f','f32le','pipe:1'])).stdout;
  const fractionalExpected=originalPcm.subarray(0,Math.round((fractionalStart+1-.25)*48000)*4);
  assert.equal(fractionalPcm.length,fractionalExpected.length);assert.equal(sha(fractionalPcm),sha(fractionalExpected));
  const vfr=path.join(work,'variable.mov');
  await ff(['-i',previous.source,'-an','-vf',"select='lt(n,30)+gte(n,30)*not(mod(n,3))'",'-fps_mode','vfr','-enc_time_base:v','filter','-c:v','libx264','-crf','12',vfr]);
  const variable=await probeMedia(vfr,ctx,undefined,{derivatives:false});const stabilized=await stabilizeMedia(variable,{start:.137,duration:2.731},ctx);
  const variableTimes=await timestamps(vfr),held=variableTimes.reduce((last,value,i)=>Math.round(value*1e6)<=137000?i:last,-1),expectedTimes=variableTimes.filter((value,index)=>index>=held&&value<2.868).map(value=>Math.max(0,value-.137)),actualTimes=await timestamps(stabilized.path);
  assert.equal(expectedTimes.length,actualTimes.length);assert.ok(new Set(expectedTimes.slice(1).map((v,i)=>Math.round((v-expectedTimes[i])*1000))).size>1,'Fixture is not variable-rate');
  const vfrError=Math.max(...actualTimes.map((value,i)=>Math.abs(value-expectedTimes[i])));assert.ok(vfrError<.001);
  const sar=path.join(work,'wide-pixels.mov');await ff(['-i',previous.source,'-t','1','-an','-vf','setsar=2','-c:v','libx264','-crf','12',sar]);
  const sarMedia=await probeMedia(sar,ctx,undefined,{derivatives:false}),sarOutput=await stabilizeMedia(sarMedia,{},ctx);
  assert.equal(sarOutput.width,640);assert.equal(sarOutput.height,240);
  const rotation=path.join(work,'portrait.mov');await ff(['-display_rotation:v:0','90','-i',previous.source,'-t','1','-an','-c:v','copy',rotation]);
  const rotated=await probeMedia(rotation,ctx,undefined,{derivatives:false});assert.equal(rotated.width,240,'Fixture must carry a 90-degree display matrix');
  const rotatedOutput=await stabilizeMedia(rotated,{},ctx);
  assert.equal(rotatedOutput.width,240);assert.equal(rotatedOutput.height,320);
  const hdr=path.join(work,'hdr.mov');await ff(['-i',previous.source,'-t','1','-an','-c:v','libx264','-x264-params','colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',hdr]);
  await assert.rejects(stabilizeMedia(await probeMedia(hdr,ctx,undefined,{derivatives:false}),{},ctx),/SDR|HDR/);
  const report={delayedAudioStart:Number(audio.start_time),delayedAudioSamples:actual.length/4,delayedAudioIdentical:true,fractionalAudioStart:Number(fractionalInfo.start_time),fractionalAudioExpected:.25-fractionalStart,fractionalAudioSamples:fractionalPcm.length/4,vfrFrames:actualTimes.length,vfrMaxTimestampError:vfrError,sarDimensions:[sarOutput.width,sarOutput.height],rotationDimensions:[rotatedOutput.width,rotatedOutput.height],hdrRejected:true};
  await fs.writeFile(path.join(root,'timing-results.json'),JSON.stringify(report,null,2));t.diagnostic(JSON.stringify(report));
});
