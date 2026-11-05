import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import electron from 'electron';

// Public author-linked footage is an external development input. This runner
// never downloads files. Footage and review images stay outside release inputs.
const fixtureRoot = path.resolve('.build-cache/matting/quality');
const fixtures = [
  { name: 'priyanka.mp4', id: '1T33YN13JcioT6oMVHSJNMKjwWdpp5qhZ', bytes: 4668628, sha256: '3b6cba90151767bc2c5369b0e280fe5b5f19dd06f0acbcea7e325d75a6056b34' },
  { name: 'dance2.mp4', id: '1cIMrgIZgT3yYZ9YcEXSa-CSblQBhm4cE', bytes: 4636787, sha256: 'c32b6753b6292657a3c9ca7a15b7052b2f6f53b5ff3f6db71d8b2b1edcaaf977' },
  { name: 'tryguys.mp4', id: '1SXRTrWJgTPptg7P6tsJNQ9zTf4X0qqUo', bytes: 2763654, sha256: 'cba1a4a0c1c24ef77d16b9729518413a0fa560fe9f6a74482d7d275e14c13023' },
];
const standardWindows = [
  { name: 'hair-portrait', fixture: 'priyanka.mp4', start: 6, duration: 1.5, quality: 'portrait', captureTimes: [6, 6.5, 7, 7.45] },
  { name: 'dance-portrait', fixture: 'dance2.mp4', start: 3.5, duration: 1.5, quality: 'portrait', captureTimes: [3.5, 4, 4.5, 4.95] },
  { name: 'dance-fullbody', fixture: 'dance2.mp4', start: 3.5, duration: 1.5, quality: 'fullbody', captureTimes: [3.5, 4, 4.5, 4.95] },
  { name: 'people-cut', fixture: 'tryguys.mp4', start: 2.1, duration: 1.5, quality: 'portrait', captureTimes: [2.1, 2.669333, 2.711042, 2.75275, 3.55], knownCut: 2.711042 },
];
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--hair-fullbody-comparison'),
  'Usage: node scripts/check-matting-quality.mjs [--hair-fullbody-comparison prior-run-directory]');
const windows = args.length === 0 ? standardWindows : [
  { ...standardWindows[0], name: 'hair-fullbody', quality: 'fullbody' },
];
const hash = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const modelPath = path.resolve('resources/models/person-matting-rvm.onnx');
const workerPath = path.resolve('dist-electron/matting-worker.cjs');
const modelSha256 = '88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828';

for (const fixture of fixtures) {
  fixture.file = path.join(fixtureRoot, fixture.name);
  fixture.source = `https://drive.google.com/file/d/${fixture.id}/view`;
  assert.equal((await fs.stat(fixture.file)).size, fixture.bytes, fixture.name);
  assert.equal(await hash(fixture.file), fixture.sha256, fixture.name);
}
assert.equal((await fs.stat(modelPath)).size, 14975696);
assert.equal(await hash(modelPath), modelSha256);
const workerSha256 = await hash(workerPath);
let comparison;
if (args.length > 0) {
  const resultsFile = path.resolve(args[1], 'results.json');
  const previous = JSON.parse(await fs.readFile(resultsFile, 'utf8'));
  assert.equal(previous.modelSha256, modelSha256, 'Comparison model differs');
  assert.equal(previous.workerSha256, workerSha256, 'Comparison worker differs');
  assert.equal(previous.backend, 'cpu');
  assert.ok(previous.cases.some(item => item.name === 'hair-portrait'));
  comparison = { resultsFile, sha256: await hash(resultsFile), caseName: 'hair-portrait' };
}
const base = path.resolve('.test-artifacts/matting-quality');
await fs.mkdir(base, { recursive: true });
const root = await fs.mkdtemp(path.join(base, 'run-'));
const host = path.join(root, 'host.cjs');
const built = await build({
  entryPoints: ['scripts/matting-quality-check.ts'], outfile: host,
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron', 'onnxruntime-node'], metafile: true,
});
const sourceFiles = [...new Set([
  'scripts/check-matting-quality.mjs', 'package.json', 'package-lock.json',
  'electron/matting-worker.ts', 'electron/matting-model.ts',
  ...Object.values(built.metafile.outputs).flatMap(output => Object.entries(output.inputs)
    .filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file)),
])].sort();
const sources = {};
for (const file of sourceFiles) sources[file] = await hash(file);
const manifest = {
  version: JSON.parse(await fs.readFile('package.json', 'utf8')).version,
  createdAt: new Date().toISOString(), root, fixtures, windows, comparison,
  maximumFrames: 250, backend: 'cpu', modelPath, modelSha256, workerPath, workerSha256,
  hostSha256: await hash(host), sources,
  ffmpeg: { file: path.resolve('resources/bin/ffmpeg.exe'), sha256: await hash('resources/bin/ffmpeg.exe') },
  ffprobe: { file: path.resolve('resources/bin/ffprobe.exe'), sha256: await hash('resources/bin/ffprobe.exe') },
  provenance: {
    authorLink: 'https://github.com/PeterL1n/RobustVideoMatting/blob/53d74c6826735f01f4406b5ca9075eee27bec094/README.md#showreel',
    folder: 'https://drive.google.com/drive/folders/1VFnWwuu-YXDKG-N6vcjK_nL7YZMFapMU',
    rights: 'Author-linked public examples. No separate footage redistribution license was found in the author README, project page or folder listing. Repository code licensing does not establish footage rights.',
  },
  scope: 'CPU-only native-frame model review. Independent state per window, sequential state within each window including the known cut. No editor, GPU, export pipeline, packaged EXE, performance benchmark or independent ground-truth alpha evaluation.',
  distribution: 'Development footage and derived images are excluded from application, installer, source ZIP and release evidence archives.',
};
await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await fs.writeFile(path.join(base, 'current.txt'), root);
const env = { ...process.env, SLU_MATTING_QUALITY_ROOT: root, SLU_TEST_BACKGROUND: '1' };
delete env.ELECTRON_RUN_AS_NODE;
try {
  await promisify(execFile)(electron, [host, '--no-first-run', '--disable-gpu'], {
    env, windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 2 * 1024 * 1024,
  });
  const results = JSON.parse(await fs.readFile(path.join(root, 'results.json'), 'utf8'));
  assert.equal(await hash(host), manifest.hostSha256, 'Preserved host bundle changed during review');
  assert.equal(await hash(workerPath), workerSha256, 'Worker changed during review');
  assert.equal(await hash(modelPath), modelSha256, 'Model changed during review');
  assert.equal(await hash(manifest.ffmpeg.file), manifest.ffmpeg.sha256, 'Decoder changed during review');
  assert.equal(await hash(manifest.ffprobe.file), manifest.ffprobe.sha256, 'Probe changed during review');
  if (comparison) assert.equal(await hash(comparison.resultsFile), comparison.sha256, 'Comparison evidence changed');
  for (const fixture of fixtures) assert.equal(await hash(fixture.file), fixture.sha256, fixture.name);
  const changedSources = [];
  for (const file of sourceFiles) if (await hash(file) !== sources[file]) changedSources.push(file);
  await fs.writeFile(path.join(root, 'source-stability.json'), JSON.stringify({ changedSources }, null, 2) + '\n');
  assert.deepEqual(changedSources, [], 'Executed source dependencies changed during review');
  console.log(JSON.stringify({ root, frames: results.totalFrames, samples: results.cases.reduce((sum, item) => sum + item.samples.length, 0), checks: results.checks, changedSources }));
} catch (error) {
  const failure = await fs.readFile(path.join(root, 'failure.json'), 'utf8').catch(() => String(error));
  console.error(failure);
  process.exitCode = 1;
}
