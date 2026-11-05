import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assertOutputNotSource} from '../electron/file-policy';
test('output source protection resolves directory aliases instead of comparing spelling only',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'slu-path-')),original=path.join(root,'original'),alias=path.join(root,'alias');await mkdir(original);await writeFile(path.join(original,'source.mp4'),'original');await symlink(original,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>assertOutputNotSource(path.join(alias,'source.mp4'),[path.join(original,'source.mp4')]),/원본/);assert.equal(await readFile(path.join(original,'source.mp4'),'utf8'),'original');await assertOutputNotSource(path.join(alias,'export.mp4'),[path.join(original,'source.mp4')]);
});
