import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,promises as fs} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {build} from 'esbuild';
import {validateBuildReceipt} from './build-receipt.mjs';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function hashFile(file){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}
function inside(directory,file){
  const relative=path.relative(directory,path.resolve(file));
  assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),`Evidence path escapes its directory: ${file}`);
  return path.resolve(file);
}
const requiredChecks=[
  'Native720p three-frame ResNet CPU/DirectML sequences preserve input hashes and PTS, agree in alpha/composites, and reset reproduces fresh outputs',
  'Automatic retry uses the same ResNet model and exact accepted GPU recurrent tensor hashes/shapes, then continues sequentially on CPU',
  'Explicit GPU mode rejects the injected inference failure',
  'Actual precision720p pipeline preserves every canonical BGRA byte, PTS, exact final hold, positive source origin, delayed stereo PCM and native size',
  'Actual precision4K GPU pipeline processes one native frame and preserves every canonical BGRA byte and exact10ms duration',
  'Cancellation after an actual precision frame removes the partial pipeline output',
  'Unexpected precision worker exit rejects the request and closes the owned process',
  'ORT profiles place original model convolution kernels on DirectML, beyond byte adapter or copy operations',
  'All owned workers/decoders/encoders exited, zero BrowserWindows, and parent loaded no native inference binding',
];

// This collector runs no inference. Only the four already-published output
// frames are decoded again, on CPU, to bind their bytes to the saved evidence.
export async function mattingPrecisionEvidence({workspace=process.cwd(),buildReceipt}={}){
  workspace=path.resolve(workspace);
  const currentReceipt=await validateBuildReceipt(workspace);
  if(buildReceipt)assert.equal(currentReceipt.contentId,buildReceipt.contentId);
  const base=path.join(workspace,'.test-artifacts/matting-precision');
  const directory=inside(base,(await fs.readFile(path.join(base,'current.txt'),'utf8')).trim());
  assert.ok(!(await fs.readdir(directory)).includes('failure.json'),'Precision run has a failure record');
  const metadataSha256={};
  for(const name of ['manifest.json','results.json','source-stability.json'])metadataSha256[name]=await hashFile(path.join(directory,name));
  const manifest=await read(path.join(directory,'manifest.json'));
  const result=await read(path.join(directory,'results.json'));
  const stability=await read(path.join(directory,'source-stability.json'));
  assert.equal(path.resolve(manifest.root),directory);
  for(const evidence of [manifest,result])assert.equal(evidence.version,currentReceipt.version);
  for(const evidence of [manifest,result,stability])assert.equal(evidence.buildReceiptId,currentReceipt.contentId);
  assert.deepEqual(stability.changedSources,[]);
  for(const key of ['buildReceiptValidatedBefore','buildReceiptValidatedAfter','hostVerified','modelsVerified','workerVerified','ffmpegVerified','ffprobeVerified','fixtureRawVerified','fixtureSourceVerified'])assert.equal(stability[key],true,`Incomplete precision source stability: ${key}`);
  assert.deepEqual(result.checks,requiredChecks,'All nine precision checks must finish in order');

  const host=path.join(directory,'host.cjs');
  const bundled=await build({
    absWorkingDir:workspace,entryPoints:['scripts/matting-precision-check.ts'],outfile:host,
    bundle:true,write:false,platform:'node',format:'cjs',target:'node22',external:['electron','onnxruntime-node'],metafile:true,
  });
  assert.equal(sha256(bundled.outputFiles[0].contents),manifest.hostSha256,'Precision host differs from current bundled source');
  assert.equal(await hashFile(host),manifest.hostSha256);
  const sourceFiles=[...new Set([
    'scripts/check-matting-precision.mjs','scripts/build-receipt.mjs','electron/matting-model.ts','electron/matting-worker.ts',
    ...Object.values(bundled.metafile.outputs).flatMap(output=>Object.entries(output.inputs).filter(([,input])=>input.bytesInOutput>0).map(([file])=>file)),
  ])].sort();
  assert.deepEqual(Object.keys(manifest.sources).sort(),sourceFiles,'Precision evidence must cover every executed host source');
  for(const file of sourceFiles)assert.equal(await hashFile(inside(workspace,path.join(workspace,file))),manifest.sources[file],`Stale precision source: ${file}`);

  const models={
    cpu:{file:'person-matting-rvm-resnet50.onnx',bytes:107479165,sha256:'25db300fcb6ee27f941a1b52c97856e8d1f13c7f35817f81a612f89af0e8a85c'},
    dml:{file:'person-matting-rvm-resnet50-bgr.onnx',bytes:107483061,sha256:'f95503b9719810647c58a1c5136a9e3b052d3612ae93ee233edc3b56e50a6c32'},
  };
  for(const [backend,expected] of Object.entries(models)){
    const model=manifest.models[backend];
    assert.equal(path.resolve(model.file),path.join(workspace,'resources/models',expected.file));
    assert.equal(model.bytes,expected.bytes);assert.equal(model.sha256,expected.sha256);
    assert.equal((await fs.stat(model.file)).size,model.bytes);assert.equal(await hashFile(model.file),model.sha256);
  }
  assert.equal(result.modelSha256,manifest.models.cpu.sha256);assert.equal(result.gpuModelSha256,manifest.models.dml.sha256);
  assert.equal(manifest.workerPath,path.join(workspace,'dist-electron/matting-worker.cjs'));
  assert.equal(manifest.workerSha256,currentReceipt.outputs['dist-electron/matting-worker.cjs']);
  assert.equal(result.workerSha256,manifest.workerSha256);assert.equal(await hashFile(manifest.workerPath),manifest.workerSha256);
  for(const tool of ['ffmpeg','ffprobe']){
    assert.equal(manifest[tool],path.join(workspace,`resources/bin/${tool}.exe`));
    assert.equal(await hashFile(manifest[tool]),manifest[`${tool}Sha256`]);
  }
  const fixture=manifest.fixture;
  assert.equal(fixture.width,1280);assert.equal(fixture.height,720);assert.equal(fixture.frames,60);
  assert.equal(fixture.decoderHash,manifest.ffmpegSha256);
  assert.equal(path.resolve(fixture.raw),path.join(workspace,'.test-artifacts/matting-fixtures/b5.bgr'));
  assert.equal(path.resolve(fixture.source.file),path.join(workspace,'.build-cache/matting/b5.mp4'));
  assert.equal((await fs.stat(fixture.raw)).size,1280*720*3*60);
  assert.equal((await fs.stat(fixture.source.file)).size,fixture.source.bytes);
  assert.equal(await hashFile(fixture.raw),fixture.rawHash);assert.equal(await hashFile(fixture.source.file),fixture.source.sha256);

  assert.equal(manifest.maximumNativeAttempts,24);
  assert.equal(result.frameRequests,19);assert.equal(result.automaticRetryCount,1);
  assert.equal(result.nativeAttemptUpperBound,result.frameRequests+result.automaticRetryCount);
  assert.ok(result.nativeAttemptUpperBound<=manifest.maximumNativeAttempts);
  assert.deepEqual(result.comparisons.map(row=>row.pts),[3000000,3033333,3066667]);
  for(const [index,row] of result.comparisons.entries()){
    assert.equal(row.index,index);
    for(const key of ['inputSha256','cpuSha256','dmlSha256'])assert.match(row[key],/^[a-f0-9]{64}$/);
    for(const key of ['alphaMean','blackMean','whiteMean'])assert.ok(row[key]>=0&&row[key]<1);
    assert.ok(Number.isInteger(row.alphaMax)&&row.alphaMax>=0&&row.alphaMax<=255);
  }
  assert.deepEqual(result.fallback.beforeFailure,result.fallback.cpuRetry);
  assert.deepEqual(result.fallback.beforeFailure.map(state=>state.dims[1]),[16,32,64,128]);
  for(const state of result.fallback.beforeFailure){
    assert.equal(state.dims.length,4);assert.equal(state.dims[0],1);
    assert.ok(state.dims.every(value=>Number.isSafeInteger(value)&&value>0));
    assert.equal(state.length,state.dims.reduce((total,value)=>total*value,1));assert.match(state.sha256,/^[a-f0-9]{64}$/);
  }

  const profileSha256={};
  assert.equal(result.profiles.length,2);
  for(const profile of result.profiles){
    assert.match(profile.file,/^sequence-(cpu-cpu|dml-dml)_.*\.json$/);
    const file=inside(directory,path.join(directory,profile.file)),events=await read(file);
    const providers={},core={},names=new Set();
    for(const event of events){
      const provider=event.args?.provider;
      if(!provider)continue;
      providers[provider]=(providers[provider]??0)+1;
      if(/Conv/.test(String(event.args?.op_name??''))&&!String(event.name).startsWith('slu_')){
        core[provider]=(core[provider]??0)+1;names.add(String(event.name));
      }
    }
    assert.deepEqual(profile.providers,providers);assert.deepEqual(profile.coreConvolutionEvents,core);
    assert.deepEqual(profile.coreConvolutionNodes,[...names]);assert.ok(names.size>20);
    const provider=profile.file.startsWith('sequence-dml-')?'DmlExecutionProvider':'CPUExecutionProvider';
    assert.deepEqual(Object.keys(core),[provider],'Core model convolutions must run on the requested provider');
    assert.ok(core[provider]>=names.size*4,'Profile must cover the sequence and fresh-state repeat');
    profileSha256[profile.file]=await hashFile(file);
  }
  assert.equal(result.profiles.filter(profile=>profile.coreConvolutionEvents.DmlExecutionProvider>0).length,1);
  assert.equal(result.profiles.filter(profile=>profile.coreConvolutionEvents.CPUExecutionProvider>0).length,1);

  const diagnostics=result.diagnostics;
  const expectedTimings={'sequence-cpu':4,'sequence-dml':4,'auto-fallback':3,'strict-gpu-failure':1,'pipeline-720p':3,'pipeline-4k':1,'pipeline-cancel':1};
  const timings={};
  for(const event of diagnostics.filter(event=>event.event==='matting-frame-timing'))timings[event.phase]=(timings[event.phase]??0)+1;
  assert.deepEqual(timings,expectedTimings);
  for(const kind of ['matting-process','tracking-decoder','matting-encoder','frame-probe']){
    const starts=diagnostics.filter(event=>event.event===`${kind}-start`);
    assert.ok(starts.length>0);
    for(const start of starts){
      const exits=diagnostics.filter(event=>event.event===`${kind}-exit`&&event.pid===start.pid&&event.phase===start.phase);
      assert.equal(exits.length,1,`Missing ${kind} exit in ${start.phase}`);
      if(kind==='frame-probe')continue;
      const expectedCode=start.phase==='worker-crash'?9:start.phase==='pipeline-cancel'&&kind!=='matting-process'?null:0;
      assert.equal(exits[0].code,expectedCode);
    }
  }
  const backends=phase=>diagnostics.filter(event=>event.phase===phase&&event.event==='matting-backend').map(event=>event.backend);
  assert.deepEqual(backends('auto-fallback'),['dml','cpu']);assert.deepEqual(backends('strict-gpu-failure'),['dml']);
  assert.deepEqual(backends('pipeline-720p'),['dml']);assert.deepEqual(backends('pipeline-4k'),['dml']);
  // The final check is appended only after the original host checks all owned
  // OS processes and BrowserWindows. Old PIDs must not be re-tested after reuse.
  const cleanup={observedAt:'native-host-completion',ownedProcessCount:new Set(diagnostics.filter(event=>Number.isInteger(event.pid)).map(event=>event.pid)).size,survivingOwnedProcesses:0,browserWindows:0,parentNativeInferenceBinding:false};
  assert.ok(cleanup.ownedProcessCount>0);

  const run=async(executable,args)=>{
    const value=await promisify(execFile)(executable,args,{windowsHide:true,encoding:'buffer',timeout:60000,maxBuffer:64*1024*1024});
    assert.equal(value.stderr.toString().trim(),'','Output validation emitted a decoder error');
    return value.stdout;
  };
  const outputFiles=[];
  assert.deepEqual(result.pipelines.map(pipeline=>pipeline.name),['pipeline-720p','pipeline-4k']);
  for(const [index,pipeline] of result.pipelines.entries()){
    const {cutout,frames}=pipeline;
    const [width,height,duration,expectedPts]=index===0?[1280,720,.1,[0,33333,66667]]:[3840,2160,.01,[0]];
    assert.equal(cutout.width,width);assert.equal(cutout.height,height);assert.equal(cutout.duration,duration);
    assert.equal(cutout.hasAlpha,true);assert.equal(cutout.hasAudio,index===0);assert.equal(cutout.codec,'ffv1');
    assert.equal(frames.length,expectedPts.length);
    const file=inside(path.join(directory,'derived'),cutout.path),digest=await hashFile(file);
    const info=JSON.parse((await run(manifest.ffprobe,['-v','error','-select_streams','v:0','-show_streams','-show_packets','-of','json',file])).toString());
    assert.equal(info.streams.length,1);const stream=info.streams[0];
    assert.equal(stream.time_base,'1/1000000');assert.equal(stream.start_pts,0);assert.equal(stream.duration_ts,duration*1e6);
    assert.equal(stream.width,width);assert.equal(stream.height,height);
    assert.deepEqual(info.packets.map(packet=>packet.pts),expectedPts);
    assert.deepEqual(info.packets.map(packet=>packet.duration),expectedPts.map((pts,frame)=>(expectedPts[frame+1]??duration*1e6)-pts));
    const pixels=await run(manifest.ffmpeg,['-v','error','-nostdin','-hwaccel','none','-threads','1','-i',file,'-map','0:v:0','-pix_fmt','bgra','-threads','1','-f','rawvideo','pipe:1']);
    const frameBytes=width*height*4;assert.equal(pixels.length,frameBytes*frames.length);
    for(const [frame,row] of frames.entries()){
      assert.equal(row.phase,pipeline.name);assert.equal(row.width,width);assert.equal(row.height,height);
      assert.equal(row.pts,expectedPts[frame]+(index===0?3000000:0));assert.match(row.inputSha256,/^[a-f0-9]{64}$/);
      assert.equal(sha256(pixels.subarray(frame*frameBytes,(frame+1)*frameBytes)),row.canonicalSha256);
      if(index===0)assert.equal(row.inputSha256,result.comparisons[frame].inputSha256);
    }
    if(index===0){
      const pcm=await run(manifest.ffmpeg,['-v','error','-nostdin','-threads','1','-i',file,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1']);
      assert.equal(pcm.length,23040);assert.equal(pcm.length,pipeline.audioBytes);assert.equal(sha256(pcm),pipeline.audioSha256);
    }
    assert.equal(await hashFile(file),digest,'Precision output changed during validation');
    outputFiles.push({name:pipeline.name,file,sha256:digest,frames:frames.length,width,height,duration});
  }
  for(const [name,digest] of Object.entries(metadataSha256))assert.equal(await hashFile(path.join(directory,name)),digest,'Precision metadata changed during validation');
  const runtimeFiles=[
    [host,manifest.hostSha256],[manifest.workerPath,manifest.workerSha256],
    [manifest.ffmpeg,manifest.ffmpegSha256],[manifest.ffprobe,manifest.ffprobeSha256],
    [fixture.raw,fixture.rawHash],[fixture.source.file,fixture.source.sha256],
    ...Object.values(manifest.models).map(model=>[model.file,model.sha256]),
    ...Object.entries(profileSha256).map(([name,digest])=>[path.join(directory,name),digest]),
  ];
  for(const [file,digest] of runtimeFiles)assert.equal(await hashFile(file),digest,`Precision runtime changed during validation: ${file}`);
  for(const file of sourceFiles)assert.equal(await hashFile(path.join(workspace,file)),manifest.sources[file],`Precision source changed during validation: ${file}`);
  assert.equal((await validateBuildReceipt(workspace)).contentId,currentReceipt.contentId);
  return {
    name:'matting-precision',directory,version:result.version,buildReceiptId:result.buildReceiptId,
    checks:result.checks,frameRequests:result.frameRequests,automaticRetryCount:result.automaticRetryCount,
    nativeAttemptUpperBound:result.nativeAttemptUpperBound,maximumNativeAttempts:manifest.maximumNativeAttempts,
    modelSha256:result.modelSha256,gpuModelSha256:result.gpuModelSha256,workerSha256:result.workerSha256,
    metadataSha256,profileSha256,profiles:result.profiles,comparisons:result.comparisons,cleanup,outputFiles,
    scope:result.scope,distribution:result.distribution,
  };
}
