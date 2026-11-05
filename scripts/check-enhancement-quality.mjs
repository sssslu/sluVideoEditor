import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs, createReadStream} from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {EnhancementProcess} from '../electron/enhancement-process.ts';
import {verifyEnhancementRuntime} from '../electron/enhancement-install.ts';
import {prepareTrackingInput} from '../electron/tracking-source.ts';
import {decodeTrackingFrames} from '../electron/tracking-decode.ts';
import {verifyVideoSelection} from '../electron/video-selection.ts';
import {validateBuildReceipt} from './build-receipt.mjs';

// Existing author-linked research footage stays outside every release archive.
// Run with node --import tsx, inside the private desktop, after reserving the GPU.
assert.deepEqual(process.argv.slice(2), ['--gpu']);
const workspace = path.resolve('.');
const base = path.resolve('.test-artifacts/enhancement-quality');
await fs.mkdir(base, {recursive: true});
await fs.writeFile(path.join(base, 'results.json'), JSON.stringify({passed: false, startedAt: new Date().toISOString()}));
const root = await fs.mkdtemp(path.join(base, 'run-'));
await fs.writeFile(path.join(base, 'current.txt'), root);
const execute = promisify(execFile);
const ffmpeg = path.resolve('resources/bin/ffmpeg.exe');
const ffprobe = path.resolve('resources/bin/ffprobe.exe');
const worker = path.resolve('native/enhancement/seedvr_worker.py');
const manifestFile = path.resolve('native/enhancement/backend-manifest.json');
const context = {ffmpeg, ffprobe, cacheDir: path.join(root, 'reference-cache')};
const receipt = await validateBuildReceipt(workspace);
const runtime = JSON.parse(await fs.readFile('.build-cache/enhancement/prepared-runtime.json', 'utf8'));
const installContext = {runtimeBase: path.dirname(runtime.runtimeRoot), manifestPath: manifestFile};
const hash = data => createHash('sha256').update(data).digest('hex');
async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const data of createReadStream(file)) digest.update(data);
  return digest.digest('hex');
}
const fixtures = {
  'priyanka.mp4': '3b6cba90151767bc2c5369b0e280fe5b5f19dd06f0acbcea7e325d75a6056b34',
  'dance2.mp4': 'c32b6753b6292657a3c9ca7a15b7052b2f6f53b5ff3f6db71d8b2b1edcaaf977',
  'tryguys.mp4': 'cba1a4a0c1c24ef77d16b9729518413a0fa560fe9f6a74482d7d275e14c13023',
};
const windows = [
  {id: 'hair-2x', fixture: 'priyanka.mp4', start: 6, scale: 2, width: 1920, height: 1080},
  {id: 'dance-2x', fixture: 'dance2.mp4', start: 3.5, scale: 2, width: 1280, height: 720},
  {id: 'cut-2x', fixture: 'tryguys.mp4', start: 2.4, scale: 2, width: 1920, height: 1080, knownCutSeconds: 2.711042},
  {id: 'portrait-4x', fixture: 'priyanka.mp4', start: 7, scale: 4, width: 1920, height: 1080, inputNoiseAmplitude: 4, noiseSeed: 42},
];
const sourceFiles = [
  'scripts/check-enhancement-quality.mjs', 'scripts/build-receipt.mjs',
  'package.json', 'package-lock.json', 'electron/enhancement-process.ts',
  'electron/enhancement-install.ts', 'electron/tracking-source.ts',
  'electron/tracking-decode.ts', 'electron/video-selection.ts',
  'native/enhancement/seedvr_worker.py', 'native/enhancement/tensor_loader.py',
  'native/enhancement/backend-manifest.json', 'native/enhancement/worker-contract.json',
  ffmpeg, ffprobe,
];
const sourceHashes = {};
for (const file of sourceFiles) sourceHashes[file] = await hashFile(file);
const report = {
  version: receipt.version, buildReceiptId: receipt.contentId, passed: false,
  startedAt: new Date().toISOString(), sourceHashes,
  manifestSha256: await hashFile(manifestFile),
  runtimeRegistrySha256: await hashFile(path.join(runtime.runtimeRoot, '.complete.json')),
  qualityScope: 'Paired synthetic downsampling of existing compressed real footage. The normal CPU source decoder produces a native 1920x1080 or bilinear 1280x720 reference. Area downsampling, Lanczos control, unchanged pinned SeedVR2 FP16 weights with independent source-frame inference and reuse of completed transport-overlap outputs. The 4x portrait also adds deterministic independent uniform BGR noise of +/-4 code values before both methods. Technical assertions and descriptive metrics require separate visual review. No independent original-camera ground truth or broad model ranking.',
  distribution: 'Metadata only may be archived. Input footage, raw frames, comparison PNGs and their derivatives are development-only and excluded from releases.',
  metricDefinitions: {
    mse: 'Mean squared BGR error in 8-bit code values against the reference.',
    ssim: 'Mean non-overlapping 8x8 luma SSIM, BT.709 weights, sample variance, K1=.01, K2=.03, range255.',
    temporalError: 'Mean absolute difference between adjacent reconstructed-frame deltas and the same reference-frame deltas. Includes motion and scene cuts. No optical flow or perceptual threshold.',
  },
  cases: [],
};
async function command(args, maxBuffer = 128 * 1024 * 1024) {
  const result = await execute(ffmpeg, ['-v', 'error', '-nostdin', '-y', ...args], {
    windowsHide: true, timeout: 120000, maxBuffer, encoding: 'buffer',
  });
  return result.stdout;
}
function quality(actual, reference, width, height) {
  assert.equal(actual.length, reference.length);
  let squared = 0, absolute = 0, ssim = 0, blocks = 0;
  for (let i = 0; i < actual.length; i++) {
    const difference = actual[i] - reference[i];
    squared += difference * difference;
    absolute += Math.abs(difference);
  }
  for (let top = 0; top < height; top += 8) {
    for (let left = 0; left < width; left += 8) {
      let sumA = 0, sumB = 0, squareA = 0, squareB = 0, product = 0, count = 0;
      for (let y = top; y < Math.min(top + 8, height); y++) {
        for (let x = left; x < Math.min(left + 8, width); x++) {
          const offset = (y * width + x) * 3;
          const a = actual[offset] * .0722 + actual[offset + 1] * .7152 + actual[offset + 2] * .2126;
          const b = reference[offset] * .0722 + reference[offset + 1] * .7152 + reference[offset + 2] * .2126;
          sumA += a; sumB += b; squareA += a * a; squareB += b * b; product += a * b; count++;
        }
      }
      const meanA = sumA / count, meanB = sumB / count;
      const varianceA = Math.max(0, (squareA - sumA * meanA) / (count - 1));
      const varianceB = Math.max(0, (squareB - sumB * meanB) / (count - 1));
      const covariance = (product - sumA * meanB) / (count - 1);
      ssim += ((2 * meanA * meanB + 6.5025) * (2 * covariance + 58.5225)) /
        ((meanA * meanA + meanB * meanB + 6.5025) * (varianceA + varianceB + 58.5225));
      blocks++;
    }
  }
  return {mse: squared / actual.length, meanAbsoluteError: absolute / actual.length, ssim: ssim / blocks};
}
function temporalError(previous, current, referencePrevious, referenceCurrent) {
  let sum = 0;
  for (let i = 0; i < current.length; i++) sum += Math.abs((current[i] - previous[i]) - (referenceCurrent[i] - referencePrevious[i]));
  return sum / current.length;
}
// A perfect match is a useful local oracle for the metric implementation.
const identity = Buffer.from(Array.from({length: 8 * 8 * 3}, (_, i) => i % 256));
assert.deepEqual(quality(identity, identity, 8, 8), {mse: 0, meanAbsoluteError: 0, ssim: 1});
assert.equal(temporalError(identity, identity, identity, identity), 0);

try {
  const verified = await verifyEnhancementRuntime(installContext);
  assert.equal(verified.runtimeRoot, runtime.runtimeRoot);
  assert.equal(verified.manifestSha256, report.manifestSha256);
  for (const window of windows) {
    const directory = path.join(root, window.id);
    await fs.mkdir(directory);
    const fixture = path.resolve('.build-cache/matting/quality', window.fixture);
    assert.equal(await hashFile(fixture), fixtures[window.fixture]);
    const input = await prepareTrackingInput({kind: 'video', path: fixture}, window.width, context);
    const selection = await verifyVideoSelection({
      file: fixture, stream: input.plan.stream, origin: input.plan.origin,
      revision: input.revision, probe: input.probe,
    }, window.start, 1, context);
    const frames = [];
    for await (const frame of decodeTrackingFrames(input.plan, selection.firstPts, selection.endPts, context)) {
      frames.push({...frame, data: Buffer.from(frame.data)});
      if (frames.length === 15) break;
    }
    assert.equal(frames.length, 15);
    let cutIndex;
    if (window.knownCutSeconds !== undefined) {
      const cutPts = Math.round(window.knownCutSeconds * 1e6);
      assert.ok(frames[0].pts <= cutPts && frames.at(-1).pts > cutPts, 'The sample must span the known cut');
      cutIndex = frames.findIndex(frame => frame.pts >= cutPts);
      assert.ok(cutIndex > 0 && cutIndex < frames.length - 1);
    }
    const {width, height} = frames[0];
    assert.equal(width, window.width); assert.equal(height, window.height);
    const inputWidth = width / window.scale, inputHeight = height / window.scale;
    const reference = Buffer.concat(frames.map(frame => frame.data));
    const referenceFile = path.join(directory, 'reference.bgr');
    await fs.writeFile(referenceFile, reference);
    const degraded = await command([
      '-f', 'rawvideo', '-pixel_format', 'bgr24', '-video_size', `${width}x${height}`, '-i', referenceFile,
      '-vf', `scale=${inputWidth}:${inputHeight}:flags=area`, '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'bgr24', 'pipe:1',
    ]);
    if (window.inputNoiseAmplitude) {
      let state = window.noiseSeed;
      for (let offset = 0; offset < degraded.length; offset++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const noise = ((state >>> 24) / 255 * 2 - 1) * window.inputNoiseAmplitude;
        degraded[offset] = Math.max(0, Math.min(255, Math.round(degraded[offset] + noise)));
      }
    }
    const degradedFile = path.join(directory, 'input.bgr');
    await fs.writeFile(degradedFile, degraded);
    const control = await command([
      '-f', 'rawvideo', '-pixel_format', 'bgr24', '-video_size', `${inputWidth}x${inputHeight}`, '-i', degradedFile,
      '-vf', `scale=${width}:${height}:flags=lanczos`, '-threads', '1', '-f', 'rawvideo', '-pix_fmt', 'bgr24', 'pipe:1',
    ]);
    const pts = frames.map(frame => frame.pts - frames[0].pts);
    const inputBytes = inputWidth * inputHeight * 3;
    assert.equal(degraded.length, frames.length * inputBytes);
    assert.equal(control.length, reference.length);
    const diagnostics = [], batches = [], chunks = [];
    const begin = performance.now();
    let engine;
    try {
      engine = await EnhancementProcess.create({
        pythonExecutable: verified.pythonExecutable, workerPath: worker, runtimeRoot: verified.runtimeRoot,
        jobDirectory: directory, width: inputWidth, height: inputHeight, scale: window.scale,
        maximumFrames: frames.length, maximumBytes: degraded.length, requestTimeoutMs: 900000,
        diagnostics: event => diagnostics.push(event),
        progress: (progress, message) => console.log(JSON.stringify({case: window.id, progress, message})),
      });
      for (let first = 0; first < frames.length; first += engine.inputCapacity) {
        const count = Math.min(engine.inputCapacity, frames.length - first);
        const filename = `input-${String(first).padStart(9, '0')}.bgr`;
        await fs.writeFile(path.join(directory, filename), degraded.subarray(first * inputBytes, (first + count) * inputBytes));
        const batch = await engine.process(filename, pts.slice(first, first + count), first + count === frames.length);
        batches.push(batch);
        if (batch.outputFile) chunks.push(await fs.readFile(path.join(directory, batch.outputFile)));
      }
    } finally {
      await engine?.close();
      await fs.writeFile(path.join(directory, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));
    }
    const elapsedSeconds = (performance.now() - begin) / 1000;
    const workerStart = diagnostics.find(event => event.event === 'enhancement-worker-start');
    const ready = diagnostics.find(event => event.event === 'enhancement-worker-ready');
    assert.ok(workerStart?.pid);
    const hardware=ready?.hardware;assert.ok(hardware);
    assert.equal(hardware.inferenceStrategy,'independent-frames-v1');assert.equal(hardware.modelTemporalFrames,1);
    assert.equal(hardware.transportWindowFrames,9);assert.equal(hardware.overlapReuseFrames,4);assert.equal(hardware.vaeTileSize,256);
    for(const key of ['directEstimatedVramBytes','partialEstimatedVramBytes','vramBudgetBytes','estimatedVramBytes'])assert.ok(Number.isSafeInteger(hardware[key])&&hardware[key]>0);
    const expectedBlocks=hardware.directEstimatedVramBytes<=hardware.vramBudgetBytes?0:8;
    assert.equal(hardware.blocksToSwap,expectedBlocks,'Placement follows the recorded single-frame admission policy');
    assert.equal(hardware.estimatedVramBytes,expectedBlocks?hardware.partialEstimatedVramBytes:hardware.directEstimatedVramBytes);
    assert.ok(hardware.estimatedVramBytes<=hardware.vramBudgetBytes);
    assert.equal(hardware.memoryPolicy,expectedBlocks?'partial-cuda-8-v1':'direct-cuda-v1');
    assert.ok(diagnostics.some(event => event.event === 'enhancement-worker-exit' && event.pid === workerStart.pid));
    const bgra = Buffer.concat(chunks);
    assert.equal(bgra.length, width * height * 4 * frames.length);
    assert.deepEqual(batches.flatMap(batch => batch.pts), pts);
    assert.deepEqual(batches.map(batch=>batch.frameCount),[1,5,9],'Exact three transport batches');
    assert.equal(batches.at(-1).complete, true);
    const restored = Buffer.alloc(reference.length);
    for (let pixel = 0; pixel < bgra.length / 4; pixel++) {
      assert.equal(bgra[pixel * 4 + 3], 255);
      bgra.copy(restored, pixel * 3, pixel * 4, pixel * 4 + 3);
    }
    const frameBytes = width * height * 3;
    const metrics = [], samples = [];
    const emissionBoundaries = new Set(batches.map(batch => batch.outputFirstFrame));
    const sampleIndices = new Set([0, 1, 5, 6, 10, 11, 14]);
    if (cutIndex !== undefined) for (const index of [cutIndex - 1, cutIndex, cutIndex + 1]) sampleIndices.add(index);
    for (let index = 0; index < frames.length; index++) {
      const part = data => data.subarray(index * frameBytes, (index + 1) * frameBytes);
      const row = {index, pts: pts[index], emissionBoundary: emissionBoundaries.has(index),
        ai: quality(part(restored), part(reference), width, height),
        lanczos: quality(part(control), part(reference), width, height)};
      if (index > 0) {
        const previous = data => data.subarray((index - 1) * frameBytes, index * frameBytes);
        row.ai.temporalError = temporalError(previous(restored), part(restored), previous(reference), part(reference));
        row.lanczos.temporalError = temporalError(previous(control), part(control), previous(reference), part(reference));
      }
      for (const values of [row.ai, row.lanczos]) assert.ok(Object.values(values).every(Number.isFinite));
      metrics.push(row);
      if (!sampleIndices.has(index)) continue;
      const sheet = Buffer.alloc(frameBytes * 3);
      for (let y = 0; y < height; y++) {
        for (const [column, data] of [control, restored, reference].entries()) {
          const offset = index * frameBytes + y * width * 3;
          data.copy(sheet, y * width * 9 + column * width * 3, offset, offset + width * 3);
        }
      }
      const raw = path.join(directory, `comparison-${index}.bgr`);
      const filename = path.join(directory, `comparison-${index}.png`);
      await fs.writeFile(raw, sheet);
      await command(['-f', 'rawvideo', '-pixel_format', 'bgr24', '-video_size', `${width * 3}x${height}`, '-i', raw, '-frames:v', '1', '-threads', '1', filename]);
      samples.push({index, filename, sha256: await hashFile(filename), columns: ['Lanczos', 'AI', 'reference']});
    }
    const record = {
      ...window, inputWidth, inputHeight, width, height, frameCount: frames.length,blocksToSwap:hardware.blocksToSwap,
      pts, absolutePts: frames.map(frame => frame.pts), batches, metrics, samples, diagnostics, hardware: ready.hardware,
      elapsedSeconds, timingScope: 'Includes model checks/loading, independent frame inference, transport batches and process shutdown. Current shared PC, not a controlled speed benchmark.',
      fixtureSha256: fixtures[window.fixture], inputSha256: hash(degraded), outputSha256: hash(bgra),
      referenceSha256: hash(reference), controlSha256: hash(control),
    };
    report.cases.push(record);
    await fs.writeFile(path.join(directory, 'results.json'), JSON.stringify(record, null, 2));
    await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(report, null, 2));
    assert.equal(await hashFile(fixture), fixtures[window.fixture]);
  }
  assert.equal((await validateBuildReceipt(workspace)).contentId, receipt.contentId);
  for (const [file, digest] of Object.entries(sourceHashes)) assert.equal(await hashFile(file), digest, `Source changed during quality review: ${file}`);
  await verifyEnhancementRuntime(installContext);
  assert.equal(await hashFile(path.join(runtime.runtimeRoot, '.complete.json')), report.runtimeRegistrySha256);
  report.passed = true;
  report.completedAt = new Date().toISOString();
} catch (error) {
  report.error = String(error);
  report.errorStack = error instanceof Error ? error.stack : undefined;
  process.exitCode = 1;
} finally {
  const serialized = JSON.stringify(report, null, 2) + '\n';
  await fs.writeFile(path.join(root, 'results.json'), serialized);
  await fs.writeFile(path.join(base, 'results.json'), serialized);
}
console.log(JSON.stringify({root, passed: report.passed, cases: report.cases.length, error: report.error}));
