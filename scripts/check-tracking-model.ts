import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {ObjectTracker,type TrackingBackend} from '../electron/tracking-model';
import type {TrackingBox,TrackingObservation} from '../electron/tracking-math';

const root=path.resolve('.test-artifacts/tracking-model'),run=path.join(root,Date.now().toString());await fs.mkdir(run,{recursive:true});
const fixtures=JSON.parse(await fs.readFile('.test-artifacts/tracking-fixtures/fixtures.json','utf8'));
const iou=(a:TrackingBox,b:TrackingBox)=>{const area=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));return area/(a[2]*a[3]+b[2]*b[3]-area);};
const reports=[],outputs=new Map<string,TrackingObservation[]>();
// Regression floors from the initial experiment, not a claim of general
// accuracy or CapCut parity. In particular the occlusion sequence is weaker.
const floors:Record<string,number>={david:.65,dudek:.8,faceocc2:.45};
const backends:TrackingBackend[]=process.argv.includes('--gpu')?['cpu','dml']:['cpu'];
for(const backend of backends){
  const tracker=await ObjectTracker.create({modelPath:path.resolve('resources/models/object-tracking-vit.onnx'),backend,profilePrefix:path.join(run,'profile')});
  try{for(const entry of fixtures.rows){
    const sample=JSON.parse(await fs.readFile(entry.record,'utf8')),handle=await fs.open(sample.raw,'r'),bytes=Buffer.alloc(sample.width*sample.height*3),rows:TrackingObservation[]=[],began=performance.now();
    try{for(let i=0;i<sample.frames;i++){
      let offset=0;while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,i*bytes.length+offset);assert.ok(read.bytesRead);offset+=read.bytesRead;}
      const frame={width:sample.width,height:sample.height,data:bytes};rows.push(i===0?tracker.anchor(frame,sample.ground[0]):await tracker.update(frame));
    }}finally{await handle.close();}
    const overlap=rows.map((r,i)=>r.status==='lost'?0:iou(r.box,sample.ground[i])),report={name:sample.name,backend,frames:rows.length,seconds:(performance.now()-began)/1000,meanIoU:overlap.reduce((a,b)=>a+b,0)/rows.length,successAtHalf:overlap.filter(x=>x>=.5).length/rows.length,review:rows.filter(r=>r.status==='review').length,lost:rows.filter(r=>r.status==='lost').length};
    await fs.writeFile(path.join(run,`${sample.name}-${backend}.json`),JSON.stringify({...report,rows},null,2));assert.ok(report.meanIoU>=floors[sample.name],JSON.stringify(report));
    if(backend==='cpu')outputs.set(sample.name,rows);else{const cpu=outputs.get(sample.name)!;assert.equal(cpu.length,rows.length);const agreement=rows.reduce((total,r,i)=>total+iou(r.box,cpu[i].box),0)/rows.length;assert.ok(agreement>.98,`CPU/GPU box agreement ${agreement}`);}
    reports.push(report);console.log(JSON.stringify(report));
  }}finally{await tracker.close();}
}
const profiles=[];
for(const file of await fs.readdir(run)){if(!file.startsWith('profile-'))continue;const events=JSON.parse(await fs.readFile(path.join(run,file),'utf8')),providers:Record<string,number>={};for(const event of events)if(event.args?.provider)providers[event.args.provider]=(providers[event.args.provider]||0)+1;profiles.push({file,providers});}
assert.ok(profiles.some(p=>p.providers.CPUExecutionProvider>0));if(backends.includes('dml'))assert.ok(profiles.some(p=>p.providers.DmlExecutionProvider>0),'Actual DirectML execution must appear in the native profile');
const result={version:JSON.parse(await fs.readFile('package.json','utf8')).version,scope:'Model adapter only, excluding decoding, editor preview/export and utility-process transfer',run,reports,profiles};await fs.writeFile(path.join(root,'results.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({profiles}));
