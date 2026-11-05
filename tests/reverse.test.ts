import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs,utimesSync,existsSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {probeMedia,runProcess,detectEncoders} from '../electron/media';
import {reverseMedia,normalizeReverseOptions,type ReverseContext} from '../electron/reverse';
import {reversePcmFile,spoolReverseFrames} from '../electron/reverse-frames';
import {prepareClockFixtures} from './fixtures/media-clock';
import {prepareColorFixtures,colorReference,patchSamples} from './fixtures/color-range';
import type {MediaAsset} from '../shared/types';

const root=path.resolve('.test-artifacts/reverse'),ctx:ReverseContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),derivedDir:path.join(root,'derived'),reverseEncoder:'cpu',reverseBufferBytes:160*90*1.5*3};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:120000,maxOutputBytes:32*1024*1024});
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const fingerprint=async()=>({version:JSON.parse(await fs.readFile('package.json','utf8')).version,sourceHashes:Object.fromEntries(await Promise.all(['electron/reverse.ts','electron/reverse-frames.ts','electron/media.ts','electron/video-color.ts','electron/media-timing.ts','tests/reverse.test.ts'].map(async file=>[file,hash(await fs.readFile(file))])))});
const probe=async(file:string,extra:string[])=>JSON.parse((await runProcess(ctx.ffprobe,['-v','error',...extra,'-of','json',file])).stdout.toString());
const info=(file:string)=>probe(file,['-show_streams','-show_format']);
const frames=async(file:string,type='v:0')=>(await probe(file,['-select_streams',type,'-show_frames','-show_entries','frame=best_effort_timestamp,best_effort_timestamp_time,duration_time'])).frames as Array<{best_effort_timestamp:number;best_effort_timestamp_time:string;duration_time?:string}>;
const pcm=async(file:string,index:number)=>(await ff(['-i',file,'-map',`0:${index}`,'-vn','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
const codes=async(file:string)=>{const raw=(await ff(['-i',file,'-map','0:v:0','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;return Array.from({length:raw.length/(160*90*3)},(_,f)=>{let code=0;for(let bit=0;bit<8;bit++){const at=(f*160*90+5*160+bit*20+10)*3;if((raw[at]+raw[at+1]+raw[at+2])/3>128)code|=1<<bit;}return code;});};
const reports:unknown[]=[],assets:Record<string,MediaAsset>={};
before(async()=>{
  await fs.mkdir(root,{recursive:true});Object.assign(assets,(await prepareClockFixtures(root,ctx)).assets);
  const add=async(name:string,extension:string,args:string[])=>{const file=path.join(root,`${name}.${extension}`);await ff([...args,file]);assets[name]=await probeMedia(file,ctx,undefined,{derivatives:false});};
  await add('slow','mp4',['-i',assets.base.path,'-an','-vf',"select='not(mod(n,10))',setpts=N*2/TB",'-fps_mode','vfr','-enc_time_base:v','filter','-c:v','libx264','-crf','8','-bf','3','-g','120']);
  await add('vfr','mkv',['-i',assets.base.path,'-vf',"select='lt(n,10)+gte(n,10)*not(mod(n,2))'",'-fps_mode','vfr','-enc_time_base:v','filter','-c:v','libx264','-crf','8','-c:a','copy']);
  await add('hours','mov',['-itsoffset','10002','-i',assets.base.path,'-map','0','-c','copy','-avoid_negative_ts','disabled','-movie_timescale','1000000']);
  await add('delayed','mov',['-i',assets.base.path,'-itsoffset','0.250123','-i',assets.base.path,'-map','0:v:0','-map','1:a:0','-c','copy','-movie_timescale','1000000']);
  await add('short-audio','mov',['-i',assets.base.path,'-map','0:v:0','-map','0:a:0','-c:v','copy','-af','atrim=duration=0.5','-c:a','pcm_f32le']);
  await add('multi','mov',['-i',assets.base.path,'-i',assets.mp4.path,'-map','0:a:0','-map','1:a:0','-c:a','pcm_f32le']);
});

test('Reverse validation rejects invalid selections and unsupported video without publishing',{timeout:60000},async()=>{
  for(const options of [{start:-1},{duration:0},{start:4},{start:3,duration:2},{start:NaN},{duration:Infinity}])assert.throws(()=>normalizeReverseOptions(options,4));
  assert.deepEqual(normalizeReverseOptions({start:1},4),{start:1,duration:3});
  const file=path.join(root,'alpha.mov');await ff(['-f','lavfi','-i','color=red@0.5:size=32x32:rate=1:duration=1,format=rgba','-c:v','qtrle',file]);
  const media=await probeMedia(file,ctx,undefined,{derivatives:false});await assert.rejects(reverseMedia(media,{},ctx),/투명/);
});

test('PCM reversal preserves channel frames across block boundaries, silence padding and cancellation',{timeout:30000},async()=>{
  for(const channels of [1,2,6]){
    const count=150013,stride=channels*4,data=Buffer.alloc(count*stride);for(let i=0;i<count;i++)for(let c=0;c<channels;c++)data.writeFloatLE(i*channels+c+.25,(i*channels+c)*4);
    const input=path.join(root,`pcm-${channels}.f32`),output=path.join(root,`pcm-${channels}-${Date.now()}.f32`);await fs.writeFile(input,data);
    assert.equal(await reversePcmFile(input,output,channels,undefined,undefined,{before:3,after:7}),count+10);const actual=await fs.readFile(output),expected=Buffer.alloc((count+10)*stride);
    for(let i=0;i<count;i++)data.copy(expected,(7+i)*stride,(count-i-1)*stride,(count-i)*stride);assert.equal(hash(actual),hash(expected));
    await assert.rejects(reversePcmFile(input,output,channels),{code:'EEXIST'});assert.equal(hash(await fs.readFile(output)),hash(expected));
    const control=new AbortController();await assert.rejects(reversePcmFile(input,output+'.cancel',channels,control.signal,()=>control.abort()),{name:'AbortError'});
    const pre=new AbortController();pre.abort();await assert.rejects(reversePcmFile(input,output+'.preabort',channels,pre.signal),{name:'AbortError'});await assert.rejects(fs.stat(output+'.preabort'),{code:'ENOENT'});
  }
  const empty=path.join(root,'empty.f32'),out=path.join(root,`empty-${Date.now()}.f32`);await fs.writeFile(empty,'');assert.equal(await reversePcmFile(empty,out,2,undefined,undefined,{before:2,after:4}),6);assert.equal(hash(await fs.readFile(out)),hash(Buffer.alloc(48)));
});

async function checkAudio(media:MediaAsset,output:MediaAsset,start:number,duration:number){
  const sourceInfo=await info(media.path),outputInfo=await info(output.path),sources=sourceInfo.streams.filter((s:any)=>s.codec_type==='audio'),destinations=outputInfo.streams.filter((s:any)=>s.codec_type==='audio');assert.equal(destinations.length,sources.length);const result=[];
  for(let a=0;a<sources.length;a++){
    const stream=sources[a],rate=Number(stream.sample_rate),channels=stream.channels,stride=channels*4,decoded=await pcm(media.path,stream.index),first=(await frames(media.path,`a:${a}`))[0],tb=stream.time_base.split('/').map(Number),firstSample=Math.round(first.best_effort_timestamp*tb[0]*rate/tb[1]),at=Math.round((media.timing!.origin+start)*1e6),until=Math.round((media.timing!.origin+start+duration)*1e6),from=Math.round(at*rate/1e6-firstSample),to=Math.round(until*rate/1e6-firstSample),expected=Buffer.alloc((to-from)*stride);
    // Independent oracle: iterate output samples, mapping each back to the full
    // continuously decoded source. Out-of-source intervals are exactly silent.
    for(let out=0;out<to-from;out++){const src=to-1-out;if(src>=0&&src<decoded.length/stride)decoded.copy(expected,out*stride,src*stride,(src+1)*stride);}
    const actual=await pcm(output.path,destinations[a].index);assert.equal(actual.length,expected.length,`${media.name} audio${a} length`);assert.equal(hash(actual),hash(expected),`${media.name} audio${a} sample/channel identity`);assert.equal(Number(destinations[a].sample_rate),rate);assert.equal(destinations[a].channels,channels);result.push({rate,channels,frames:actual.length/stride,sha256:hash(actual)});
  }return result;
}

test('Reverse preserves every VFR/B-frame interval and exact full-decode audio across small chunks',{timeout:180000},async()=>{
  const cases=[...['base','shifted','mp4','mp4-shifted','vfr','hours','delayed','short-audio'].map(name=>({name,media:assets[name],start:.137123,duration:1.231})),{name:'slow',media:assets.slow,start:2.137,duration:3.731},...['mp4','mp4-shifted'].map(name=>({name:name+'-seek',media:assets[name],start:2.137,duration:1.231})),{name:'silent-cut',media:assets['short-audio'],start:2.137,duration:1.231},{name:'before-audio',media:assets.delayed,start:.01,duration:.1}];
  for(const {name,media,start,duration}of cases){
    const sourceHash=hash(await fs.readFile(media.path)),sourceFrames=await frames(media.path),pts=sourceFrames.map(f=>Math.round(Number(f.best_effort_timestamp_time)*1e6)),originalCodes=await codes(media.path),at=Math.round((media.timing!.origin+start)*1e6),until=Math.round((media.timing!.origin+start+duration)*1e6),first=pts.reduce((last,t,i)=>t<=at?i:last,-1),indices=pts.flatMap((p,i)=>i>=Math.max(0,first)&&p<until?[i]:[]).reverse(),expectedTimes=indices.map(i=>until-Math.min(until,pts[i+1]??until)),expectedCodes=indices.map(i=>originalCodes[i]),diagnostics:Record<string,unknown>[]=[];
    const output=await reverseMedia(media,{start,duration},{...ctx,diagnostics:e=>diagnostics.push(e)}),actualFrames=await frames(output.path),actualTimes=actualFrames.map(f=>Math.round(Number(f.best_effort_timestamp_time)*1e6)),actualCodes=await codes(output.path);
    assert.deepEqual(actualCodes,expectedCodes,name+' reversed frame identity');assert.deepEqual(actualTimes,expectedTimes,name+' reversed display intervals');assert.ok(Math.abs(output.duration-duration)<.00003,name+' total duration');assert.equal(Math.round(Number(actualFrames.at(-1)!.duration_time)*1e6),until-at-expectedTimes.at(-1)!,name+' last frame duration');assert.equal(hash(await fs.readFile(media.path)),sourceHash,name+' source untouched');assert.ok(diagnostics.some(e=>e.event==='reverse-plan'&&Number(e.framesPerChunk)<=3));
    const audio=await checkAudio(media,output,start,duration);reports.push({name,media,output,start,duration,expectedTimes,expectedCodes,audio});
  }
  for(const name of ['mp3','m4a','opus','multi']){const media=assets[name],start=.137123,duration=1.231,output=await reverseMedia(media,{start,duration},ctx);assert.equal(output.kind,'audio');const audio=await checkAudio(media,output,start,duration);reports.push({name,media,output,start,duration,audio});}
  await fs.writeFile(path.join(root,'fixtures.json'),JSON.stringify({version:JSON.parse(await fs.readFile('package.json','utf8')).version,clock:reports},null,2));
});

test('Reverse cancellation and source replacement leave no output, work directory or owned process',{timeout:120000},async()=>{
  for(const phase of ['frames','video','audio-clock','audio-decode','pcm','mux']){
    const derivedDir=await fs.mkdtemp(path.join(root,'cancel-')),control=new AbortController(),pids:number[]=[];let triggered=false;
    await assert.rejects(reverseMedia(assets.base,{start:.137,duration:1.231},{...ctx,derivedDir,diagnostics:e=>{if(e.event==='reverse-process'&&typeof e.pid==='number')pids.push(e.pid);if(e.phase===phase){triggered=true;control.abort();}}},(_p,message)=>{if(phase==='pcm'&&message==='역재생 오디오 생성 중'){triggered=true;control.abort();}},control.signal),{name:'AbortError'});assert.ok(triggered,phase);assert.deepEqual(await fs.readdir(derivedDir),[],phase+' cleanup');for(const pid of pids)assert.throws(()=>process.kill(pid,0),phase+' process terminated');
  }
  const clone=path.join(root,'replace.mkv');await fs.copyFile(assets.base.path,clone);const media=await probeMedia(clone,ctx,undefined,{derivatives:false}),derivedDir=await fs.mkdtemp(path.join(root,'replace-'));let changed=false;
  await assert.rejects(reverseMedia(media,{duration:1},{...ctx,derivedDir,diagnostics:e=>{if(e.event==='reverse-encoded'&&!changed){changed=true;utimesSync(clone,new Date(),new Date(Date.now()+10000));}}}),/변경/);assert.ok(changed);assert.deepEqual(await fs.readdir(derivedDir),[]);
  await assert.rejects(spoolReverseFrames(assets.base.path,0,0,0,1000000,path.join(root,'bad-spawn.bin'),{...ctx,ffprobe:path.join(root,'not-a-program.exe')}),/ENOENT/);
});

test('Reverse retains native SDR colors and uses NVENC when available',{timeout:180000},async t=>{
  const colors=await prepareColorFixtures(path.join(root,'colors'),ctx),colorReports=[];
  for(const row of colors){const expected=(await colorReference(row,ctx)).map(p=>p.rgb),output=await reverseMedia(row.media,{duration:.8},ctx),stream=(await info(output.path)).streams.find((s:any)=>s.codec_type==='video'),raw=(await ff(['-i',output.path,'-frames:v','1','-vf','scale=flags=bilinear+full_chroma_int+accurate_rnd','-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout,actual=patchSamples(raw,row.spec.width,row.spec.height);for(let i=0;i<actual.length;i++)for(let c=0;c<3;c++)assert.ok(Math.abs(actual[i][c]-expected[i][c])<=2,`${row.spec.name} patch${i} channel${c}: ${actual[i][c]} vs ${expected[i][c]}`);assert.equal(stream.color_range,row.spec.previewRange);assert.equal(stream.color_space,row.spec.matrix==='bt601'?'smpte170m':'bt709');colorReports.push({name:row.spec.name,media:row.media,output,expected,actual,width:row.project.width,height:row.project.height});}
  const gpu=(await detectEncoders(ctx)).includes('h264_nvenc');let gpuReport;
  if(gpu){const diagnostics:Record<string,unknown>[]=[],media=assets.vfr,start=.137123,duration=1.231,output=await reverseMedia(media,{start,duration},{...ctx,reverseEncoder:'auto',diagnostics:e=>diagnostics.push(e)});assert.ok(diagnostics.some(e=>e.event==='reverse-encoded'&&e.encoder==='h264_nvenc'));assert.ok(!diagnostics.some(e=>e.event==='reverse-encoder-fallback'));const cpu=reports.find((r:any)=>r.name==='vfr') as any;assert.deepEqual(await codes(output.path),cpu.expectedCodes);assert.deepEqual((await frames(output.path)).map(f=>Math.round(Number(f.best_effort_timestamp_time)*1e6)),cpu.expectedTimes);await checkAudio(media,output,start,duration);gpuReport={media,output,diagnostics};}else t.diagnostic('NVENC unavailable: CPU fidelity tested; GPU path not verified on this host.');
  const evidence=JSON.parse(await fs.readFile(path.join(root,'fixtures.json'),'utf8'));await fs.writeFile(path.join(root,'fixtures.json'),JSON.stringify({...evidence,colors:colorReports,gpu:gpuReport??null},null,2));
});

test('A failed later NVENC chunk restarts every chunk on CPU without mixed output or surviving children',{timeout:120000},async t=>{
  if(!(await detectEncoders(ctx)).includes('h264_nvenc')){t.skip('NVENC hardware unavailable');return;}
  const diagnostics:Record<string,unknown>[]=[],pids:number[]=[],media=assets.vfr,start=.137123,duration=1.231,derivedDir=await fs.mkdtemp(path.join(root,'fallback-'));let videoProcesses=0,injected=false,firstPartExisted=false;
  const output=await reverseMedia(media,{start,duration},{...ctx,derivedDir,reverseEncoder:'auto',reverseDecoder:'cpu',diagnostics:e=>{diagnostics.push(e);if(e.event==='reverse-process'&&typeof e.pid==='number')pids.push(e.pid);if(e.phase==='video'&&++videoProcesses===2){const work=readdirSync(derivedDir).find(n=>n.startsWith('.reverse-'));firstPartExisted=!!work&&existsSync(path.join(derivedDir,work,'video-00000000.mov'));injected=true;process.kill(e.pid as number);}}});
  // A second video process can only start after the preceding encoded chunk
  // completed and was appended to the manifest. The fallback must overwrite it.
  assert.ok(injected&&firstPartExisted);assert.ok(diagnostics.some(e=>e.event==='reverse-encoder-fallback'));assert.ok(diagnostics.some(e=>e.event==='reverse-encoded'&&e.encoder==='libx264'));assert.ok(!diagnostics.some(e=>e.event==='reverse-encoded'&&e.encoder==='h264_nvenc'));
  const reference=reports.find((r:any)=>r.name==='vfr') as any;assert.deepEqual(await codes(output.path),reference.expectedCodes);assert.deepEqual((await frames(output.path)).map(f=>Math.round(Number(f.best_effort_timestamp_time)*1e6)),reference.expectedTimes);await checkAudio(media,output,start,duration);
  assert.deepEqual(await fs.readdir(derivedDir),[path.basename(output.path)]);for(const pid of pids)assert.throws(()=>process.kill(pid,0));
  await fs.writeFile(path.join(root,'fallback.json'),JSON.stringify({passed:true,injectedAfterCompletedChunk:firstPartExisted,diagnostics,output},null,2));
  const files=['electron/reverse.ts','electron/reverse-frames.ts','electron/media.ts','electron/media-timing.ts','electron/video-color.ts','tests/reverse.test.ts'],sourceHashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await fs.readFile(file))]))),evidence=JSON.parse(await fs.readFile(path.join(root,'fixtures.json'),'utf8'));await fs.writeFile(path.join(root,'fixtures.json'),JSON.stringify({...evidence,sourceHashes},null,2));
});

test('CUDA timestamp scan and reverse retain all clock cases, native colors and more frames than the decoder surface pool',{timeout:180000},async t=>{
  if(!(await detectEncoders(ctx)).includes('h264_nvenc')){t.skip('NVENC hardware unavailable');return;}
  const evidence=JSON.parse(await fs.readFile(path.join(root,'fixtures.json'),'utf8')),clock=[],colors=[];
  const gpu=(events:Record<string,unknown>[],budget:number|undefined=512*96*1.5*3):ReverseContext=>({...ctx,reverseEncoder:'auto',reverseBufferBytes:budget,diagnostics:e=>events.push(e)});
  const requireCuda=(events:Record<string,unknown>[])=>{assert.ok(events.some(e=>e.event==='reverse-process'&&e.phase==='frames'&&e.decoder==='cuda'));assert.ok(events.some(e=>e.event==='reverse-encoded'&&e.encoder==='h264_nvenc'&&e.decoder==='cuda'),JSON.stringify(events.filter(e=>String(e.event).includes('fallback'))));assert.ok(!events.some(e=>String(e.event).includes('fallback')),JSON.stringify(events.filter(e=>String(e.event).includes('fallback'))));};
  for(const row of evidence.clock.filter((r:any)=>r.media.kind==='video')){
    const diagnostics:Record<string,unknown>[]=[],output=await reverseMedia(row.media,{start:row.start,duration:row.duration},gpu(diagnostics));requireCuda(diagnostics);
    assert.deepEqual(await codes(output.path),row.expectedCodes,row.name+' CUDA frame identity');const actualFrames=await frames(output.path),actualTimes=actualFrames.map(f=>Math.round(Number(f.best_effort_timestamp_time)*1e6));assert.deepEqual(actualTimes,row.expectedTimes,row.name+' CUDA exact PTS');assert.ok(Math.abs(output.duration-row.duration)<.00003);const audio=await checkAudio(row.media,output,row.start,row.duration);clock.push({name:row.name,output,times:actualTimes,audio,diagnostics});
  }
  for(const row of evidence.colors){
    const diagnostics:Record<string,unknown>[]=[],output=await reverseMedia(row.media,{duration:.8},gpu(diagnostics));if(row.name==='vp9-sd-pc'){assert.ok(diagnostics.some(e=>e.event==='reverse-frame-decoder-fallback'));assert.ok(diagnostics.some(e=>e.event==='reverse-encoded'&&e.decoder==='cpu'&&e.encoder==='h264_nvenc'));}else requireCuda(diagnostics);
    const stream=(await info(output.path)).streams.find((s:any)=>s.codec_type==='video'),reference=(await info(row.output.path)).streams.find((s:any)=>s.codec_type==='video'),raw=(await ff(['-i',output.path,'-frames:v','1','-vf','scale=flags=bilinear+full_chroma_int+accurate_rnd','-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout,actual=patchSamples(raw,row.media.width,row.media.height);
    for(let i=0;i<actual.length;i++)for(let c=0;c<3;c++)assert.ok(Math.abs(actual[i][c]-row.expected[i][c])<=2,`${row.name} CUDA patch${i} channel${c}: ${actual[i][c]} vs ${row.expected[i][c]}`);for(const key of ['color_range','color_space','color_primaries','color_transfer'])assert.equal(stream[key],reference[key]);colors.push({name:row.name,media:row.media,output,expected:row.expected,actual,diagnostics});
  }
  const diagnostics:Record<string,unknown>[]=[],pool=await reverseMedia(assets.base,{start:.037,duration:3.8},{...gpu(diagnostics),reverseBufferBytes:undefined});requireCuda(diagnostics);const expected=Array.from({length:39},(_,i)=>38-i);assert.deepEqual(await codes(pool.path),expected);assert.equal(diagnostics.find(e=>e.event==='reverse-encoded')?.parts,1);assert.ok(Number(diagnostics.find(e=>e.event==='reverse-plan')?.frames)>32);await checkAudio(assets.base,pool,.037,3.8);
  const sourceHashes=Object.fromEntries(await Promise.all(['electron/reverse.ts','electron/reverse-frames.ts','electron/media.ts','electron/video-color.ts','electron/media-timing.ts','tests/reverse.test.ts'].map(async file=>[file,hash(await fs.readFile(file))])));
  await fs.writeFile(path.join(root,'gpu.json'),JSON.stringify({version:JSON.parse(await fs.readFile('package.json','utf8')).version,passed:true,clock,colors,pool:{output:pool,frames:expected.length,diagnostics},sourceHashes},null,2));
});

test('CUDA scan/chunk failures restart on CPU decode and active CUDA cancellation cleans every owned process',{timeout:120000},async t=>{
  if(!(await detectEncoders(ctx)).includes('h264_nvenc')){t.skip('NVENC hardware unavailable');return;}
  const details=[],media=assets.vfr,start=.137123,duration=1.231,reference=reports.find((r:any)=>r.name==='vfr') as any;
  for(const phase of ['frames','video']){
    const derivedDir=await fs.mkdtemp(path.join(root,'cuda-fallback-')),diagnostics:Record<string,unknown>[]=[],pids:number[]=[];let injected=false,videos=0;
    const output=await reverseMedia(media,{start,duration},{...ctx,reverseEncoder:'auto',reverseBufferBytes:512*96*1.5*3,derivedDir,diagnostics:e=>{diagnostics.push(e);if(e.event==='reverse-process'&&typeof e.pid==='number')pids.push(e.pid);if(!injected&&e.phase===phase&&(phase==='frames'?e.decoder==='cuda':++videos===2)){injected=true;process.kill(e.pid as number);}}});
    assert.ok(injected);assert.ok(diagnostics.some(e=>e.event===(phase==='frames'?'reverse-frame-decoder-fallback':'reverse-decoder-fallback')));assert.ok(diagnostics.some(e=>e.event==='reverse-encoded'&&e.decoder==='cpu'&&e.encoder==='h264_nvenc'));assert.deepEqual(await codes(output.path),reference.expectedCodes);assert.deepEqual((await frames(output.path)).map(f=>Math.round(Number(f.best_effort_timestamp_time)*1e6)),reference.expectedTimes);await checkAudio(media,output,start,duration);assert.deepEqual(await fs.readdir(derivedDir),[path.basename(output.path)]);for(const pid of pids)assert.throws(()=>process.kill(pid,0));details.push({phase,output,diagnostics});
    const cancelDir=await fs.mkdtemp(path.join(root,'cuda-cancel-')),control=new AbortController(),owned:number[]=[];let aborted=false;
    await assert.rejects(reverseMedia(media,{start,duration},{...ctx,reverseEncoder:'auto',derivedDir:cancelDir,diagnostics:e=>{if(e.event==='reverse-process'&&typeof e.pid==='number')owned.push(e.pid);if(e.phase===phase){aborted=true;control.abort();}}},undefined,control.signal),{name:'AbortError'});assert.ok(aborted);assert.deepEqual(await fs.readdir(cancelDir),[]);for(const pid of owned)assert.throws(()=>process.kill(pid,0));
  }
  await fs.writeFile(path.join(root,'gpu-fallback.json'),JSON.stringify({...await fingerprint(),passed:true,details},null,2));
});

test('Native CUDA reverse supports eligible VP9, HEVC and AV1 without losing frame, color or audio identity',{timeout:120000},async t=>{
  const encoders=await detectEncoders(ctx);if(!encoders.includes('h264_nvenc')){t.skip('NVIDIA hardware unavailable');return;}
  const details=[];
  for(const codec of ['libvpx-vp9','hevc_nvenc','av1_nvenc']){
    if(codec!=='libvpx-vp9'&&!encoders.includes(codec)){t.diagnostic(codec+' source encoder unavailable');continue;}
    const file=path.join(root,`cuda-${codec}.mkv`);await ff(['-i',assets.base.path,'-vf','scale=320:180:flags=neighbor','-c:v',codec,...(codec==='libvpx-vp9'?['-lossless','1','-cpu-used','5']:['-preset','p3','-rc','constqp','-qp','16']),'-c:a','copy',file]);
    const media=await probeMedia(file,ctx,undefined,{derivatives:false}),start=.137123,duration=1.231,pts=(await frames(file)).map(f=>Number(f.best_effort_timestamp_time)),first=pts.reduce((n,time,i)=>time<=start?i:n,0),indices=pts.flatMap((time,i)=>i>=first&&time<start+duration?[i]:[]).reverse(),diagnostics:Record<string,unknown>[]=[];
    const frameCodes=async(input:string)=>{const raw=(await ff(['-i',input,'-vf','scale=160:90:flags=neighbor','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;return Array.from({length:raw.length/(160*90*3)},(_,frame)=>{let code=0;for(let bit=0;bit<8;bit++)if(raw[(frame*160*90+5*160+bit*20+10)*3]>128)code|=1<<bit;return code;});};
    const sourceCodes=await frameCodes(file),output=await reverseMedia(media,{start,duration},{...ctx,reverseEncoder:'auto',reverseBufferBytes:512*192*1.5*3,diagnostics:e=>diagnostics.push(e)});assert.ok(diagnostics.some(e=>e.event==='reverse-encoded'&&e.decoder==='cuda'),JSON.stringify(diagnostics.filter(e=>String(e.event).includes('fallback'))));assert.ok(!diagnostics.some(e=>String(e.event).includes('fallback')));assert.deepEqual(await frameCodes(output.path),indices.map(i=>sourceCodes[i]));await checkAudio(media,output,start,duration);details.push({codec,media,output,diagnostics});
  }
  const source=JSON.parse(await fs.readFile(path.join(root,'fixtures.json'),'utf8')).colors.find((r:any)=>r.name==='vp9-sd-pc'),file=path.join(root,'cuda-vp9-full-range.webm');await ff(['-i',source.media.path,'-vf','scale=320:180:flags=neighbor:in_range=pc:out_range=pc','-c:v','libvpx-vp9','-lossless','1','-cpu-used','5','-colorspace','bt709','-color_range','pc',file]);const media=await probeMedia(file,ctx,undefined,{derivatives:false}),diagnostics:Record<string,unknown>[]=[],output=await reverseMedia(media,{duration:.8},{...ctx,reverseEncoder:'auto',diagnostics:e=>diagnostics.push(e)});assert.ok(diagnostics.some(e=>e.event==='reverse-encoded'&&e.decoder==='cuda'));const raw=(await ff(['-i',output.path,'-frames:v','1','-vf','scale=flags=bilinear+full_chroma_int+accurate_rnd','-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout,actual=patchSamples(raw,320,180);for(let i=0;i<actual.length;i++)for(let c=0;c<3;c++)assert.ok(Math.abs(actual[i][c]-source.expected[i][c])<=2);details.push({codec:'vp9-full-range',media,output,diagnostics});
  await fs.writeFile(path.join(root,'gpu-codecs.json'),JSON.stringify({...await fingerprint(),passed:true,details},null,2));
});

test('Rotation and non-square pixels preserve displayed geometry through the CPU decoder path',{timeout:90000},async()=>{
  const source=path.join(root,'geometry-source.mp4'),details=[];
  await ff(['-f','lavfi','-i','color=red:size=320x192:rate=5:duration=1,drawbox=x=160:y=0:w=160:h=96:color=blue:t=fill,drawbox=x=0:y=96:w=160:h=96:color=green:t=fill,drawbox=x=160:y=96:w=160:h=96:color=white:t=fill','-f','lavfi','-i','sine=frequency=733:sample_rate=48000:duration=1','-vf','scale=out_color_matrix=bt709:out_range=tv,setparams=range=limited:colorspace=bt709:color_primaries=bt709:color_trc=bt709','-c:v','libx264','-crf','0','-colorspace','bt709','-color_range','tv','-color_primaries','bt709','-color_trc','bt709','-c:a','aac',source]);
  for(const [name,width,height]of [['rotate',192,320],['wide',640,192],['tall',320,384]] as const){
    const file=path.join(root,`geometry-${name}.mp4`);await ff([...(name==='rotate'?['-display_rotation:v:0','90']:[]),'-i',source,...(name==='rotate'?['-c','copy']:['-vf',`setsar=${name==='wide'?'2':'1/2'}`,'-c:v','libx264','-crf','0','-c:a','copy']),file]);
    const inputStream=(await info(file)).streams.find((s:any)=>s.codec_type==='video');if(name==='rotate')assert.ok(inputStream.side_data_list?.some((s:any)=>s.rotation===90));else assert.equal(inputStream.sample_aspect_ratio,name==='wide'?'2:1':'1:2');
    for(const key of ['color_space','color_primaries','color_transfer'])assert.equal(inputStream[key],'bt709');assert.equal(inputStream.color_range,'tv');
    const media=await probeMedia(file,ctx,undefined,{derivatives:false}),diagnostics:Record<string,unknown>[]=[],output=await reverseMedia(media,{duration:.8},{...ctx,reverseEncoder:'auto',diagnostics:e=>diagnostics.push(e)}),stream=(await info(output.path)).streams.find((s:any)=>s.codec_type==='video');
    assert.equal(stream.width,width);assert.equal(stream.height,height);assert.equal(stream.sample_aspect_ratio,'1:1');assert.ok(!stream.side_data_list?.some((s:any)=>s.rotation));assert.ok(diagnostics.some(e=>e.event==='reverse-encoded'&&e.decoder==='cpu'));assert.ok(!diagnostics.some(e=>String(e.event).includes('fallback')));
    const reference=(await ff(['-i',file,'-frames:v','1','-vf',`scale=${width}:${height}:flags=lanczos`,'-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout,actual=(await ff(['-i',output.path,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;
    assert.equal(actual.length,reference.length);let maximum=0;for(const y of [.25,.75])for(const x of [.25,.75]){const at=(Math.floor(height*y)*width+Math.floor(width*x))*3;for(let c=0;c<3;c++)maximum=Math.max(maximum,Math.abs(actual[at+c]-reference[at+c]));}assert.ok(maximum<=3,`${name}: geometry/color differs by ${maximum}`);await checkAudio(media,output,0,.8);details.push({name,width,height,maximum,media,output,diagnostics});
  }
  await fs.writeFile(path.join(root,'geometry.json'),JSON.stringify({...await fingerprint(),passed:true,details},null,2));
});
