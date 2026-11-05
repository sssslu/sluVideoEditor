import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const BUILD_LOCK_DIRECTORY = '.build-cache/build-lock';

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function removeEmpty(directory) {
  await fs.rmdir(directory).catch(error => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  });
}

async function readOwner(directory) {
  const stat = await fs.lstat(directory);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Build lock must be a real directory');
  const entries = await fs.readdir(directory);
  if (entries.length === 0) return null;
  assert.equal(entries.length, 1, 'Build lock contains unexpected files');
  const filename = entries[0];
  const owner = JSON.parse(await fs.readFile(path.join(directory, filename), 'utf8'));
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string');
  assert.match(owner.token, /^[a-f0-9-]{36}$/);
  assert.equal(filename, `owner-${owner.pid}-${owner.token}.json`);
  assert.ok(owner.childPid === null || (Number.isSafeInteger(owner.childPid) && owner.childPid > 0));
  return { ...owner, filename };
}

export async function acquireBuildLock(workspace) {
  const directory = path.resolve(workspace, BUILD_LOCK_DIRECTORY);
  const parent = path.dirname(directory);
  await fs.mkdir(parent, { recursive: true });
  assert.ok(!(await fs.lstat(parent)).isSymbolicLink(), 'Build cache must be a real directory');
  const token = randomUUID();
  const filename = `owner-${process.pid}-${token}.json`;
  const candidate = `${directory}-${token}`;
  const owner = { pid: process.pid, token, childPid: null };
  await fs.mkdir(candidate);
  await fs.writeFile(path.join(candidate, filename), JSON.stringify(owner), { flag: 'wx' });
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        // A live lock always appears atomically with its unique owner file.
        await fs.rename(candidate, directory);
        acquired = true;
        break;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      }
      let existing;
      try { existing = await readOwner(directory); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (existing) {
        assert.ok(!processExists(existing.pid) && !(existing.childPid && processExists(existing.childPid)),
          `Another build owns the output directories (PID ${existing.pid}, child ${existing.childPid ?? 'none'})`);
        // Another recoverer can remove this exact dead owner first. A newly
        // acquired lock has a different filename and cannot be removed here.
        await fs.unlink(path.join(directory, existing.filename)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      await removeEmpty(directory);
    }
    assert.ok(acquired, 'Build lock changed repeatedly; retry after the other build finishes');
  } finally {
    if (!acquired) {
      await fs.unlink(path.join(candidate, filename)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await removeEmpty(candidate);
    }
  }
  return {
    token,
    async setChildPid(childPid) {
      assert.ok(childPid === null || (Number.isSafeInteger(childPid) && childPid > 0));
      owner.childPid = childPid;
      const temporary = path.join(parent, `${filename}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify(owner), { flag: 'wx' });
        await fs.rename(temporary, path.join(directory, filename));
      } finally {
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    },
    async release() {
      assert.ok(!owner.childPid || !processExists(owner.childPid), 'Cannot release build lock while its compiler is running');
      await fs.unlink(path.join(directory, filename)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await removeEmpty(directory);
    },
  };
}

export async function withBuildLock(workspace, action) {
  const token = process.env.SLU_BUILD_LOCK_TOKEN;
  if (token) {
    const owner = await readOwner(path.resolve(workspace, BUILD_LOCK_DIRECTORY));
    assert.ok(owner && owner.token === token && owner.pid === process.ppid && processExists(owner.pid), 'Inherited build lock is invalid');
    return action();
  }
  const lock = await acquireBuildLock(workspace);
  try { return await action(); } finally { await lock.release(); }
}
