import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MattingProcess } from '../electron/matting-process';
import { mattingRatio } from '../electron/matting-model';
import { decodeTrackingFrames } from '../electron/tracking-decode';
import { prepareTrackingInput } from '../electron/tracking-source';
import { verifyVideoSelection } from '../electron/video-selection';
import { requireSourceRevision } from '../electron/source-revision';
import { probeMedia, runProcess, type EngineContext } from '../electron/media';

interface QualityWindow {
  name: string;
  fixture: string;
  start: number;
  duration: number;
  quality: 'portrait' | 'fullbody';
  captureTimes: number[];
  knownCut?: number;
}
interface Coverage {
  transparentFraction: number;
  opaqueFraction: number;
  softFraction: number;
  meanAlpha: number;
  minAlpha: number;
  maxAlpha: number;
  meanAlphaChange?: number;
}
interface FrameRecord {
  index: number;
  pts: number;
  sourceTime: number;
  originalSha256: string;
  bgraSha256: string;
  coverage: Coverage;
}

const root = path.resolve(process.env.SLU_MATTING_QUALITY_ROOT!);
const abort = new AbortController();
const sessions = new Set<MattingProcess>();
const owned = new Set<number>();
const diagnostics: Record<string, unknown>[] = [];
const checks: string[] = [];
const cases: Record<string, any>[] = [];
let phase = 'starting';
let totalFrames = 0;
const deadline = setTimeout(() => abort.abort(), 15 * 60 * 1000);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const record = (event: Record<string, unknown>) => {
  if (typeof event.pid === 'number') owned.add(event.pid);
  if (event.event !== 'matting-frame-timing') diagnostics.push(event);
};
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(root, 'profile'));

function coverage(data: Uint8Array, previous?: Uint8Array): { value: Coverage; alpha: Uint8Array } {
  const pixels = data.length / 4;
  const alpha = new Uint8Array(pixels);
  let transparent = 0, opaque = 0, sum = 0, minimum = 255, maximum = 0, change = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    const value = data[pixel * 4 + 3];
    alpha[pixel] = value;
    if (value === 0) transparent++;
    if (value === 255) opaque++;
    sum += value;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    if (previous) change += Math.abs(previous[pixel] - value);
  }
  const value: Coverage = {
    transparentFraction: transparent / pixels,
    opaqueFraction: opaque / pixels,
    softFraction: (pixels - transparent - opaque) / pixels,
    meanAlpha: sum / (pixels * 255), minAlpha: minimum, maxAlpha: maximum,
    ...(previous ? { meanAlphaChange: change / (pixels * 255) } : {}),
  };
  assert.ok(Object.values(value).every(Number.isFinite));
  return { value, alpha };
}

async function saveContact(
  directory: string, index: number, width: number, height: number,
  original: Uint8Array, bgra: Uint8Array, context: EngineContext,
) {
  const sheetWidth = width * 2;
  const sheet = Buffer.alloc(width * height * 12);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const a = bgra[pixel * 4 + 3];
      const top = (y * sheetWidth + x) * 3;
      const bottom = ((y + height) * sheetWidth + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        const foreground = bgra[pixel * 4 + channel];
        sheet[top + channel] = original[pixel * 3 + channel];
        sheet[top + width * 3 + channel] = a;
        sheet[bottom + channel] = Math.round((foreground * a + 255 * (255 - a)) / 255);
        sheet[bottom + width * 3 + channel] = Math.round(foreground * a / 255);
      }
    }
  }
  const stem = `frame-${String(index).padStart(3, '0')}`;
  const raw = path.join(directory, `${stem}.bgr`);
  const image = path.join(directory, `${stem}.png`);
  await fs.writeFile(raw, sheet);
  try {
    await runProcess(context.ffmpeg, [
      '-v', 'error', '-nostdin', '-y', '-threads', '1',
      '-f', 'rawvideo', '-pixel_format', 'bgr24', '-video_size', `${sheetWidth}x${height * 2}`,
      '-i', raw, '-frames:v', '1', '-threads', '1', '-compression_level', '3', image,
    ], { signal: abort.signal, timeoutMs: 60000, onSpawn: pid => record({ event: 'contact-encoder-start', pid }) });
  } finally {
    await fs.unlink(raw);
  }
  return { file: image, sha256: sha(await fs.readFile(image)) };
}

async function assertOwnedExited() {
  for (const pid of owned) {
    let live = true;
    for (let attempt = 0; attempt < 20 && live; attempt++) {
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        live = false;
      }
      if (live) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(live, false, `Owned process ${pid} survived`);
  }
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.backend, 'cpu');
  assert.equal(manifest.maximumFrames, 250);
  await app.whenReady();
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  const context: EngineContext = {
    ffmpeg: manifest.ffmpeg.file, ffprobe: manifest.ffprobe.file,
    cacheDir: path.join(root, 'cache'), gpuProcessing: false, diagnostics: record,
  };
  for (const window of manifest.windows as QualityWindow[]) {
    phase = window.name;
    const fixture = manifest.fixtures.find((item: { name: string }) => item.name === window.fixture);
    assert.ok(fixture);
    const directory = path.join(root, window.name);
    await fs.mkdir(directory);
    const media = await probeMedia(fixture.file, context, abort.signal, { derivatives: false });
    const source = await prepareTrackingInput(media, 4096, context, abort.signal);
    const selection = await verifyVideoSelection({ ...source.plan, revision: source.revision, probe: source.probe }, window.start, window.duration, context, abort.signal);
    assert.equal(source.hasAlpha, false);
    const engine = await MattingProcess.create({
      modelPath: manifest.modelPath, workerPath: manifest.workerPath,
      backend: 'cpu', quality: window.quality, signal: abort.signal, diagnostics: record,
    });
    sessions.add(engine);
    const frames: FrameRecord[] = [];
    const samples: Record<string, unknown>[] = [];
    const targets = window.captureTimes.map(time => Math.round((source.plan.origin + time) * 1e6));
    let target = 0;
    let previousAlpha: Uint8Array | undefined;
    try {
      for await (const frame of decodeTrackingFrames(source.plan, selection.firstPts, selection.endPts, context, abort.signal)) {
        assert.ok(totalFrames < manifest.maximumFrames, 'Native frame budget exceeded');
        assert.equal(frame.width, frame.sourceWidth);
        assert.equal(frame.height, frame.sourceHeight);
        assert.equal(frame.width, 1920);
        assert.equal(frame.height, 1080);
        const result = await engine.process(frame, frame.pts);
        assert.equal(result.backend, 'cpu');
        assert.equal(result.data.length, frame.width * frame.height * 4);
        const alpha = coverage(result.data, previousAlpha);
        previousAlpha = alpha.alpha;
        const entry: FrameRecord = {
          index: frames.length, pts: frame.pts, sourceTime: frame.pts / 1e6 - source.plan.origin,
          originalSha256: sha(frame.data), bgraSha256: sha(result.data), coverage: alpha.value,
        };
        frames.push(entry);
        totalFrames++;
        if (entry.index === 0 || (target < targets.length && frame.pts >= targets[target])) {
          const sample = await saveContact(directory, entry.index, frame.width, frame.height, frame.data, result.data, context);
          samples.push({ index: entry.index, pts: entry.pts, sourceTime: entry.sourceTime, ...sample });
          do { target++; } while (target < targets.length && frame.pts >= targets[target]);
        }
        await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify({ phase, totalFrames, windowFrames: frames.length, pts: frame.pts }));
      }
    } finally {
      await engine.close();
      sessions.delete(engine);
    }
    await requireSourceRevision(media.path, source.revision);
    assert.ok(frames.length > 0);
    assert.equal(target, targets.length, 'Missing requested review sample');
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    const report = {
      ...window, nativeWidth: 1920, nativeHeight: 1080,
      modelRatio: mattingRatio(1920, 1080, window.quality), selection,
      resetAtWindowStart: true, resetAtSceneCut: false, frames, samples,
    };
    cases.push(report);
    await fs.writeFile(path.join(directory, 'frames.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (manifest.comparison) {
    const previousBytes = await fs.readFile(manifest.comparison.resultsFile);
    assert.equal(sha(previousBytes), manifest.comparison.sha256);
    const previous = JSON.parse(previousBytes.toString('utf8'));
    const portrait = previous.cases.find((item: { name: string }) => item.name === manifest.comparison.caseName);
    assert.ok(portrait);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].name, 'hair-fullbody');
    assert.deepEqual(
      portrait.frames.map((frame: FrameRecord) => [frame.pts, frame.originalSha256]),
      cases[0].frames.map((frame: FrameRecord) => [frame.pts, frame.originalSha256]),
    );
    checks.push('Hair precision comparison received identical native pixels and presentation times as the preserved portrait run');
  } else {
    const portrait = cases.find(item => item.name === 'dance-portrait')!;
    const fullbody = cases.find(item => item.name === 'dance-fullbody')!;
    assert.deepEqual(
      portrait.frames.map((frame: FrameRecord) => [frame.pts, frame.originalSha256]),
      fullbody.frames.map((frame: FrameRecord) => [frame.pts, frame.originalSha256]),
    );
    checks.push('Portrait and full-body dance runs received identical native pixels and presentation times');
  }
  checks.push('Every requested native frame completed sequentially on explicit CPU with validated output dimensions and finite coverage values');
  checks.push('All accepted frames passed the production model checks for finite pixels and recurrent state');
  assert.equal(sessions.size, 0);
  await assertOwnedExited();
  checks.push('All tracked workers, decoders and image encoders exited');
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  checks.push('No Electron BrowserWindow was created');
  clearTimeout(deadline);
  const report = {
    version: manifest.version, root, scope: manifest.scope, distribution: manifest.distribution,
    totalFrames, backend: 'cpu', modelSha256: manifest.modelSha256, workerSha256: manifest.workerSha256,
    nativeThreadBounds: { ortIntraOpMaximum: 4, ortInterOp: 1, decoder: 2, decoderFilter: 1, contactEncoder: 1 },
    panels: ['top-left original', 'top-right alpha', 'bottom-left on white', 'bottom-right on black'],
    sampleResolution: 'Each panel retains the native 1920x1080 frame dimensions',
    limitations: 'No independent ground-truth alpha, aesthetic pass threshold, subject selection or substantial occluder sequence. Twelve source contact samples established coverage. Model quality still requires inspection of the saved output images.',
    cases, checks, diagnostics, hidden: true,
  };
  await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.writeFile(path.join(root, 'progress.json'), JSON.stringify({ phase: 'complete', totalFrames }));
  app.exit(0);
}

void main().catch(async error => {
  clearTimeout(deadline);
  abort.abort();
  await Promise.allSettled([...sessions].map(session => session.close()));
  let cleanupError: string | undefined;
  try { await assertOwnedExited(); } catch (failure) { cleanupError = String(failure); }
  await fs.writeFile(path.join(root, 'failure.json'), JSON.stringify({
    phase, totalFrames, error: error instanceof Error ? error.stack : String(error),
    cleanupError, cases, diagnostics,
  }, null, 2) + '\n');
  app.exit(1);
});
