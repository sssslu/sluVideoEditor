import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {defaultEQ,assertAudioEQ,bandCoefficients,eqResponse,AudioEQProcessor,patchAudioEQs,eqFFmpegFilters} from '../shared/audio-eq';
import {newClip,newProject,splitClip} from '../shared/project';
import {assertProject} from '../shared/validation';
import {readProject,serializeProject} from '../electron/project-store';
import {TimelineAudioMixer} from '../electron/render-audio';
import {probeMedia,runProcess,renderProject,renderProjectDirect} from '../electron/media';
import type {Clip,EQKind} from '../shared/types';

const root=path.resolve('.test-artifacts/audio-eq'),rate=48000;
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),audioStretch:path.resolve('resources/bin/slu-audio-stretch.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y',...args]);
const single=(type:EQKind,frequency=1000,gain=6,q=1)=>{const eq=defaultEQ();eq.bands.forEach(b=>b.enabled=false);eq.bands[2]={type,frequency,gain,q,enabled:true};return eq;};
test('EQ coefficient response has analytic peak/pass/shelf endpoints and boost/cut symmetry',()=>{
  assert.equal(eqResponse(defaultEQ(),1000),0);
  for(const sr of [8000,44100,48000,96000,192000]){
    for(const gain of [-18,-6,6,18]){const eq=single('peaking',1000,gain,.7);assert.ok(Math.abs(eqResponse(eq,1000,sr)-gain)<1e-8);for(const f of [20,80,437,1000,3000])assert.ok(Math.abs(eqResponse(eq,f,sr)+eqResponse(single('peaking',1000,-gain,.7),f,sr))<1e-8);}
    for(const type of ['highpass','lowpass'] as const)assert.ok(Math.abs(eqResponse(single(type,1000,0,Math.SQRT1_2),1000,sr)+3.01029995664)<1e-8);
    for(const type of ['lowshelf','highshelf'] as const){const eq=single(type);assert.ok(Math.abs(eqResponse(eq,type==='lowshelf'?0:sr/2,sr)-6)<1e-8);assert.ok(Math.abs(eqResponse(eq,type==='lowshelf'?sr/2:0,sr))<1e-8);}
  }
});
test('EQ remains stable at extreme frequency/Q/gain/sample-rate combinations',()=>{
  for(const sr of [8000,44100,48000,192000])for(const type of ['highpass','lowpass','peaking','lowshelf','highshelf'] as const)for(const frequency of [20,20000])for(const q of [.1,10])for(const gain of [-18,18]){
    const eq=single(type,frequency,gain,q),c=bandCoefficients(eq.bands[2],sr)!;
    assert.ok(c.b.concat(c.a).every(Number.isFinite));assert.ok(Math.abs(c.a[2])<1&&1+c.a[1]+c.a[2]>0&&1-c.a[1]+c.a[2]>0,JSON.stringify({sr,type,frequency,q,gain,c}));
    const samples=new Float32Array(8192);samples[0]=1;new AudioEQProcessor(eq,sr,1).process(samples);assert.ok(samples.every(n=>Number.isFinite(n)&&Math.abs(n)<20));
  }
});
test('Stereo DSP retains independent state and byte-identical output across arbitrary PCM block boundaries',()=>{
  const eq=single('peaking',437,12,6),input=new Float32Array(48000*2);for(let i=0;i<48000;i++)input[2*i]=.2*Math.sin(i*2*Math.PI*437/rate);
  const whole=input.slice(),parts=input.slice();new AudioEQProcessor(eq).process(whole);const processor=new AudioEQProcessor(eq);for(let i=0;i<parts.length;i+=1994)processor.process(parts.subarray(i,i+1994));assert.deepEqual(parts,whole);assert.ok(whole.every((n,i)=>i%2===0||n===0));
  const bypass=input.slice();new AudioEQProcessor({...eq,enabled:false}).process(bypass);assert.deepEqual(bypass,input);const flat=input.slice();new AudioEQProcessor(defaultEQ()).process(flat);assert.deepEqual(flat,input);
});
test('EQ validation rejects malformed/old-format data and edits skip locked/text/image clips',async()=>{
  const valid=defaultEQ();for(const invalid of [null,{}, {...valid,enabled:1},{...valid,output:Infinity},{...valid,bands:[]},...['frequency','gain','q'].map(k=>({...valid,bands:valid.bands.map((b,i)=>i?b:{...b,[k]:NaN})}))])assert.throws(()=>assertAudioEQ(invalid));
  const p=newProject(),m={id:'audio',path:'test.wav',name:'audio',kind:'audio' as const,duration:4,width:0,height:0,fps:0,hasAudio:true};p.media=[m,{...m,id:'image',kind:'image',hasAudio:false}];p.tracks.push({...p.tracks[1],id:'locked',locked:true});p.clips=[newClip('audio-1',m),newClip('locked',m),newClip('text-1'),newClip('video-1',p.media[1])];
  const changed=patchAudioEQs(p,new Set(p.clips.map(c=>c.id)),()=>single('peaking'));assert.ok(changed.clips[0].audioEQ);assert.ok(changed.clips.slice(1).every(c=>!c.audioEQ));assertProject(changed);assert.throws(()=>assertProject({...changed,version:5}));
  const pieces=splitClip(changed.clips[0],2)!;assert.deepEqual(pieces[0].audioEQ,pieces[1].audioEQ);const split={...changed,clips:[...pieces,...changed.clips.slice(1)]};await fs.mkdir(root,{recursive:true});const file=path.join(root,'eq-roundtrip.sluproj');await fs.writeFile(file,serializeProject(split));assert.deepEqual(await readProject(file),JSON.parse(JSON.stringify(split)));
  await fs.writeFile(file,JSON.stringify({...p,version:5}));assert.equal((await readProject(file)).version,10);assert.ok((await readProject(file)).clips.every(c=>!c.audioEQ));
});
test('Actual FFmpeg biquad output matches shared stereo DSP including startup transient and headroom',{timeout:30000},async t=>{
  await fs.mkdir(root,{recursive:true});let seed=123456789;const raw=new Float32Array(12000*2);for(let i=0;i<raw.length;i++){seed=(Math.imul(seed,1664525)+1013904223)|0;raw[i]=seed/2147483648*.08;}raw[0]=.6;raw[1]=-.3;const input=path.join(root,'noise.f32');await fs.writeFile(input,Buffer.from(raw.buffer));const reports=[];
  const all=defaultEQ();all.bands.forEach((b,i)=>{b.enabled=true;b.gain=i%2?6:-4;});all.output=-3;
  const cases=[...(['highpass','lowpass','peaking','lowshelf','highshelf'] as const).map(type=>({name:type,eq:single(type)})),{name:'six',eq:all},{name:'bypass',eq:{...all,enabled:false}},{name:'flat',eq:defaultEQ()}];
  for(const {name,eq} of cases){const expected=raw.slice();new AudioEQProcessor(eq).process(expected);const filters=eqFFmpegFilters(eq),output=path.join(root,`${name}.f32`);await ff(['-f','f32le','-ar',String(rate),'-ac','2','-i',input,'-af',filters.length?filters.join(','):'anull','-f','f32le',output]);const actual=await fs.readFile(output);assert.equal(actual.length,expected.byteLength);let max=0;for(let i=0;i<expected.length;i++)max=Math.max(max,Math.abs(expected[i]-actual.readFloatLE(i*4)));assert.ok(max<2e-7,`${name}: ${max}`);reports.push({name,max});await fs.writeFile(path.join(root,`${name}-expected.f32`),Buffer.from(expected.buffer));}
  await fs.writeFile(path.join(root,'reference.json'),JSON.stringify({input,rate,frames:12000,cases:cases.map(c=>({...c,expected:path.join(root,`${c.name}-expected.f32`)})),reports},null,2));t.diagnostic(JSON.stringify(reports));
});
test('Actual timeline EQ follows stretch before fades, continuous blocks and partial-range state; WAV export preserves result',{timeout:60000},async t=>{
  await fs.mkdir(root,{recursive:true});const file=path.join(root,'tones.wav');await ff(['-f','lavfi','-i','aevalsrc=0.08*sin(2*PI*437*t)+0.04*sin(2*PI*2500*t)|0.06*sin(2*PI*900*t):s=48000:d=6','-c:a','pcm_f32le',file]);
  const media=await probeMedia(file,ctx,undefined,{derivatives:false}),p=newProject(),clip:Clip={...newClip('audio-1',media),in:.4,duration:3,volume:.8,fadeIn:.2,fadeOut:.4,audioEQ:single('peaking',437,9,2)};p.media=[media];p.clips=[clip];const reports=[];
  const mix=async(project:typeof p,block:number,from=0)=>{const m=new TimelineAudioMixer(project,ctx.ffmpeg,new AbortController().signal,undefined,ctx.audioStretch),parts:Buffer[]=[];try{for(let at=from;at<3*rate;at+=block)parts.push(await m.mix(at,Math.min(block,3*rate-at)));return Buffer.concat(parts);}finally{await m.close();}};
  for(const curve of [false,true]){
    clip.speedCurve=curve?[{position:0,speed:.7},{position:.5,speed:1.3},{position:1,speed:1.8}]:undefined;
    const one=await mix(p,4096),other=await mix(p,997),partial=await mix(p,2003,33333);assert.deepEqual(one,other);assert.deepEqual(partial,one.subarray(33333*8));
    const raw=await mix({...p,clips:[{...clip,audioEQ:undefined,fadeIn:0,fadeOut:0,volume:1}]},4096),expected=new Float32Array(raw.buffer,raw.byteOffset,raw.length/4).slice();new AudioEQProcessor(clip.audioEQ).process(expected);let max=0;
    for(let i=0;i<3*rate;i++){const fade=.8*Math.min(1,i/rate/.2,(3-i/rate)/.4);for(let ch=0;ch<2;ch++)max=Math.max(max,Math.abs(one.readFloatLE(i*8+ch*4)-Math.fround(expected[i*2+ch]*fade)));}assert.ok(max<1e-7);
    reports.push({curve,max,blockDifferences:0,partialDifferences:0,frames:3*rate});
    if(!curve){const output=path.join(root,'eq-export.wav'),direct=path.join(root,'eq-direct.wav'),settings={width:160,height:90,fps:30,format:'wav' as const,codec:'h264' as const,encoder:'cpu' as const,quality:'standard' as const,outputPath:output};await renderProject(p,settings,ctx);await renderProjectDirect(p,{...settings,outputPath:direct},ctx);const actual=(await ff(['-i',output,'-f','f32le','pipe:1'])).stdout;assert.equal(actual.length,one.length);let wavMax=0;for(let i=0;i<one.length;i+=4)wavMax=Math.max(wavMax,Math.abs(actual.readFloatLE(i)-one.readFloatLE(i)));assert.ok(wavMax<2/32768,`WAV error ${wavMax}`);const directPCM=(await ff(['-i',direct,'-f','f32le','pipe:1'])).stdout;assert.equal(directPCM.length,one.length);let directMax=0;for(let i=0;i<one.length;i+=4)directMax=Math.max(directMax,Math.abs(directPCM.readFloatLE(i)-one.readFloatLE(i)));assert.ok(directMax<2/32768,`Direct WAV error ${directMax}`);reports.push({wavMax,directMax});}
  }
  await fs.writeFile(path.join(root,'timeline-results.json'),JSON.stringify(reports,null,2));t.diagnostic(JSON.stringify(reports));
});
