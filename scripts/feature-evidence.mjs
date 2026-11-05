import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,promises as fs} from 'node:fs';
import path from 'node:path';
import {validateBuildReceipt,validatePackagedBuild} from './build-receipt.mjs';

export const featureSuites = [
  {name:'encoder-picker-regression',script:'e2e-encoder-picker.mjs',minimum:13},
  {name:'caption-fonts-ui',script:'e2e-caption-fonts.mjs',minimum:8},
  {name:'color-ui',script:'e2e-color.mjs',minimum:14},
  {name:'keyframe-editor-ui',script:'e2e-keyframe-editor.mjs',minimum:10},
  {name:'track-limit-regression',script:'e2e-track-limit.mjs',minimum:27},
  {name:'enhancement-ui',script:'e2e-enhancement-ui.mjs',minimum:12},
  {name:'enhancement-ipc',script:'e2e-enhancement-ipc.mjs',minimum:8},
  {name:'enhancement-real',script:'e2e-enhancement-real.mjs',minimum:8},
];
const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
async function hash(file) {
  const digest=createHash('sha256');
  for await(const block of createReadStream(file))digest.update(block);
  return digest.digest('hex');
}
function inside(root,file) {
  const relative=path.relative(root,path.resolve(file));
  assert.ok(relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative),'Evidence path escapes its root');
  return path.resolve(file);
}
function complete(report,label) {
  assert.equal(report.passed,true,`${label} did not complete`);
  assert.ok(Number.isFinite(Date.parse(report.completedAt)),`${label} has no completion timestamp`);
  assert.deepEqual(report.errors,[],`${label} contains errors`);
  assert.ok(!report.findings?.length,`${label} contains findings`);
}
async function sourceHashes(report,required,workspace) {
  assert.ok(report.sourceHashes&&typeof report.sourceHashes==='object','Source hashes are missing');
  for(const file of required)assert.match(report.sourceHashes[file]||'',/^[a-f0-9]{64}$/,`Missing source hash ${file}`);
  for(const [file,digest] of Object.entries(report.sourceHashes)) {
    const absolute=inside(workspace,path.resolve(workspace,file));
    assert.equal(await hash(absolute),digest,`Stale feature evidence ${file}`);
  }
}

// Exported separately so stale/version/tamper rejection can be checked with
// small isolated files, without launching the editor or loading AI models.
export async function validateFeatureReport(report,suite,{workspace,buildReceipt,packaged=false}) {
  complete(report,suite.name);
  assert.equal(report.version,buildReceipt.version);
  assert.equal(report.buildReceiptId,buildReceipt.contentId);
  assert.ok(Array.isArray(report.checks)&&report.checks.length>=suite.minimum,`Incomplete ${suite.name} checks`);
  assert.ok(report.checks.every(check=>typeof check==='string'&&check.length>0));
  const executable=packaged?path.join(workspace,'release/win-unpacked/SLU Studio.exe'):null;
  assert.equal(report.executable,executable);
  assert.equal(report.runtime?.version,buildReceipt.version);
  assert.equal(report.runtime?.packaged,packaged);
  assert.equal(report.runtime?.hidden,true);
  const required=['package.json','package-lock.json','scripts/e2e-launch.mjs','scripts/e2e-release-evidence.mjs',`scripts/${suite.script}`,
    ...Object.keys(buildReceipt.inputs).filter(file=>/^(electron|shared|src)\//.test(file))];
  await sourceHashes(report,required,workspace);
  if(packaged) {
    assert.equal(path.resolve(report.runtime.executable),executable);
    assert.equal(report.exeSha256,await hash(executable));
    assert.equal(report.asarSha256,await hash(path.join(workspace,'release/win-unpacked/resources/app.asar')));
  } else {
    assert.equal(report.exeSha256,null);
    assert.equal(report.asarSha256,null);
  }
}

export function validateEnhancementHardware(hardware) {
  assert.equal(hardware?.inferenceStrategy,'independent-frames-v1','Quality evidence requires independent-frame inference');
  assert.equal(hardware.modelTemporalFrames,1);
  assert.equal(hardware.transportWindowFrames,9);
  assert.equal(hardware.overlapReuseFrames,4);
  assert.equal(hardware.vaeTileSize,256);
  for(const field of ['directEstimatedVramBytes','partialEstimatedVramBytes','vramBudgetBytes','estimatedVramBytes',
    'originalGeometryVramBytes','estimatedRamBytes','estimatedCommitBytes','frameCopyAllowanceBytes']) {
    assert.ok(Number.isSafeInteger(hardware[field])&&hardware[field]>0,`Missing positive resource estimate ${field}`);
  }
  const blocks=hardware.directEstimatedVramBytes<=hardware.vramBudgetBytes?0:8;
  assert.equal(hardware.blocksToSwap,blocks,'Worker device-placement plan does not match admission');
  assert.equal(hardware.estimatedVramBytes,blocks?hardware.partialEstimatedVramBytes:hardware.directEstimatedVramBytes);
  assert.ok(hardware.estimatedVramBytes<=hardware.vramBudgetBytes,'Selected placement exceeds the worker budget');
  assert.equal(hardware.memoryPolicy,blocks?'partial-cuda-8-v1':'direct-cuda-v1');
  assert.ok(hardware.originalGeometryVramBytes>=hardware.directEstimatedVramBytes,'Original transport allowance was reduced');
  assert.ok(hardware.estimatedCommitBytes>=hardware.estimatedRamBytes+Math.max(hardware.originalGeometryVramBytes,hardware.vramBudgetBytes),
    'Commit estimate omitted the original transport allowance');
  return blocks;
}

export async function validateEnhancementQuality(workspace,buildReceipt) {
  const directory=path.join(workspace,'.test-artifacts/enhancement-quality');
  const filename=path.join(directory,'results.json'),reviewFile=path.join(directory,'review.json');
  const report=await read(filename),review=await read(reviewFile),reportSha256=await hash(filename);
  const runDirectory=inside(directory,(await fs.readFile(path.join(directory,'current.txt'),'utf8')).trim());
  assert.equal(await hash(path.join(runDirectory,'results.json')),reportSha256,'The latest quality attempt did not complete with this report');
  assert.equal(report.passed,true,'Actual enhancement quality run is required');
  assert.ok(Number.isFinite(Date.parse(report.completedAt))&&!report.error,'Quality run did not complete');
  assert.equal(report.version,buildReceipt.version);
  assert.equal(report.buildReceiptId,buildReceipt.contentId);
  const nativeCode=Object.keys(buildReceipt.inputs).filter(file=>file.startsWith('native/enhancement/')&&file.endsWith('.py')&&!path.basename(file).startsWith('test_'));
  await sourceHashes(report,['scripts/check-enhancement-quality.mjs',...nativeCode],workspace);
  assert.equal(report.manifestSha256,await hash(path.join(workspace,'native/enhancement/backend-manifest.json')));
  assert.match(report.runtimeRegistrySha256||'',/^[a-f0-9]{64}$/);
  assert.equal(review.reportSha256,reportSha256,'Quality review belongs to another run');
  assert.equal(review.accepted,true,'The actual output still needs visual review');
  assert.ok(Array.isArray(review.limitations)&&review.limitations.every(value=>typeof value==='string'));
  const expected=new Map([
    ['hair-2x',{scale:2,width:1920,height:1080}],
    ['dance-2x',{scale:2,width:1280,height:720}],
    ['cut-2x',{scale:2,width:1920,height:1080}],
    ['portrait-4x',{scale:4,width:1920,height:1080}],
  ]);
  assert.deepEqual(report.cases.map(item=>item.id).sort(),[...expected.keys()].sort());
  assert.deepEqual(review.caseReviews.map(item=>item.id).sort(),[...expected.keys()].sort());
  for(const item of report.cases) {
    const configuration=expected.get(item.id);
    assert.equal(item.scale,configuration.scale);
    assert.equal(item.width,configuration.width);assert.equal(item.height,configuration.height);assert.equal(item.frameCount,15);
    assert.equal(item.blocksToSwap,validateEnhancementHardware(item.hardware),'Quality run used another device-placement plan');
    assert.equal(item.inputWidth*item.scale,item.width);assert.equal(item.inputHeight*item.scale,item.height);
    assert.equal(item.pts.length,item.frameCount);
    assert.ok(item.pts.every((pts,index)=>Number.isSafeInteger(pts)&&(index===0||pts>item.pts[index-1])));
    for(const field of ['inputSha256','outputSha256','referenceSha256'])assert.match(item[field]||'',/^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(item.samples)&&item.samples.length>0);
    assert.ok(item.samples.every(sample=>Number.isInteger(sample.index)&&sample.index>=0&&sample.index<15&&/^[a-f0-9]{64}$/.test(sample.sha256)));
    for(const sample of item.samples)assert.equal(await hash(inside(runDirectory,sample.filename)),sample.sha256,'Reviewed quality image changed');
    assert.equal(item.metrics.length,15);
    for(const [index,row] of item.metrics.entries()) {
      assert.equal(row.index,index);assert.equal(row.pts,item.pts[index]);assert.equal(typeof row.emissionBoundary,'boolean');
      for(const variant of ['ai','lanczos']) {
        const values=row[variant];
        for(const field of ['mse','meanAbsoluteError','ssim',...(index>0?['temporalError']:[])])assert.ok(Number.isFinite(values[field]),`Missing finite quality metric ${field}`);
      }
    }
    assert.deepEqual(item.batches.map(batch=>batch.frameCount),[1,5,9],'Quality run must cover three transport batches');
    let first=0;
    for(const batch of item.batches) {
      assert.equal(batch.outputFirstFrame,first);
      assert.ok(Number.isInteger(batch.frameCount)&&batch.frameCount>=0);
      assert.deepEqual(batch.pts,item.pts.slice(first,first+batch.frameCount));
      assert.equal(batch.bytes,batch.frameCount*item.width*item.height*4);
      first+=batch.frameCount;
    }
    assert.equal(first,15);assert.equal(item.batches.at(-1)?.complete,true);
    const workerStart=item.diagnostics.find(event=>event.event==='enhancement-worker-start');
    const workerReady=item.diagnostics.find(event=>event.event==='enhancement-worker-ready');
    assert.ok(Number.isInteger(workerStart?.pid));
    assert.deepEqual(item.hardware,workerReady?.hardware,'Quality hardware differs from the actual worker response');
    assert.ok(item.diagnostics.some(event=>event.event==='enhancement-worker-exit'&&event.pid===workerStart.pid));
    const assessment=review.caseReviews.find(value=>value.id===item.id);
    assert.ok(assessment.observations?.length>0&&Array.isArray(assessment.limitations));
  }
  assert.ok(typeof report.qualityScope==='string'&&report.qualityScope.length>0);
  assert.ok(typeof report.distribution==='string'&&report.distribution.length>0);
  return {name:'enhancement-quality',directory,reportSha256,reviewSha256:await hash(reviewFile),report,review};
}

export function validateEnhancementRealOutputs(report,inputReference) {
  assert.deepEqual(report.fixture,{sourceWidth:960,sourceHeight:540,outputWidth:1920,outputHeight:1080,
    proxyWidth:1280,proxyHeight:720,fps:10,duration:1.5,frameCount:15});
  assert.match(report.sourceSha256||'',/^[a-f0-9]{64}$/);
  assert.equal(inputReference.sourceSha256,report.sourceSha256);
  assert.equal(inputReference.frames.length,15);
  for(const [index,frame] of inputReference.frames.entries()) {
    assert.equal(frame.pts,index*100000);assert.equal(frame.width,960);assert.equal(frame.height,540);
    assert.equal(frame.bytes,960*540*3);assert.match(frame.bgrSha256||'',/^[a-f0-9]{64}$/);
  }
  assert.ok(!report.nativeAudit.some(event=>event.event==='worker-observer-error'));
  for(const [field,count] of [['preview',1],['full',15]]) {
    const item=report[field],duration=count/10;
    assert.deepEqual(item.expected,{frameCount:count,duration});
    assert.equal(item.frameCount,count);assert.equal(item.duration,duration);
    assert.equal(item.media.kind,'video');assert.equal(item.media.hasAlpha,false);
    assert.equal(item.media.width,1920);assert.equal(item.media.height,1080);
    assert.ok(Math.abs(item.media.duration-duration)<=.002);
    assert.equal(item.browser.width,1280);assert.equal(item.browser.height,720);
    assert.ok(item.browser.readyState>=2&&Math.abs(item.browser.duration-duration)<=.002);
    const frames=item.probe.frames.filter(frame=>frame.media_type==='video');
    assert.equal(frames.length,count);
    for(const [index,frame] of frames.entries()) {
      assert.equal(Math.round(Number(frame.best_effort_timestamp_time)*1e6),index*100000);
      assert.equal(Math.round(Number(frame.duration_time)*1e6),100000);
    }
    assert.equal(item.probe.streams.find(stream=>stream.codec_type==='video')?.pix_fmt,'bgr0');
    assert.equal(item.pixels.bytes,count*1920*1080*4);assert.equal(item.pixels.frameCount,count);
    assert.equal(item.pixels.exitCode,0);assert.ok(Number.isInteger(item.pixels.pid)&&item.pixels.pid>0);
    assert.equal(item.pixels.frames.length,count);
    for(const [index,frame] of item.pixels.frames.entries()) {
      assert.equal(frame.index,index);assert.match(frame.sha256||'',/^[a-f0-9]{64}$/);
    }
    for(const name of ['fileSha256','proxySha256','nativeBgraSha256','pcmSha256'])assert.match(item[name]||'',/^[a-f0-9]{64}$/);
    assert.equal(item.pixels.sha256,item.nativeBgraSha256);assert.equal(item.pcmBytes,Math.round(duration*48000)*4);
    const worker=item.worker,ready=worker.ready;
    assert.ok(Number.isInteger(worker.pid)&&worker.pid>0);assert.equal(path.basename(worker.command).toLowerCase(),'python.exe');
    assert.equal(ready.protocolVersion,1);assert.equal(ready.inputCapacity,5);
    assert.equal(ready.outputWidth,1920);assert.equal(ready.outputHeight,1080);validateEnhancementHardware(ready.hardware);
    const observed=report.nativeAudit.filter(event=>event.event==='worker-ready'&&event.childId===worker.childId);
    assert.equal(observed.length,1);assert.equal(observed[0].pid,worker.pid);assert.deepEqual(observed[0].result,ready);
    assert.ok(report.nativeAudit.some(event=>event.event==='spawn'&&event.childId===worker.childId&&event.pid===worker.pid&&event.command===worker.command));
  }
  assert.notEqual(report.preview.worker.childId,report.full.worker.childId);
}

export async function featureEvidence({packaged=false,workspace=process.cwd(),buildReceipt}={}) {
  workspace=path.resolve(workspace);
  buildReceipt??=await validateBuildReceipt(workspace);
  assert.equal((await validateBuildReceipt(workspace)).contentId,buildReceipt.contentId);
  if(packaged)await validatePackagedBuild(path.join(workspace,'release/win-unpacked/resources/app.asar'),buildReceipt);
  const reports=[];
  for(const suite of featureSuites) {
    const pointer=path.join(workspace,`.test-artifacts/${suite.name}-current-${packaged?'packaged':'source'}.txt`);
    const directory=inside(path.join(workspace,'.test-artifacts',suite.name),(await fs.readFile(pointer,'utf8')).trim());
    const filename=path.join(directory,'results.json');
    assert.ok(!(await fs.readdir(directory)).includes('failure.json'),`${suite.name} has a failed run`);
    const report=await read(filename),reportSha256=await hash(filename);
    await validateFeatureReport(report,suite,{workspace,buildReceipt,packaged});
    const metadata=[];
    if(suite.name==='enhancement-real') {
      assert.equal(report.manifestSha256,await hash(path.join(workspace,'native/enhancement/backend-manifest.json')));
      assert.equal(report.workerSha256,await hash(path.join(workspace,'native/enhancement/seedvr_worker.py')));
      assert.ok(report.nativeAudit.some(event=>event.event==='spawn'&&path.basename(event.command).toLowerCase()==='python.exe'));
      assert.ok(!report.nativeAudit.some(event=>event.event==='blocked-fetch'));
      const nativeRoot=path.join(workspace,'native/enhancement');
      const nativeFiles=Object.keys(buildReceipt.inputs).filter(file=>file.startsWith('native/enhancement/')&&
        (/\/(seedvr_worker\.py|tensor_loader\.py|backend-manifest\.json|worker-contract\.json|requirements-lock\.txt)$/.test(file)||file.includes('/licenses/')))
        .map(file=>file.slice('native/enhancement/'.length));
      await sourceHashes({sourceHashes:report.nativeSourceHashes},nativeFiles,nativeRoot);
      const before=inside(directory,report.runtimeEvidenceFile),after=inside(directory,report.runtimeAfterFile);
      const inventory=await read(before);
      assert.deepEqual(await read(after),inventory,'The installed AI runtime changed during inference');
      assert.equal(inventory.manifestSha256,report.manifestSha256);
      assert.equal(inventory.installedFilesSha256,(await read(path.join(nativeRoot,'backend-manifest.json'))).expectedInstalledFilesSha256);
      for(const file of [before,after])metadata.push({filename:path.basename(file),source:file,sha256:await hash(file)});
      assert.equal(report.cancelledEvents.at(-1)?.status,'cancelled');
      for(const started of report.nativeAudit.filter(event=>event.event==='spawn'&&event.pid)) {
        assert.ok(report.nativeAudit.some(event=>event.event==='close'&&event.childId===started.childId),'An observed native child did not close');
      }
      const inputFile=inside(directory,report.nativeInputReferenceFile);
      validateEnhancementRealOutputs(report,await read(inputFile));
      metadata.push({filename:path.basename(inputFile),source:inputFile,sha256:await hash(inputFile)});
    }
    assert.equal(await hash(filename),reportSha256,'Feature report changed while validating');
    reports.push({name:suite.name,directory,reportSha256,checks:report.checks.length,metadata,report});
  }
  const quality=await validateEnhancementQuality(workspace,buildReceipt);
  assert.equal((await validateBuildReceipt(workspace)).contentId,buildReceipt.contentId);
  return {version:buildReceipt.version,buildReceiptId:buildReceipt.contentId,packaged,reports,quality};
}

export async function archiveFeatureEvidence(evidence,destination) {
  for(const item of [...evidence.reports,evidence.quality]) {
    const target=path.join(destination,item.name);
    await fs.mkdir(target,{recursive:true});
    const files=[['results.json',item.reportSha256]];
    if(item.reviewSha256)files.push(['review.json',item.reviewSha256]);
    for(const [name,digest] of files) {
      const bytes=await fs.readFile(path.join(item.directory,name));
      assert.equal(createHash('sha256').update(bytes).digest('hex'),digest,'Feature evidence changed before archiving');
      await fs.writeFile(path.join(target,name),bytes);
    }
    for(const file of item.metadata||[]) {
      const bytes=await fs.readFile(file.source);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,'Runtime metadata changed before archiving');
      await fs.writeFile(path.join(target,file.filename),bytes);
    }
  }
}
