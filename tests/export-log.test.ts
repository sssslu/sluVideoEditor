import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {exportLog} from '../electron/export-log';

const root=path.resolve('.test-artifacts/export-log');
const lines=async(directory:string)=>(await fs.readFile(path.join(directory,'export-log.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));

test('the export log keeps the request, restarts with their reason, and the outcome',async()=>{
  const directory=path.join(root,'basic');await fs.rm(directory,{recursive:true,force:true});
  const log=exportLog(directory,{format:'mov',encoder:'auto',clips:99});
  log.diagnostics({event:'render-plan',encoder:'h264_nvenc',windowCount:134});
  log.diagnostics({event:'window-start',index:0});           // per-window noise is not kept
  log.diagnostics({event:'encoder-fallback',encoder:'h264_nvenc',reason:'x'.repeat(5000)});
  await log.finish('complete','내보내기가 완료되었습니다. GPU 인코더가 실패해 CPU 인코더로 다시 내보냈습니다.');
  const entries=await lines(directory);
  assert.deepEqual(entries.map(entry=>entry.event),['export-start','render-plan','encoder-fallback','export-end']);
  assert.equal(entries[0].clips,99);assert.equal(entries[1].encoder,'h264_nvenc');
  assert.equal(entries[2].reason.length,2000,'a long reason is cut');
  assert.equal(entries[3].outcome,'complete');assert.ok(typeof entries[3].seconds==='number'&&entries.every(entry=>!Number.isNaN(Date.parse(entry.time))));
  // A second export appends.
  await exportLog(directory,{format:'mp4'}).finish('failed','원본 파일이 변경되었습니다.');
  assert.deepEqual((await lines(directory)).slice(-2).map(entry=>[entry.event,entry.outcome]),[['export-start',undefined],['export-end','failed']]);
});

test('the export log is cut to its newer half when it grows, and never fails an export',async()=>{
  const directory=path.join(root,'rotate');await fs.rm(directory,{recursive:true,force:true});await fs.mkdir(directory,{recursive:true});
  const file=path.join(directory,'export-log.jsonl'),old=Array.from({length:6000},(_,index)=>JSON.stringify({event:'export-end',index,padding:'p'.repeat(80)})).join('\n')+'\n';
  await fs.writeFile(file,old,'utf8');const before=(await fs.stat(file)).size;assert.ok(before>512*1024);
  await exportLog(directory,{format:'mov'}).finish('complete');
  const entries=await lines(directory);
  assert.ok((await fs.stat(file)).size<before*.6,'older half dropped');
  assert.equal(entries[0].index,3000,'the newer half is kept');assert.equal(entries.at(-1).outcome,'complete');
  // The folder cannot be created (its path is a file): logging gives up quietly.
  const blocked=path.join(root,'blocked');await fs.rm(blocked,{recursive:true,force:true});await fs.writeFile(blocked,'not a folder');
  const log=exportLog(blocked,{format:'mov'});log.diagnostics({event:'render-plan'});await log.finish('complete');
});
