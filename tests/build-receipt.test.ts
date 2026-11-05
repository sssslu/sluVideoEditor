import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const receiptTools = await import(new URL('../scripts/build-receipt.mjs', import.meta.url).href);
const lockTools = await import(new URL('../scripts/build-lock.mjs', import.meta.url).href);
const { captureBuildInputs, captureBuildInputState, createBuildReceipt, validateBuildReceipt, validatePackagedBuild } = receiptTools;
const { acquireBuildLock, BUILD_LOCK_DIRECTORY } = lockTools;
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const root = path.resolve('.test-artifacts/build-receipt-tests');
const inputs = ['index.html', 'caption-export.html', 'package-lock.json', 'vite.config.ts', 'tsconfig.json',
  'scripts/build.mjs', 'scripts/build-main.mjs', 'scripts/build-receipt.mjs', 'scripts/build-lock.mjs',
  'electron/early.ts', 'shared/project.ts', 'src/App.tsx', 'src/assets/fonts/test.ttf', 'native/enhancement/seedvr_worker.py'];
const outputs = ['dist/index.html', 'dist/caption-export.html', 'dist/assets/editor.js', 'dist/assets/editor.css',
  'dist-electron/main.cjs', 'dist-electron/preload.cjs', 'dist-electron/caption-preload.cjs',
  'dist-electron/tracking-worker.cjs', 'dist-electron/matting-worker.cjs'];
const pkg = { name: 'fixture-editor', version: '1.10.0-dev.1', main: 'dist-electron/main.cjs', type: 'module', scripts: { build: 'fixture' } };

async function write(directory: string, file: string, data: string) {
  const target = path.join(directory, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
}

async function fixture() {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'run-'));
  for (const file of [...inputs, ...outputs]) await write(directory, file, `fixture ${file}\n`);
  await write(directory, 'package.json', JSON.stringify(pkg));
  return directory;
}

async function receipt(directory: string) {
  return createBuildReceipt(directory, await captureBuildInputState(directory));
}

async function archive(directory: string, packageData: object = pkg) {
  const staging = path.join(directory, `package-${randomUUID()}`);
  await fs.mkdir(staging);
  for (const name of ['dist', 'dist-electron']) await fs.cp(path.join(directory, name), path.join(staging, name), { recursive: true });
  await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify(packageData));
  const filename = path.join(directory, `${randomUUID()}.asar`);
  await asar.createPackage(staging, filename);
  return filename;
}

test('build receipts are deterministic and validate complete source/output inventories', async () => {
  const directory = await fixture();
  const first = await receipt(directory);
  assert.deepEqual(await validateBuildReceipt(directory), first);
  const file = path.join(directory, 'src/App.tsx');
  await fs.utimes(file, new Date(), new Date(Date.now() + 1000));
  assert.equal((await receipt(directory)).contentId, first.contentId);
  assert.deepEqual(first.runtimePackage, { name: pkg.name, version: pkg.version, main: pkg.main, type: pkg.type });
});

test('source changes and edit-then-restore during compilation reject receipt publication', async () => {
  for (const restore of [false, true]) {
    const directory = await fixture();
    const before = await captureBuildInputState(directory);
    const file = path.join(directory, 'electron/early.ts');
    const original = await fs.readFile(file);
    await fs.writeFile(file, 'changed during compilation');
    if (restore) await fs.writeFile(file, original);
    await fs.utimes(file, new Date(), new Date(Date.now() + 2000));
    await assert.rejects(() => createBuildReceipt(directory, before), /changed during compilation/);
    await assert.rejects(() => fs.stat(path.join(directory, receiptTools.BUILD_RECEIPT_PATH)), { code: 'ENOENT' });
  }
});

test('whole-inventory metadata catches changes after a source file was hashed', async context => {
  const directory = await fixture();
  const readdir = fs.readdir;
  let sourceVisits = 0;
  context.mock.method(fs, 'readdir', async (target: string, ...options: unknown[]) => {
    const result = await Reflect.apply(readdir, fs, [target, ...options]);
    if (String(target) === path.join(directory, 'src') && ++sourceVisits === 2) await write(directory, 'electron/early.ts', 'modified after its hash');
    return result;
  });
  await assert.rejects(() => captureBuildInputs(directory), /changed while hashing/);
});

test('receipt validation rechecks source metadata after reading output files', async context => {
  const directory = await fixture();
  await receipt(directory);
  const readdir = fs.readdir;
  let changed = false;
  context.mock.method(fs, 'readdir', async (target: string, ...options: unknown[]) => {
    const result = await Reflect.apply(readdir, fs, [target, ...options]);
    if (!changed && String(target) === path.join(directory, 'dist')) {
      changed = true;
      await write(directory, 'electron/early.ts', 'late input mutation');
    }
    return result;
  });
  await assert.rejects(() => validateBuildReceipt(directory), /inputs metadata changed/);
});

test('stale source, tampered outputs and extra/missing files reject receipts', async () => {
  for (const kind of ['source', 'output', 'extra', 'missing']) {
    const directory = await fixture();
    await receipt(directory);
    if (kind === 'source') await write(directory, 'src/App.tsx', 'new source with stale dist');
    if (kind === 'output') await write(directory, 'dist/assets/editor.js', 'tampered output');
    if (kind === 'extra') await write(directory, 'dist/assets/unrecorded.js', 'extra');
    if (kind === 'missing') await fs.unlink(path.join(directory, 'dist/assets/editor.css'));
    await assert.rejects(() => validateBuildReceipt(directory), /does not match/);
  }
});

test('ASAR binding accepts builder metadata rewrites and rejects runtime package field changes', async () => {
  const directory = await fixture();
  const current = await receipt(directory);
  const runtime = current.runtimePackage;
  await validatePackagedBuild(await archive(directory, { ...runtime, description: 'builder metadata', dependencies: {} }), current);
  for (const change of [{ main: 'dist/assets/editor.js' }, { type: 'commonjs' }, { name: 'other-editor' }, { version: '1.9.0' }]) {
    const filename = await archive(directory, { ...runtime, ...change });
    await assert.rejects(() => validatePackagedBuild(filename, current), /runtime entry point or package identity differs/);
  }
});

test('ASAR binding rejects modified artifacts and extra/missing compiled files', async () => {
  for (const kind of ['changed', 'extra', 'missing']) {
    const directory = await fixture();
    const current = await receipt(directory);
    if (kind === 'changed') await write(directory, 'dist-electron/main.cjs', 'different main');
    if (kind === 'extra') await write(directory, 'dist/assets/extra.js', 'extra');
    if (kind === 'missing') await fs.unlink(path.join(directory, 'dist/assets/editor.css'));
    await assert.rejects(async () => validatePackagedBuild(await archive(directory), current), /Packaged build output/);
  }
});

test('exclusive build lock rejects another live writer and releases cleanly', async () => {
  const directory = await fixture();
  const first = await acquireBuildLock(directory);
  try { await assert.rejects(() => acquireBuildLock(directory), /Another build owns/); } finally { await first.release(); }
  const next = await acquireBuildLock(directory);
  await next.release();
});

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'exit');
  return child.pid!;
}

async function staleLock(directory: string, pid: number, childPid: number | null = null) {
  const token = randomUUID();
  await write(directory, `${BUILD_LOCK_DIRECTORY}/owner-${pid}-${token}.json`, JSON.stringify({ pid, token, childPid }));
}

test('simultaneous stale-lock recovery admits only one writer', async () => {
  const directory = await fixture();
  await staleLock(directory, await deadPid());
  const attempts = await Promise.allSettled([acquireBuildLock(directory), acquireBuildLock(directory)]);
  const winners = attempts.filter(result => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  for (const winner of winners) if (winner.status === 'fulfilled') await winner.value.release();
});

test('stale parent lock is retained while its recorded compiler remains alive', async () => {
  const directory = await fixture();
  const exited = await deadPid();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const finished = once(child, 'exit');
  try {
    await staleLock(directory, exited, child.pid!);
    await assert.rejects(() => acquireBuildLock(directory), /Another build owns/);
  } finally { child.kill(); await finished; }
  const recovered = await acquireBuildLock(directory);
  await recovered.release();
});

async function wrapperFixture(tsc: string) {
  const directory = await fixture();
  for (const file of ['scripts/build.mjs', 'scripts/build-receipt.mjs', 'scripts/build-lock.mjs']) await fs.copyFile(file, path.join(directory, file));
  await write(directory, 'scripts/build-main.mjs', '// isolated compiler stub\n');
  await write(directory, 'node_modules/typescript/bin/tsc', tsc);
  await write(directory, 'node_modules/vite/bin/vite.js', '// isolated renderer stub\n');
  return directory;
}

function runWrapper(directory: string) {
  const env = { ...process.env };
  delete env.SLU_BUILD_LOCK_TOKEN;
  const child = spawn(process.execPath, [path.join(directory, 'scripts/build.mjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; });
  child.stderr.on('data', chunk => { text += chunk; });
  return { child, done: once(child, 'close').then(([code]) => ({ code, text })) };
}

test('build wrapper propagates compiler failure and removes the prior receipt', async () => {
  const directory = await wrapperFixture('process.exit(7);');
  await write(directory, receiptTools.BUILD_RECEIPT_PATH, 'prior receipt');
  const result = await runWrapper(directory).done;
  assert.equal(result.code, 7, result.text);
  await assert.rejects(() => fs.stat(path.join(directory, receiptTools.BUILD_RECEIPT_PATH)), { code: 'ENOENT' });
  await assert.rejects(() => fs.stat(path.join(directory, BUILD_LOCK_DIRECTORY)), { code: 'ENOENT' });
});

test('build wrapper detects source edit-and-restore inside a compiler invocation', async () => {
  const directory = await wrapperFixture("const fs=require('node:fs');const file='src/App.tsx';const bytes=fs.readFileSync(file);fs.writeFileSync(file,'temporary source');fs.writeFileSync(file,bytes);fs.utimesSync(file,new Date(),new Date(Date.now()+2000));");
  const result = await runWrapper(directory).done;
  assert.equal(result.code, 1, result.text);
  assert.match(result.text, /changed during compilation/);
  await assert.rejects(() => fs.stat(path.join(directory, receiptTools.BUILD_RECEIPT_PATH)), { code: 'ENOENT' });
});

test('two isolated wrapper processes cannot overlap their compiler writes', async () => {
  const directory = await wrapperFixture("require('node:fs').writeFileSync('compiler-started','yes');setTimeout(()=>{},1000);");
  const first = runWrapper(directory);
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await fs.stat(path.join(directory, 'compiler-started')).then(() => true, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(await fs.stat(path.join(directory, 'compiler-started')));
  const second = await runWrapper(directory).done;
  assert.equal(second.code, 1, second.text);
  assert.match(second.text, /Another build owns/);
  const completed = await first.done;
  assert.equal(completed.code, 0, completed.text);
  await validateBuildReceipt(directory);
});
