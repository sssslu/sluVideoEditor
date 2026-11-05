import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const read=async label=>{const root=(await fs.readFile(`.test-artifacts/tracking-performance-${label}-current.txt`,'utf8')).trim();return {root,...JSON.parse(await fs.readFile(path.join(root,'results.json'),'utf8'))};};
const control=await read('fixed-control'),disk=await read('fixed-disk'),cold=[];
for(let i=0;i<4;i++)cold.push(await read('fixed-seek-'+i));
for(const run of cold)assert.equal(run.reports[0].recordsSHA256,cold[0].reports[0].recordsSHA256,'Fresh process tracking records');
const reference=control.reports[0];
for(const row of disk.reports.filter(r=>r.fps===30&&r.maximum===1280&&r.duration===20))assert.equal(row.recordsSHA256,reference.recordsSHA256,'RAM/disk tracking records must be identical');
assert.equal(disk.reports[1].recordsSHA256,disk.reports[3].recordsSHA256,'Repeated 1920 analysis records');
for(const run of [control,disk,...cold])for(const row of run.reports){
  const probes=row.events.filter(e=>e.event==='frame-probe-exit');assert.ok(probes.length>0);
  assert.ok(probes.every(e=>Number.isFinite(e.first)),'No empty timestamp probe may be hidden by a slow retry');
  assert.ok(probes.every(e=>e.seek!==undefined),'All these middle-of-source cases must avoid a scan from zero');
  assert.ok(row.samples.at(-1).seconds>=row.seconds-.5,'Memory sampler must cover the complete job');
}
const compact=run=>({root:run.root,reports:run.reports.map(({name,seconds,frames,decodedFrames,decoders,peakParentRss,peakOwnedWorkingSet,maxMainGap,recordsSHA256})=>({name,seconds,frames,decodedFrames,decoders,peakParentRss,peakOwnedWorkingSet,maxMainGap,recordsSHA256}))});
const report={scope:disk.scope,control:compact(control),disk:compact(disk),cold:cold.map(compact),identicalRecords:true,noEmptyProbes:true,completeSampling:true};
await fs.writeFile('.test-artifacts/tracking-performance-comparison.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
