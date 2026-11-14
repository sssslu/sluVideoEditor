import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {build as bundle} from 'esbuild';
import {trackingEvidence,cutoutEvidence} from './e2e-release-evidence.mjs';
import {BUILD_RECEIPT_PATH,validateBuildReceipt} from './build-receipt.mjs';
import {mattingPrecisionEvidence} from './matting-precision-evidence.mjs';
import {baseUIEvidencePath,validateBaseUIEvidence} from './check-base-ui.mjs';
import {featureEvidence,archiveFeatureEvidence} from './feature-evidence.mjs';

const read=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const version=(await read('package.json')).version,short=version;
const buildReceipt=await validateBuildReceipt(path.resolve('.'));
const baseUIEvidence=await validateBaseUIEvidence();
const log=async name=>{const data=await fs.readFile(`.test-artifacts/${name}-${short}.log`);return data.toString(data[0]===255&&data[1]===254?'utf16le':'utf8').replace(/^\uFEFF/,'');};
const build=await log('build'),integration=await log('integration');
const decode=async file=>{const data=await fs.readFile(file);return data.toString(data[0]===255&&data[1]===254?'utf16le':'utf8').replace(/^\uFEFF/,'');};
const unitLog=await decode(`.test-artifacts/tests-${short}-final.log`),uiLog=await decode(`.test-artifacts/e2e-${short}-source.log`);
for(const text of [build,integration,unitLog,uiLog])assert.ok(text.includes(`slu-video-editor@${version}`),'Verification log belongs to another version');
assert.ok(build.includes('built in')&&!build.includes('error TS'),'Production build must pass');
assert.ok(build.includes(buildReceipt.contentId),'Build log must identify the verified input/output receipt');
assert.ok(integration.includes('Integration checks passed.'),'Integration run must complete');
assert.ok(uiLog.includes('IPC regression passed'),'Every source UI script must finish');
assert.ok(!/^ok \d+ - (OpenCL16-bit|GPU failure).*# SKIP/m.test(unitLog),'Release verification must execute the GPU transition tests on the test GPU');
const unit={};for(const key of ['tests','pass','fail','cancelled','skipped']){const values=[...unitLog.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`,'gm'))];assert.equal(values.length,1,`Expected one final ${key} count`);unit[key]=Number(values[0][1]);}
assert.equal(unit.fail,0);assert.equal(unit.cancelled,0);assert.equal(unit.tests,unit.pass+unit.skipped);assert.ok(unit.pass>0);
const directories=['e2e','e2e-additional','editor-v2','editor-boundaries','speed-curve','stabilization-ui','stabilization-fidelity-ui','reverse-ui','job-locks-ui','transitions-ui','transition-jobs','source-revision/ipc','source-async','captions-ui','ipc-v2','color-ui','audio-eq-ui','eq-continuity-ui','media-clock-ui','freeze-frame-ui','media-alpha-ui','color-range-ui'];
const ui=[],sourceEvidence=new Map();for(const name of directories){const result=await read(`.test-artifacts/${name}/results.json`);assert.equal(result.version,version);assert.equal(result.executable,null,'Source UI verification must use the source runtime');assert.deepEqual(result.errors,[]);assert.ok(!result.findings?.length);assert.ok(result.checks.length>0);ui.push({name,checks:result.checks.length});sourceEvidence.set(name,result);}
assert.ok(sourceEvidence.get('captions-ui').checks.length>=18,'Caption UI must include the latest timing, minimum-window, legacy animation and120fps regressions');
const helper=await read('resources/licenses/audio-stretch-manifest.json'),stereo=await read('.test-artifacts/audio-review/stereo/results.json');
const digest=createHash('sha256').update(await fs.readFile(helper.helper)).digest('hex');assert.equal(digest,helper.helperSha256);assert.equal(digest,stereo.helperSha256);assert.equal(stereo.reports.length,15);
const pixels=await read('.test-artifacts/transition-pixels/results.json'),graph=await read('.test-artifacts/transitions/graph/results.json'),parity=await read('.test-artifacts/transitions/render/parity-results.json'),video=await read('.test-artifacts/transitions/render/video-results.json'),audio=await read('.test-artifacts/transitions/audio/results.json'),curve=await read('.test-artifacts/transitions/audio/curve-results.json');
const renderedCode=await bundle({stdin:{contents:"import {GLCompositor} from './src/preview/renderer';import {CPUCompositor} from './src/preview/fallback';import {newClip,newProject} from './shared/project';import {transitionPixel} from './shared/transitions';globalThis.transitionQA={GLCompositor,CPUCompositor,newClip,newProject,transitionPixel};",resolveDir:path.resolve('.')},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'});
assert.equal(pixels.rendererSourceSha256,createHash('sha256').update(renderedCode.outputFiles[0].text).digest('hex'),'Preview pixel results must use current source renderers');
assert.equal(pixels.version,version);assert.deepEqual(pixels.errors,[]);assert.equal(pixels.reports.length,180);
assert.ok(pixels.reports.every(item=>item.renderers.length===2&&item.renderers.every(r=>r.mean<1.2&&r.badRatio<.006)));
assert.equal(graph.length,14);assert.ok(graph.every(item=>item.maximumError<=1));assert.equal(parity.length,4);assert.ok(parity.every(item=>item.windowDifferences===0&&item.outsideFramesUnchanged>0));assert.equal(video.windowDifferences,0);
assert.equal(audio.length,3);assert.ok(audio.every(item=>item.maximumSampleError<5e-8&&item.blockSizeDifferences===0&&item.decoderStarts===2));
assert.equal(curve.helperSHA256,digest);assert.equal(curve.pointCount,64);assert.equal(curve.blockSizeDifferences,0);assert.equal(curve.cancellationSurvivors,0);assert.ok(Math.max(...curve.landmarks.map(item=>Math.abs(item.error)))<.001);
const gpu=await read('.test-artifacts/transitions/gpu/window-results.json'),gpuFallback=await read('.test-artifacts/transitions/gpu/fallback-results.json'),captionTiming=await read('.test-artifacts/caption-timing/results.json');
assert.equal(gpu.passed,true);assert.equal(gpu.pixelCases,14);assert.equal(gpu.windows.length,2);assert.ok(gpu.windows.every(item=>item.windowDifferences===0&&item.maximumCpuDifference<=2&&item.meanCpuDifference<.05&&item.cpuOverrideExact));
assert.equal(gpuFallback.passed,true);assert.equal(gpuFallback.injectedAfterCompletedWindow,true);assert.equal(gpuFallback.fallbackFramesAndAudioExact,true);assert.equal(gpuFallback.survivingChildren,0);assert.equal(gpuFallback.publishedCancelledOutput,false);
assert.ok(gpuFallback.audioRms>.01);assert.equal(gpuFallback.audioIncludesCurveFadeTransientAndPhaseChange,true);
assert.equal(captionTiming.fps,120);assert.equal(captionTiming.frameDifferences,0);assert.ok(captionTiming.frames>=720);
const benchmark=await read('.test-artifacts/transitions/benchmark/all-results.json');assert.equal(benchmark.length,4);assert.equal(new Set(benchmark.map(item=>item.kind)).size,4);assert.ok(benchmark.every(item=>item.passed&&item.errors.length===0&&item.frames===120&&item.duration===4&&item.seconds>0&&item.hardwareEncoding));
const result={version,recordedAt:new Date().toISOString(),scope:'Source build and actual Electron UI; packaged application is verified separately',unit,ui,uiChecks:ui.reduce((n,item)=>n+item.checks,0),integration:(await read('.test-artifacts/integration/results.json')).checks,helperSha256:digest,stereoCases:stereo.reports.length};
result.transitions={pixelCases:pixels.reports.length,pixelComparisons:pixels.reports.length*2,maximumReferenceMean:Math.max(...pixels.reports.flatMap(item=>item.renderers.map(r=>r.mean))),graphCases:graph.length,maximumGraphError:Math.max(...graph.map(item=>item.maximumError)),parity,video,audio,curve,gpu,gpuFallback,benchmark};
result.captionTiming=captionTiming;
result.uiExecution={hidden:true,isolatedProfiles:true,chromiumArguments:['--disable-frame-rate-limit'],scope:'UI correctness only; separate output benchmarks use normal Chromium arguments'};
const richCaptions=await read('.test-artifacts/rich-captions/results.json'),captionRaster=await read('.test-artifacts/caption-raster/results.json'),captionPreview=await read('.test-artifacts/caption-output-preview/results.json');
assert.equal(richCaptions.version,version);assert.equal(richCaptions.passed,true);assert.ok(richCaptions.checks.length>=7);
assert.equal(captionRaster.version,version);assert.deepEqual(captionRaster.errors,[]);assert.ok(captionRaster.maxMean<.1);assert.ok(captionRaster.raster.bytes<=48*1024*1024&&captionRaster.layouts.characters<=200000);
for(const evidence of [richCaptions,captionRaster]){assert.ok(Object.keys(evidence.sourceHashes||{}).length>=10);for(const [file,hash]of Object.entries(evidence.sourceHashes))assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),hash,`Stale caption source evidence: ${file}`);}
for(const [file,hash]of Object.entries(richCaptions.bundleHashes))assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),hash,`Stale caption bundle evidence: ${file}`);
const pipeFailure=await read('.test-artifacts/rich-captions/log-sink/results.json'),supervisorFailure=await read('.test-artifacts/rich-captions/log-sink/parent-disconnect-results.json');
for(const evidence of [pipeFailure,supervisorFailure]){assert.equal(evidence.passed,true);assert.equal(evidence.code,1);assert.equal(evidence.cleanup.windows,0);}
const hashFile=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const reverse=sourceEvidence.get('reverse-ui');assert.equal(reverse.checks.length,24);assert.equal(reverse.frames.length,13);assert.ok(reverse.frames.every(row=>row.actual===row.expected));assert.equal(reverse.exports.length,2);assert.ok(reverse.exports.every(row=>row.codes.length===12&&row.audit.some(e=>e.code===0&&e.codec===(row.encoder==='nvenc'?'h264_nvenc':'libx264'))));
assert.equal(reverse.colors.length,7);assert.ok(reverse.colors.every(row=>row.maximum<=2&&row.audit.some(e=>e.code===0&&e.codec==='h264_nvenc'&&e.decoder===(row.name==='vp9-sd-pc'?'cpu':'cuda'))));assert.ok(reverse.reverseAudit.some(e=>e.decoder==='cuda'&&e.codec==='wrapped_avframe'));assert.ok(reverse.reverseAudit.some(e=>e.decoder==='cuda'&&e.codec==='h264_nvenc'&&e.code===0));
assert.ok(Object.keys(reverse.sourceHashes||{}).length>=11);for(const [file,hash]of Object.entries(reverse.sourceHashes))assert.equal(await hashFile(file),hash,`Stale reverse editor evidence: ${file}`);result.reverse=reverse;
const reverseEngine=await read('.test-artifacts/reverse/fixtures.json'),reverseFallback=await read('.test-artifacts/reverse/fallback.json');assert.equal(reverseEngine.version,version);assert.equal(reverseEngine.clock.length,17);assert.equal(reverseEngine.colors.length,6);assert.ok(reverseEngine.gpu);assert.equal(reverseFallback.passed,true);assert.equal(reverseFallback.injectedAfterCompletedChunk,true);assert.ok(Object.keys(reverseEngine.sourceHashes||{}).length>=6);for(const [file,hash]of Object.entries(reverseEngine.sourceHashes))assert.equal(await hashFile(file),hash,`Stale reverse engine evidence: ${file}`);result.reverseEngine={fixtures:reverseEngine,fallback:reverseFallback};
for(const name of ['gpu','gpu-fallback','gpu-codecs','geometry']){const evidence=await read(`.test-artifacts/reverse/${name}.json`);assert.equal(evidence.version,version);assert.equal(evidence.passed,true);assert.ok(Object.keys(evidence.sourceHashes||{}).length>=6);for(const [file,hash]of Object.entries(evidence.sourceHashes))assert.equal(await hashFile(file),hash,`Stale reverse ${name}: ${file}`);result.reverseEngine[name]=evidence;}
assert.equal(result.reverseEngine.gpu.clock.length,13);assert.equal(result.reverseEngine.gpu.colors.length,6);assert.equal(result.reverseEngine.gpu.pool.frames,39);assert.equal(result.reverseEngine['gpu-fallback'].details.length,2);assert.equal(result.reverseEngine['gpu-codecs'].details.length,4);assert.equal(result.reverseEngine.geometry.details.length,3);
const reversePerformance=await read('.test-artifacts/reverse-performance/results.json');assert.equal(reversePerformance.version,version);assert.equal(reversePerformance.passed,true);assert.equal(reversePerformance.reports.length,2);assert.ok(Object.keys(reversePerformance.sourceHashes||{}).length>=7);for(const [file,hash]of Object.entries(reversePerformance.sourceHashes))assert.equal(await hashFile(file),hash,`Stale reverse benchmark: ${file}`);for(const report of reversePerformance.reports){assert.equal(report.runs.length,6);for(const mode of ['cpu','auto'])assert.equal(report.runs.filter(run=>run.decoder===mode).length,3);assert.ok(report.runs.every(run=>run.encoded.encoder==='h264_nvenc'&&run.encoded.decoder===(run.decoder==='auto'?'cuda':'cpu')&&run.samples.length>=3));}result.reverseEngine.performance=reversePerformance;
const fidelity=sourceEvidence.get('stabilization-fidelity-ui');assert.equal(fidelity.checks.length,14);assert.equal(fidelity.clock.length,8);assert.equal(fidelity.colors.length,6);
for(const row of fidelity.clock){assert.deepEqual(row.derived.map(v=>v.code),row.original.map(v=>v.code));assert.equal(row.coldOriginal.code,row.original[0].code);assert.equal(row.coldDerived.code,row.derived[0].code);assert.equal(row.frames[0],0);}
assert.ok(fidelity.colors.every(row=>row.maximum<=2));assert.ok(Object.keys(fidelity.sourceHashes||{}).length>=8);for(const [file,hash]of Object.entries(fidelity.sourceHashes))assert.equal(await hashFile(file),hash,`Stale stabilization/initial-seek evidence: ${file}`);result.stabilizationFidelity=fidelity;
assert.equal(captionPreview.version,version);assert.equal(captionPreview.executable,null);assert.deepEqual(captionPreview.errors,[]);assert.equal(captionPreview.fps,120);
assert.equal(captionPreview.details.length,2);assert.ok(captionPreview.details.every(item=>item.frames===73&&item.maximumMean<1.2&&item.maximumInkMean<5&&item.maximumPixelsOver8<.15));
assert.equal(captionPreview.details.find(item=>item.mode==='cpu').maximumMean,0);
for(const [file,hash]of Object.entries(captionPreview.sourceHashes))assert.equal(await hashFile(file),hash,`Stale preview evidence: ${file}`);
assert.equal(await hashFile('.test-artifacts/rich-captions/raw-fixture.json'),captionPreview.fixtureSha256);assert.equal(await hashFile('.test-artifacts/rich-captions/actual.yuv'),captionPreview.actualSha256);
const captionBenchmark=await read('.test-artifacts/rich-captions/benchmark/results.json');assert.equal(captionBenchmark.version,version);assert.equal(captionBenchmark.passed,true);assert.equal(captionBenchmark.details.length,2);
for(const [file,hash]of Object.entries(captionBenchmark.hashes))assert.equal(await hashFile(file),hash,`Stale benchmark evidence: ${file}`);
assert.ok(captionBenchmark.details.every(item=>item.width===3840&&item.height===2160&&item.frames===60&&item.duration===2&&item.seconds>0&&item.encoder==='h264_nvenc'));
const captionCache=captionBenchmark.details.find(item=>item.kind==='rich-captions').events.find(item=>item.event==='caption-renderer-close');assert.ok(captionCache.reusedFrames>0&&captionCache.renderedFrames>0&&captionCache.reusedFrames+captionCache.renderedFrames===60&&captionCache.peakCacheBytes<=64*1024*1024);
result.richCaptions={render:richCaptions,raster:captionRaster,preview:captionPreview,benchmark:captionBenchmark,pipeFailure,supervisorFailure};
const captionWords=await read('.test-artifacts/caption-words/results.json');assert.equal(captionWords.version,version);assert.equal(captionWords.passed,true);assert.equal(captionWords.tests.length,2);assert.ok(captionWords.tests.every(item=>item.measuredWords>0&&item.cues>0));
for(const [file,hash]of Object.entries(captionWords.sourceHashes))assert.equal(await hashFile(file),hash,`Stale recognition evidence: ${file}`);
assert.equal(await hashFile('resources/bin/whisper-cpu/Release/whisper-cli.exe'),captionWords.engineSha256);assert.equal(await hashFile('.test-artifacts/services/models/ggml-base.bin'),captionWords.modelSha256);
for(const sample of captionWords.tests)assert.equal(await hashFile(`tests/fixtures/${sample.name}.wav`),sample.fixtureSha256);
result.richCaptions.words=captionWords;
const colorRender=await read('.test-artifacts/color-render/results.json'),colorPixels=await read('.test-artifacts/color-pixels/results.json'),colorUI=sourceEvidence.get('color-ui');
assert.ok(colorUI.checks.length>=13);assert.equal(colorUI.exportPixels.frames,15);assert.ok(colorUI.exportPixels.mean<2.5&&colorUI.exportPixels.max<45);
assert.equal(colorRender.results.length,8);assert.equal(colorRender.timeline.frames,15);assert.equal(colorRender.timeline.max,0);assert.equal(colorPixels.details.length,16);assert.deepEqual(colorPixels.errors,[]);
assert.ok(colorRender.results.every(item=>item.max<=2&&item.mean<.7));assert.ok(colorPixels.details.every(item=>item.max<=1&&item.mean<.15&&item.exportMax<=2&&item.exportMean<.7));
for(const evidence of [colorRender,colorPixels,colorUI]){assert.equal(evidence.version,version);assert.ok(Object.keys(evidence.sourceHashes||{}).length>=4);for(const [file,hash]of Object.entries(evidence.sourceHashes))assert.equal(await hashFile(file),hash,`Stale color evidence: ${file}`);}
result.color={render:colorRender,pixels:colorPixels,ui:colorUI};
const audioEQ=sourceEvidence.get('audio-eq-ui');assert.ok(audioEQ.checks.length>=13);assert.equal(audioEQ.parity.length,8);assert.ok(audioEQ.parity.every(r=>r.frames===12000&&r.channels===2&&r.max<2e-6));assert.ok(audioEQ.churn.maximum<=14&&!audioEQ.churn.pending&&!audioEQ.churn.outgoing);
assert.ok(Object.keys(audioEQ.sourceHashes||{}).length>=8);for(const [file,hash]of Object.entries(audioEQ.sourceHashes))assert.equal(await hashFile(file),hash,`Stale EQ evidence: ${file}`);result.audioEQ=audioEQ;
const continuity=sourceEvidence.get('eq-continuity-ui');assert.ok(continuity.checks.length>=8);assert.equal(continuity.reports.length,2);assert.ok(continuity.reports.every(r=>r.ended&&!r.seeks&&!r.resets&&r.rows.length>=30&&r.rows.every(v=>v.same&&v.voices===1&&Math.abs(v.peak+15.9382)<.3)));assert.ok(Object.keys(continuity.sourceHashes||{}).length>=5);for(const [file,hash]of Object.entries(continuity.sourceHashes))assert.equal(await hashFile(file),hash,`Stale audio continuity evidence: ${file}`);result.audioContinuity=continuity;
const continuousExport=await read('.test-artifacts/audio-eq/continuity/results.json');assert.equal(continuousExport.length,2);assert.ok(continuousExport.every(r=>r.frames===144000&&r.splits===2&&r.sampleDifferences===0&&r.partialDifferences===0&&r.decoders===1));result.audioContinuousExport=continuousExport;
const clock=sourceEvidence.get('media-clock-ui'),freeze=sourceEvidence.get('freeze-frame-ui');
const mediaAlpha=sourceEvidence.get('media-alpha-ui');assert.ok(mediaAlpha.checks.length>=12&&mediaAlpha.frames.length===42&&mediaAlpha.frames.every(row=>row.actual===row.expected));
assert.equal(mediaAlpha.exports.length,6);assert.ok(mediaAlpha.exports.every(row=>row.count===54&&!row.mismatches.length&&row.encoders.some(e=>e.code===0&&e.codec===(row.encoder==='nvenc'?'h264_nvenc':'libx264'))));assert.equal(mediaAlpha.proxies.length,3);assert.equal(mediaAlpha.audio.length,2);
for(const [file,hash]of Object.entries(mediaAlpha.sourceHashes))assert.equal(await hashFile(file),hash,`Stale transparent-video evidence: ${file}`);result.mediaAlpha=mediaAlpha;
assert.ok(clock.checks.length>=20&&clock.frames.length>=61&&clock.frames.every(frame=>frame.actualFrame===frame.expectedFrame));
assert.equal(clock.exports.length,18);assert.ok(clock.exports.every(row=>row.frames>=30&&!row.mismatches.length&&row.encoders.some(e=>e.code===0&&e.codec===(row.encoder==='nvenc'?'h264_nvenc':'libx264'))));assert.ok(clock.exports.some(row=>row.label.startsWith('native-30-tagged')&&row.encoder==='nvenc'&&row.encoders.some(e=>e.cuda&&e.code===0)));
assert.ok(freeze.checks.length>=7&&freeze.pixels.length>=7&&freeze.pixels.some(sample=>sample.name==='alpha')&&freeze.pixels.every(sample=>sample.name==='alpha'?sample.mean<.75&&sample.max<=4&&sample.alphaDifferences===0:sample.mean<.3&&sample.max<=3));
const alpha=await read('.test-artifacts/freeze-frame/alpha-results.json');
assert.equal(alpha.length,3);
assert.deepEqual(alpha.map(row=>row.alpha),[0,128,255]);
for(const row of alpha){
  assert.equal(row.actual.length,3);
  assert.equal(row.expected.length,3);
  if(row.alpha===0)assert.deepEqual(row.actual,[0,0,0]);
  else assert.ok(row.actual.every((value,index)=>Math.abs(value-row.expected[index])<=1));
}
result.freezeAlphaReference=alpha;
for(const evidence of [clock,freeze]){assert.ok(Object.keys(evidence.sourceHashes||{}).length>=10);for(const [file,hash] of Object.entries(evidence.sourceHashes))assert.equal(await hashFile(file),hash,`Stale clock/freeze evidence: ${file}`);}
const renderClock=await read('.test-artifacts/render-clock/results.json'),renderPhase=await read('.test-artifacts/render-clock/phase-results.json');assert.ok(renderClock.length>=9&&renderClock.every(row=>row.frames>0&&!row.mismatches.length));assert.equal(renderPhase.length,3);assert.ok(renderPhase.every(row=>row.frames>0&&!row.mismatches.length));result.mediaClock={preview:clock,renderClock,renderPhase};result.freezeFrame=freeze;
const evidenceDirectory=path.resolve('.test-artifacts/source-verification',version);await fs.mkdir(evidenceDirectory,{recursive:true});
const renderPerformance=await read(`.test-artifacts/render-performance-${version}/results.json`);assert.equal(renderPerformance.version,version);assert.equal(renderPerformance.passed,true);assert.equal(renderPerformance.stress.frames,1997);assert.deepEqual(renderPerformance.stress.errors,[]);assert.deepEqual(renderPerformance.stress.orphanPids,[]);assert.equal(renderPerformance.cuda.runs.length,5);assert.equal(renderPerformance.cuda.audioIdentical,true);assert.ok(Object.keys(renderPerformance.sourceHashes).length>=10);
for(const [file,hash]of Object.entries(renderPerformance.sourceHashes))assert.equal(await hashFile(file),hash,`Stale render performance evidence: ${file}`);result.renderPerformance=renderPerformance;
const colorRange=sourceEvidence.get('color-range-ui');assert.equal(colorRange.checks.length,14);assert.equal(colorRange.exports.length,24);assert.equal(colorRange.derivatives.length,6);assert.equal(colorRange.legacy.length,2);assert.ok(colorRange.exports.every(row=>row.frames===24&&row.mean<2.5&&row.audit.some(e=>e.code===0&&e.codec===(row.encoder==='nvenc'?'h264_nvenc':'libx264'))));
for(const [file,hash]of Object.entries(colorRange.sourceHashes))assert.equal(await hashFile(file),hash,`Stale color-range evidence: ${file}`);result.colorRange=colorRange;
for(const [name,evidence] of sourceEvidence){const destination=path.join(evidenceDirectory,name);await fs.mkdir(destination,{recursive:true});await fs.writeFile(path.join(destination,'results.json'),JSON.stringify(evidence,null,2)+'\n');}
for(const name of [`build-${short}.log`,`integration-${short}.log`,`tests-${short}-final.log`,`e2e-${short}-source.log`])await fs.copyFile(path.join('.test-artifacts',name),path.join(evidenceDirectory,name));
result.evidenceDirectory=evidenceDirectory;
result.baseUIBuild={buildReceiptId:baseUIEvidence.buildReceiptId,checks:baseUIEvidence.checks,completedAt:baseUIEvidence.completedAt};
assert.equal(baseUIEvidence.checks,result.uiChecks);
await fs.copyFile(baseUIEvidencePath(false),path.join(evidenceDirectory,'base-ui-source.json'));
await fs.copyFile('scripts/check-base-ui.mjs',path.join(evidenceDirectory,'check-base-ui.mjs'));
result.tracking=await trackingEvidence();
for(const report of result.tracking){const destination=path.join(evidenceDirectory,report.name);await fs.mkdir(destination,{recursive:true});await fs.copyFile(path.join(report.directory,'results.json'),path.join(destination,'results.json'));}
result.trackingChecks=result.tracking.reduce((n,report)=>n+report.checks.length,0);
result.cutout=await cutoutEvidence();
for(const report of result.cutout){
  const destination=path.join(evidenceDirectory,report.name);
  await fs.mkdir(destination,{recursive:true});
  await fs.copyFile(path.join(report.directory,'results.json'),path.join(destination,'results.json'));
}
result.cutoutChecks=result.cutout.reduce((total,report)=>total+report.checks.length,0);
result.mattingPrecision=await mattingPrecisionEvidence({buildReceipt});
const precisionDirectory=path.join(evidenceDirectory,'matting-precision');
await fs.mkdir(precisionDirectory,{recursive:true});
for(const [name,digest] of Object.entries(result.mattingPrecision.metadataSha256)){
  const destination=path.join(precisionDirectory,name);
  await fs.copyFile(path.join(result.mattingPrecision.directory,name),destination);
  assert.equal(await hashFile(destination),digest,'Precision evidence changed while archiving');
}
assert.equal((await validateBuildReceipt(path.resolve('.'))).contentId,buildReceipt.contentId);
result.features=await featureEvidence({buildReceipt});
await archiveFeatureEvidence(result.features,path.join(evidenceDirectory,'features'));
result.buildReceiptId=buildReceipt.contentId;
await fs.copyFile(BUILD_RECEIPT_PATH,path.join(evidenceDirectory,'build-receipt.json'));
const output=path.resolve(`.test-artifacts/verification-${version}.json`);await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
