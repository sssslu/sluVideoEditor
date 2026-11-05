import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BUILD_RECEIPT_PATH, captureBuildInputState, createBuildReceipt } from './build-receipt.mjs';
import { acquireBuildLock } from './build-lock.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let activeChild;
let cancellation;
let termination;
let lock;

async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(error => {
      if (child.exitCode === null && child.signalCode === null) throw error;
    });
  } else child.kill('SIGTERM');
}

const cancel = signal => {
  cancellation ||= signal;
  termination ||= stopChild(activeChild);
  termination.catch(() => {});
};
const interrupt = () => cancel('SIGINT');
const terminate = () => cancel('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);

async function run(entry, args = []) {
  if (cancellation) throw new Error(`Build cancelled by ${cancellation}`);
  const child = spawn(process.execPath, [path.join(workspace, entry), ...args], {
    cwd: workspace, windowsHide: true, shell: false, stdio: 'inherit',
    env: { ...process.env, SLU_BUILD_LOCK_TOKEN: lock.token },
  });
  activeChild = child;
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`${entry} stopped by ${signal}`));
      else resolve(code);
    });
  });
  completed.catch(() => {});
  let code;
  try {
    await lock.setChildPid(child.pid ?? null);
    code = await completed;
    await termination;
  } catch (error) {
    await stopChild(child);
    await completed.catch(() => {});
    throw error;
  } finally {
    activeChild = undefined;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) await lock.setChildPid(null);
  }
  if (cancellation) throw new Error(`Build cancelled by ${cancellation}`);
  if (code !== 0) {
    process.exitCode = code || 1;
    throw new Error(`${entry} exited with code ${code}`);
  }
}

try {
  lock = await acquireBuildLock(workspace);
  const before = await captureBuildInputState(workspace);
  await fs.unlink(path.join(workspace, BUILD_RECEIPT_PATH)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await run('node_modules/typescript/bin/tsc', ['--noEmit']);
  await run('node_modules/vite/bin/vite.js', ['build']);
  await run('scripts/build-main.mjs');
  const receipt = await createBuildReceipt(workspace, before);
  console.log(`Build receipt ${receipt.contentId} (${Object.keys(receipt.inputs).length} inputs, ${Object.keys(receipt.outputs).length} outputs)`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode ||= 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  try { await termination; } finally { await lock?.release(); }
}
