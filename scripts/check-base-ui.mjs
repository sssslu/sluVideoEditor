import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateBuildReceipt, validatePackagedBuild } from './build-receipt.mjs';

export const baseUISuites = [
  'e2e', 'e2e-additional', 'editor-v2', 'editor-boundaries', 'speed-curve',
  'stabilization-ui', 'stabilization-fidelity-ui', 'reverse-ui', 'job-locks-ui',
  'transitions-ui', 'transition-jobs', 'source-revision/ipc', 'source-async',
  'captions-ui', 'ipc-v2', 'color-ui', 'scopes-ui', 'audio-meter-ui', 'audio-eq-ui',
  'eq-continuity-ui', 'media-clock-ui', 'freeze-frame-ui', 'media-alpha-ui', 'color-range-ui',
];
const reportFiles = baseUISuites.map(name => `.test-artifacts/${name}/results.json`);
const codeExtensions = new Set(['.mjs', '.cjs', '.js', '.ts', '.mts', '.cts', '.tsx', '.py', '.ps1', '.html']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
export const baseUIEvidencePath = packaged => `.test-artifacts/base-ui-${packaged ? 'packaged' : 'source'}.json`;

async function fileMetadata(file) {
  try {
    const stat = await fs.stat(file, { bigint: true });
    assert.ok(stat.isFile(), `Expected a file: ${file}`);
    return [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino, stat.dev].map(String);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function codeInventory(workspace) {
  const files = [];
  async function visit(relative) {
    for (const item of await fs.readdir(path.join(workspace, relative), { withFileTypes: true })) {
      const file = `${relative}/${item.name}`;
      if (item.isDirectory() && item.name !== '__pycache__') await visit(file);
      else if (item.isFile() && codeExtensions.has(path.extname(item.name))) files.push(file);
    }
  }
  await visit('scripts');
  await visit('tests');
  return files.sort();
}

async function scriptSnapshot(workspace) {
  const files = await codeInventory(workspace);
  const metadata = {};
  for (const file of files) metadata[file] = await fileMetadata(path.join(workspace, file));
  const hashes = {};
  for (const file of files) hashes[file] = digest(await fs.readFile(path.join(workspace, file)));
  assert.deepEqual(await codeInventory(workspace), files, 'Test code inventory changed during capture');
  for (const file of files) assert.deepEqual(await fileMetadata(path.join(workspace, file)), metadata[file], `Test code changed during capture: ${file}`);
  return { hashes, metadata };
}

async function runtimeSnapshot(workspace, packaged, executable) {
  const receipt = await validateBuildReceipt(workspace);
  const runtimeExecutable = executable || path.join(workspace, 'node_modules/electron/dist/electron.exe');
  const exeSha256 = digest(await fs.readFile(runtimeExecutable));
  let asarSha256 = null;
  if (packaged) {
    const asar = path.join(path.dirname(executable), 'resources/app.asar');
    await validatePackagedBuild(asar, receipt);
    asarSha256 = digest(await fs.readFile(asar));
  }
  return { version: receipt.version, buildReceiptId: receipt.contentId, executable, runtimeExecutable, exeSha256, asarSha256 };
}

function checkReport(report, file, runtime) {
  assert.equal(report.version, runtime.version, `Wrong report version: ${file}`);
  assert.equal(report.executable, runtime.executable, `Wrong report executable: ${file}`);
  assert.deepEqual(report.errors, [], `UI errors in ${file}`);
  assert.ok(!report.findings?.length, `UI findings in ${file}`);
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0, `Missing checks in ${file}`);
}

export async function validateBaseUIEvidence({ packaged = false, workspace = process.cwd() } = {}) {
  workspace = path.resolve(workspace);
  const evidence = await readJSON(path.join(workspace, baseUIEvidencePath(packaged)));
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.mode, packaged ? 'packaged' : 'source');
  assert.equal(evidence.hidden, true);
  assert.equal(evidence.exitCode, 0);
  assert.ok(Number.isFinite(Date.parse(evidence.startedAt)) && Date.parse(evidence.completedAt) >= Date.parse(evidence.startedAt));
  const executable = packaged ? path.join(workspace, 'release/win-unpacked/SLU Studio.exe') : null;
  const runtime = await runtimeSnapshot(workspace, packaged, executable);
  for (const [key, value] of Object.entries(runtime)) assert.equal(evidence[key], value, `Base UI evidence changed: ${key}`);
  assert.deepEqual(evidence.scriptHashes, (await scriptSnapshot(workspace)).hashes, 'Base UI test code changed');
  assert.deepEqual(Object.keys(evidence.results).sort(), [...reportFiles].sort(), 'Base UI report set is incomplete');
  for (const file of reportFiles) {
    const bytes = await fs.readFile(path.join(workspace, file));
    assert.equal(digest(bytes), evidence.results[file], `Base UI report changed: ${file}`);
    checkReport(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), file, runtime);
  }
  assert.deepEqual(await runtimeSnapshot(workspace, packaged, executable), runtime, 'Build changed while validating base UI evidence');
  return evidence;
}

export async function runBaseUI({ packaged = false, workspace = process.cwd() } = {}) {
  workspace = path.resolve(workspace);
  const executable = packaged ? path.join(workspace, 'release/win-unpacked/SLU Studio.exe') : null;
  if (process.env.SLU_TEST_EXE) assert.equal(path.resolve(process.env.SLU_TEST_EXE), executable, 'SLU_TEST_EXE conflicts with base UI mode');
  const artifactRoot = path.join(workspace, '.test-artifacts/base-ui', packaged ? 'packaged' : 'source');
  await fs.mkdir(artifactRoot, { recursive: true });
  const runDirectory = await fs.mkdtemp(path.join(artifactRoot, 'run-'));
  const canonical = path.join(workspace, baseUIEvidencePath(packaged));
  await fs.unlink(canonical).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const startedAt = new Date().toISOString();
  const runtime = await runtimeSnapshot(workspace, packaged, executable);
  const scripts = await scriptSnapshot(workspace);
  const beforeReports = {};
  for (const file of reportFiles) beforeReports[file] = await fileMetadata(path.join(workspace, file));
  const args = ['run', ...(packaged ? ['--ignore-scripts'] : []), 'test:e2e'];
  const npmCLI = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  await fs.access(npmCLI);
  await fs.writeFile(path.join(runDirectory, 'before.json'), JSON.stringify({ startedAt, ...runtime, scripts, beforeReports, args }, null, 2));
  const env = { ...process.env, SLU_TEST_BACKGROUND: '1' };
  if (packaged) env.SLU_TEST_EXE = executable;
  else delete env.SLU_TEST_EXE;
  let child;
  let cancellation;
  let termination;
  const stop = signal => {
    cancellation ||= signal;
    if (child?.pid && child.exitCode === null && child.signalCode === null && !termination) {
      termination = process.platform === 'win32'
        ? promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(error => {
          if (child.exitCode === null && child.signalCode === null) throw error;
        })
        : Promise.resolve(child.kill('SIGTERM'));
      termination.catch(() => {});
    }
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    child = spawn(process.execPath, [npmCLI, ...args], { cwd: workspace, env, windowsHide: true, shell: false, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => signal ? reject(new Error(`Base UI stopped by ${signal}`)) : resolve(exitCode));
    });
    await termination;
    assert.ok(!cancellation, `Base UI cancelled by ${cancellation}`);
    if (code !== 0) {
      process.exitCode = code || 1;
      throw new Error(`Base UI suite exited with code ${code}`);
    }
    assert.deepEqual(await runtimeSnapshot(workspace, packaged, executable), runtime, 'Build changed during base UI suite');
    assert.deepEqual(await scriptSnapshot(workspace), scripts, 'Test code changed during base UI suite');
    const results = {};
    let checks = 0;
    for (const file of reportFiles) {
      const full = path.join(workspace, file);
      const metadata = await fileMetadata(full);
      assert.ok(metadata, `Missing base UI report: ${file}`);
      assert.notDeepEqual(metadata, beforeReports[file], `Base UI report was not rewritten by this run: ${file}`);
      const bytes = await fs.readFile(full);
      assert.deepEqual(await fileMetadata(full), metadata, `Base UI report changed while reading: ${file}`);
      const report = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
      checkReport(report, file, runtime);
      results[file] = digest(bytes);
      checks += report.checks.length;
    }
    const evidence = { schemaVersion: 1, mode: packaged ? 'packaged' : 'source', hidden: true, startedAt, completedAt: new Date().toISOString(), ...runtime, scriptHashes: scripts.hashes, results, checks, exitCode: 0, runDirectory };
    const text = JSON.stringify(evidence, null, 2) + '\n';
    await fs.writeFile(path.join(runDirectory, 'results.json'), text);
    const temporary = path.join(runDirectory, 'publish.json');
    await fs.writeFile(temporary, text);
    await fs.rename(temporary, canonical);
    await validateBaseUIEvidence({ packaged, workspace });
    console.log(JSON.stringify({ mode: evidence.mode, buildReceiptId: evidence.buildReceiptId, suites: reportFiles.length, checks, evidence: canonical }));
    return evidence;
  } catch (error) {
    await fs.unlink(canonical).catch(unlinkError => { if (unlinkError.code !== 'ENOENT') throw unlinkError; });
    await fs.writeFile(path.join(runDirectory, 'failure.json'), JSON.stringify({ startedAt, ...runtime, error: String(error) }, null, 2));
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    await termination;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.slice(2).every(argument => argument === '--packaged'), 'Only --packaged is supported');
    await runBaseUI({ packaged: process.argv.includes('--packaged') });
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode ||= 1;
  }
}
