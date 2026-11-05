import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import os from 'node:os';
import {atomicWrite,saveRecovery,listRecoveries,loadRecovery,readProject,publishRuntimeDirectory,serializeProject,ProjectSaveQueue} from '../electron/project-store';
import {newProject,newClip} from '../shared/project';
test('concurrent saves preserve invocation order and produce valid whole files',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'slu-write-')),file=path.join(dir,'project.sluproj');await Promise.all([atomicWrite(file,'a'.repeat(5000000)),atomicWrite(file,'latest')]);assert.equal(await readFile(file,'utf8'),'latest');});
test('manual save queue preserves requests before asynchronous validation and drains through a failed save',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'slu-save-order-')),file=path.join(dir,'project.sluproj'),queue=new ProjectSaveQueue();
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve),events:string[]=[];
  const first=queue.run(async()=>{events.push('first-validation');await gate;await atomicWrite(file,'earlier');});
  const failed=queue.run(async()=>{events.push('failed-validation');throw new Error('Invalid source');});void failed.catch(()=>{});
  const latest=queue.run(async()=>{events.push('latest-validation');await atomicWrite(file,'latest');});
  let drained=false;const drain=queue.flush().then(()=>{drained=true;});await new Promise(r=>setImmediate(r));assert.deepEqual(events,['first-validation']);assert.equal(drained,false);
  release();await first;await assert.rejects(failed,/Invalid source/);await latest;await drain;assert.equal(drained,true);assert.deepEqual(events,['first-validation','failed-validation','latest-validation']);assert.equal(await readFile(file,'utf8'),'latest');
});
test('saved project byte limit agrees with reopening for multibyte captions before any write',()=>{const base=newProject(),text='가'.repeat(20000),clips=Array.from({length:1000},()=>({...newClip('text-1'),text}));assert.throws(()=>serializeProject({...base,clips}),/50 MB/);assert.equal(JSON.parse(serializeProject({...base,clips:clips.slice(0,2)},true)).clips[0].text,text);});
test('Windows UTF-8 BOM projects open without data loss',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'slu-bom-')),file=path.join(dir,'한글.sluproj'),project=newProject();await atomicWrite(file,'\ufeff'+JSON.stringify(project));assert.deepEqual(await readProject(file),project);});
test('a partially damaged optional runtime is replaced as one complete directory',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'slu-runtime-')),destination=path.join(root,'runtime'),staging=path.join(root,'staging');await mkdir(destination);await writeFile(path.join(destination,'old.dll'),'broken');await mkdir(staging);await writeFile(path.join(staging,'new.dll'),'verified');await publishRuntimeDirectory(staging,destination);assert.deepEqual(await readdir(destination),['new.dll']);assert.equal(await readFile(path.join(destination,'new.dll'),'utf8'),'verified');assert.deepEqual(await readdir(root),['runtime']);});
test('failed runtime publication restores the previous installation',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'slu-runtime-rollback-')),destination=path.join(root,'runtime');await mkdir(destination);await writeFile(path.join(destination,'old.dll'),'previous');await assert.rejects(()=>publishRuntimeDirectory(path.join(root,'missing-staging'),destination));assert.equal(await readFile(path.join(destination,'old.dll'),'utf8'),'previous');assert.deepEqual(await readdir(root),['runtime']);});
test('Windows temporary file sharing violations retry without deleting the previous complete save',{skip:process.platform!=='win32'},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'slu-locked-')),file=path.join(dir,'saved.sluproj'),script=path.join(dir,'lock.ps1');await writeFile(file,'previous');
  await writeFile(script,'param([string]$targetFile)\n$lockedHandle=[System.IO.File]::Open($targetFile,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)\n[Console]::WriteLine("locked")\nStart-Sleep -Milliseconds 650\n$lockedHandle.Dispose()\n');
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-File',script,file],{windowsHide:true,stdio:['ignore','pipe','pipe']});let diagnostic='';child.stderr.on('data',d=>diagnostic+=d);
  const closed=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(diagnostic)));});
  try{await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('close',()=>reject(new Error('file lock helper stopped')));});await atomicWrite(file,'newest');await closed;assert.equal(await readFile(file,'utf8'),'newest');}finally{child.kill();await closed.catch(()=>{});}
});
test('recovering one project preserves other projects and rejects path-shaped IDs',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'slu-recovery-')),first={...newProject(),name:'프로젝트 A'},second={...newProject(),name:'프로젝트 B'};await saveRecovery(dir,first);await saveRecovery(dir,second);assert.equal((await listRecoveries(dir)).length,2);assert.equal((await loadRecovery(dir,first.id))?.name,first.name);assert.equal((await loadRecovery(dir,second.id))?.name,second.name);assert.equal(await loadRecovery(dir,'../../outside'),null);});
