import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const BUILD_RECEIPT_PATH = 'dist-electron/build-receipt.json';
const inputFiles = [
  'package.json', 'package-lock.json', 'index.html', 'caption-export.html',
  'vite.config.ts', 'tsconfig.json',
  'scripts/build.mjs', 'scripts/build-main.mjs', 'scripts/build-receipt.mjs', 'scripts/build-lock.mjs',
];
const inputDirectories = ['electron', 'shared', 'src', 'native/enhancement'];
const outputDirectories = ['dist', 'dist-electron'];
const requiredOutputs = [
  'dist/index.html', 'dist/caption-export.html',
  'dist-electron/main.cjs', 'dist-electron/preload.cjs',
  'dist-electron/caption-preload.cjs', 'dist-electron/tracking-worker.cjs',
  'dist-electron/matting-worker.cjs',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sortedMap = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));

function assertRelativeFile(file) {
  assert.equal(typeof file, 'string');
  assert.ok(file.length > 0 && !file.includes('\\') && !file.includes(':') && !path.posix.isAbsolute(file), `Invalid build path ${file}`);
  assert.ok(file.split('/').every(part => part && part !== '.' && part !== '..'), `Invalid build path ${file}`);
}

function assertHashMap(value, kind) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Missing build ${kind}`);
  const files = Object.keys(value);
  assert.ok(files.length > 0, `Empty build ${kind}`);
  assert.equal(new Set(files.map(file => file.toLowerCase())).size, files.length, `Duplicate build ${kind} paths`);
  for (const file of files) {
    assertRelativeFile(file);
    assert.match(value[file], /^[a-f0-9]{64}$/, `Invalid build hash ${file}`);
    if (kind === 'inputs') {
      assert.ok(inputFiles.includes(file) || [...inputDirectories, 'public'].some(directory => file.startsWith(`${directory}/`)), `Unexpected build input ${file}`);
    } else {
      assert.ok(outputDirectories.some(directory => file.startsWith(`${directory}/`)) && file !== BUILD_RECEIPT_PATH, `Unexpected build output ${file}`);
    }
  }
  for (const file of kind === 'inputs' ? inputFiles : requiredOutputs) assert.ok(Object.hasOwn(value, file), `Missing build ${kind} file ${file}`);
}

function contentId(receipt) {
  return sha256(JSON.stringify({
    schemaVersion: receipt.schemaVersion, version: receipt.version,
    runtimePackage: runtimePackage(receipt.runtimePackage),
    inputs: sortedMap(receipt.inputs), outputs: sortedMap(receipt.outputs),
  }));
}

function runtimePackage(pkg) {
  assert.ok(pkg && typeof pkg === 'object');
  assert.equal(typeof pkg.name, 'string');
  assert.ok(pkg.name.length > 0);
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assertRelativeFile(pkg.main);
  assert.ok(pkg.type === 'module' || pkg.type === 'commonjs');
  return { name: pkg.name, version: pkg.version, main: pkg.main, type: pkg.type };
}

export function validateReceiptData(receipt) {
  assert.ok(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'Missing build receipt');
  assert.deepEqual(Object.keys(receipt).sort(), ['contentId', 'inputs', 'outputs', 'runtimePackage', 'schemaVersion', 'version']);
  assert.equal(receipt.schemaVersion, 1, 'Unsupported build receipt schema');
  assert.match(receipt.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assertHashMap(receipt.inputs, 'inputs');
  assertHashMap(receipt.outputs, 'outputs');
  assert.deepEqual(receipt.runtimePackage, runtimePackage(receipt.runtimePackage));
  assert.equal(receipt.runtimePackage.version, receipt.version);
  assert.ok(Object.hasOwn(receipt.outputs, receipt.runtimePackage.main), 'Runtime entry point is missing from build outputs');
  assert.equal(receipt.contentId, contentId(receipt), 'Build receipt content ID differs');
  return receipt;
}

async function directoryFiles(workspace, directory, optional = false) {
  const absolute = path.join(workspace, directory);
  let stat;
  try { stat = await fs.lstat(absolute); } catch (error) {
    if (optional && error.code === 'ENOENT') return [];
    throw error;
  }
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `Build directory must be a real directory ${directory}`);
  const files = [];
  for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    assertRelativeFile(file);
    assert.ok(!entry.isSymbolicLink(), `Build inputs and outputs cannot contain links ${file}`);
    if (entry.isDirectory()) files.push(...await directoryFiles(workspace, file));
    else {
      assert.ok(entry.isFile(), `Build entry must be a regular file ${file}`);
      files.push(file);
    }
  }
  return files.sort();
}

async function fileMetadata(workspace, files) {
  const metadata = {};
  for (const file of files) {
    const stat = await fs.lstat(path.join(workspace, file), { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Build entry must be a regular file ${file}`);
    metadata[file] = Object.fromEntries(['size', 'mtimeNs', 'ctimeNs', 'ino', 'dev'].map(field => [field, String(stat[field])]));
  }
  return metadata;
}

async function inputPaths(workspace) {
  const files = [...inputFiles];
  for (const directory of inputDirectories) files.push(...await directoryFiles(workspace, directory));
  files.push(...await directoryFiles(workspace, 'public', true));
  return files.sort();
}

async function outputPaths(workspace) {
  const files = [];
  for (const directory of outputDirectories) files.push(...await directoryFiles(workspace, directory));
  return files.filter(file => file !== BUILD_RECEIPT_PATH).sort();
}

async function capture(workspace, paths, kind) {
  const files = await paths(workspace);
  const metadata = await fileMetadata(workspace, files);
  const hashes = {};
  for (const file of files) {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path.join(workspace, file))) digest.update(chunk);
    hashes[file] = digest.digest('hex');
  }
  assert.deepEqual(await paths(workspace), files, `Build ${kind} file set changed while hashing`);
  assert.deepEqual(await fileMetadata(workspace, files), metadata, `Build ${kind} changed while hashing`);
  assertHashMap(hashes, kind);
  return { hashes, metadata };
}

async function assertStateCurrent(workspace, paths, state, kind) {
  const files = await paths(workspace);
  assert.deepEqual(files, Object.keys(state.hashes), `Build ${kind} file set changed`);
  assert.deepEqual(await fileMetadata(workspace, files), state.metadata, `Build ${kind} metadata changed`);
}

export const captureBuildInputState = (workspace = process.cwd()) => capture(path.resolve(workspace), inputPaths, 'inputs');
export const captureBuildInputs = async (workspace = process.cwd()) => (await captureBuildInputState(workspace)).hashes;
export const captureBuildOutputs = async (workspace = process.cwd()) => (await capture(path.resolve(workspace), outputPaths, 'outputs')).hashes;

export async function readBuildReceipt(workspace = process.cwd()) {
  const bytes = await fs.readFile(path.join(workspace, BUILD_RECEIPT_PATH), 'utf8');
  return validateReceiptData(JSON.parse(bytes));
}

export async function validateBuildReceipt(workspace = process.cwd()) {
  const receipt = await readBuildReceipt(workspace);
  const inputs = await captureBuildInputState(workspace);
  assert.deepEqual(inputs.hashes, receipt.inputs, 'Build receipt does not match current source inputs');
  const outputs = await capture(workspace, outputPaths, 'outputs');
  assert.deepEqual(outputs.hashes, receipt.outputs, 'Build receipt does not match current output files');
  const pkg = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
  assert.deepEqual(runtimePackage(pkg), receipt.runtimePackage, 'Build receipt runtime package differs');
  await assertStateCurrent(workspace, inputPaths, inputs, 'inputs');
  await assertStateCurrent(workspace, outputPaths, outputs, 'outputs');
  assert.deepEqual(await readBuildReceipt(workspace), receipt, 'Build receipt changed during validation');
  return receipt;
}

export async function createBuildReceipt(workspace, beforeState) {
  assertHashMap(beforeState.hashes, 'inputs');
  assert.deepEqual(await captureBuildInputState(workspace), beforeState, 'Build source inputs changed during compilation');
  const outputs = await capture(workspace, outputPaths, 'outputs');
  const pkg = JSON.parse(await fs.readFile(path.join(workspace, 'package.json'), 'utf8'));
  const receipt = { schemaVersion: 1, version: pkg.version, runtimePackage: runtimePackage(pkg), inputs: sortedMap(beforeState.hashes), outputs: outputs.hashes, contentId: '' };
  receipt.contentId = contentId(receipt);
  validateReceiptData(receipt);
  await assertStateCurrent(workspace, inputPaths, beforeState, 'inputs');
  await assertStateCurrent(workspace, outputPaths, outputs, 'outputs');
  const target = path.join(workspace, BUILD_RECEIPT_PATH);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let published = false;
  try {
    await fs.writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, target);
    published = true;
    const validated = await validateBuildReceipt(workspace);
    await assertStateCurrent(workspace, inputPaths, beforeState, 'inputs');
    return validated;
  } catch (error) {
    if (published) await fs.unlink(target).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
    throw error;
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function validatePackagedBuild(asarFile, receipt) {
  validateReceiptData(receipt);
  const require = createRequire(import.meta.url);
  const asar = require('@electron/asar');
  const before = await fs.stat(asarFile);
  asar.uncache(asarFile);
  try {
    const packageStat = asar.statFile(asarFile, 'package.json', false);
    assert.ok(!('link' in packageStat) && !('files' in packageStat) && !packageStat.unpacked, 'Runtime package must be a regular ASAR file');
    const packaged = JSON.parse(asar.extractFile(asarFile, 'package.json').toString('utf8'));
    assert.deepEqual(runtimePackage(packaged), receipt.runtimePackage, 'Packaged runtime entry point or package identity differs');
    const files = [];
    for (const entry of asar.listPackage(asarFile)) {
      const file = entry.replaceAll('\\', '/').replace(/^\//, '');
      if (!outputDirectories.some(directory => file === directory || file.startsWith(`${directory}/`))) continue;
      const stat = asar.statFile(asarFile, path.normalize(file), false);
      assert.ok(!('link' in stat), `Packaged build contains a link ${file}`);
      if ('files' in stat) continue;
      assert.ok(!stat.unpacked, `Build output must be inside app.asar ${file}`);
      files.push(file);
    }
    assert.deepEqual(files.sort(), [...Object.keys(receipt.outputs), BUILD_RECEIPT_PATH].sort(), 'Packaged build output file set differs');
    const embedded = validateReceiptData(JSON.parse(asar.extractFile(asarFile, path.normalize(BUILD_RECEIPT_PATH)).toString('utf8')));
    assert.deepEqual(embedded, receipt, 'Packaged build receipt differs');
    for (const [file, digest] of Object.entries(receipt.outputs)) assert.equal(sha256(asar.extractFile(asarFile, path.normalize(file))), digest, `Packaged build output differs ${file}`);
    const after = await fs.stat(asarFile);
    for (const field of ['size', 'mtimeMs', 'ctimeMs', 'ino', 'dev']) assert.equal(after[field], before[field], 'ASAR changed during build validation');
    return embedded;
  } finally {
    asar.uncache(asarFile);
  }
}
