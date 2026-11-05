import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

const {validateFeatureReport,validateEnhancementQuality,validateEnhancementRealOutputs,validateEnhancementHardware}=await import(new URL('../scripts/feature-evidence.mjs',import.meta.url).href);
const artifactRoot=path.resolve('.test-artifacts/feature-evidence-tests');
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const suite={name:'fixture',script:'fixture.mjs',minimum:1};
const hardwareFixture=(blocks=0)=>({inferenceStrategy:'independent-frames-v1',modelTemporalFrames:1,transportWindowFrames:9,
  overlapReuseFrames:4,vaeTileSize:256,blocksToSwap:blocks,directEstimatedVramBytes:100,partialEstimatedVramBytes:80,
  vramBudgetBytes:blocks?90:100,estimatedVramBytes:blocks?80:100,memoryPolicy:blocks?'partial-cuda-8-v1':'direct-cuda-v1',
  originalGeometryVramBytes:120,estimatedRamBytes:50,estimatedCommitBytes:170,frameCopyAllowanceBytes:10});

test('Independent-frame admission accepts direct and partial plans, but rejects old strategy and weakened budgets',()=>{
  assert.equal(validateEnhancementHardware(hardwareFixture()),0);
  assert.equal(validateEnhancementHardware(hardwareFixture(8)),8);
  for(const changed of [
    {inferenceStrategy:'temporal-windows-v1'},{inferenceStrategy:undefined},{modelTemporalFrames:9},
    {transportWindowFrames:1},{overlapReuseFrames:0},{vaeTileSize:512},{blocksToSwap:8},
    {directEstimatedVramBytes:NaN},{partialEstimatedVramBytes:0},{vramBudgetBytes:Infinity},
    {estimatedVramBytes:80},{memoryPolicy:'partial-cuda-8-v1'},{originalGeometryVramBytes:99},
    {estimatedCommitBytes:169},{estimatedRamBytes:-1},{frameCopyAllowanceBytes:0},
  ])assert.throws(()=>validateEnhancementHardware({...hardwareFixture(),...changed}));
  assert.throws(()=>validateEnhancementHardware({...hardwareFixture(8),partialEstimatedVramBytes:91,estimatedVramBytes:91}),/exceeds/);
});

async function fixture(t:{after:(callback:()=>Promise<void>)=>void}) {
  await fs.mkdir(artifactRoot,{recursive:true});
  const workspace=await fs.mkdtemp(path.join(artifactRoot,'run-'));
  t.after(async()=>{assert.ok(workspace.startsWith(artifactRoot+path.sep));await fs.rm(workspace,{recursive:true,force:true});});
  const files=['package.json','package-lock.json','scripts/e2e-launch.mjs','scripts/e2e-release-evidence.mjs','scripts/fixture.mjs','src/App.tsx'];
  const sourceHashes:Record<string,string>={};
  for(const file of files){await fs.mkdir(path.dirname(path.join(workspace,file)),{recursive:true});await fs.writeFile(path.join(workspace,file),file);sourceHashes[file]=digest(file);}
  const buildReceipt={version:'1.11.0',contentId:'current-build',inputs:{'src/App.tsx':sourceHashes['src/App.tsx']}};
  const report={passed:true,completedAt:new Date().toISOString(),version:buildReceipt.version,buildReceiptId:buildReceipt.contentId,
    checks:['Actual check'],errors:[],executable:null,runtime:{version:buildReceipt.version,packaged:false,hidden:true},sourceHashes,exeSha256:null,asarSha256:null};
  return {workspace,buildReceipt,report};
}

test('Feature collector rejects unfinished, stale, failed and incomplete source proof',async t=>{
  const {workspace,buildReceipt,report}=await fixture(t),context={workspace,buildReceipt};
  await validateFeatureReport(report,suite,context);
  for(const changed of [{passed:false},{completedAt:undefined},{version:'1.10.0'},{buildReceiptId:'old'},
    {errors:['renderer error']},{checks:[]},{runtime:{...report.runtime,hidden:false}},{sourceHashes:{}}]) {
    await assert.rejects(validateFeatureReport({...report,...changed},suite,context));
  }
  await fs.writeFile(path.join(workspace,'src/App.tsx'),'changed');
  await assert.rejects(validateFeatureReport(report,suite,context),/Stale feature evidence/);
});

test('Packaged feature proof binds the executable and ASAR bytes',async t=>{
  const {workspace,buildReceipt,report}=await fixture(t);
  const executable=path.join(workspace,'release/win-unpacked/SLU Studio.exe'),asar=path.join(path.dirname(executable),'resources/app.asar');
  await fs.mkdir(path.dirname(asar),{recursive:true});await fs.writeFile(executable,'exe');await fs.writeFile(asar,'asar');
  const packaged={...report,executable,runtime:{...report.runtime,packaged:true,executable},exeSha256:digest('exe'),asarSha256:digest('asar')};
  await validateFeatureReport(packaged,suite,{workspace,buildReceipt,packaged:true});
  await assert.rejects(validateFeatureReport(packaged,suite,{workspace,buildReceipt}));
  await fs.writeFile(asar,'changed');
  await assert.rejects(validateFeatureReport(packaged,suite,{workspace,buildReceipt,packaged:true}));
});

test('Real AI evidence rejects small output, truncated time/pixels and unobserved device placement',()=>{
  const output=(count:number,childId:number)=>{
    const duration=count/10,sha256=digest('output-'+childId);
    const ready={protocolVersion:1,inputCapacity:5,outputWidth:1920,outputHeight:1080,hardware:hardwareFixture()};
    return {expected:{frameCount:count,duration},frameCount:count,duration,
      media:{kind:'video',hasAlpha:false,width:1920,height:1080,duration},browser:{width:1280,height:720,duration,readyState:2},
      probe:{frames:Array.from({length:count},(_,index)=>({media_type:'video',best_effort_timestamp_time:String(index/10),duration_time:'.1'})),streams:[{codec_type:'video',pix_fmt:'bgr0'}]},
      pixels:{bytes:count*1920*1080*4,frameCount:count,sha256,frames:Array.from({length:count},(_,index)=>({index,sha256})),pid:100+childId,exitCode:0},
      worker:{childId,pid:childId,command:path.resolve('runtime/python/python.exe'),ready},
      fileSha256:sha256,proxySha256:sha256,nativeBgraSha256:sha256,pcmSha256:sha256,pcmBytes:Math.round(duration*48000)*4};
  };
  const preview=output(1,1),full=output(15,2),sourceSha256=digest('source');
  const report={fixture:{sourceWidth:960,sourceHeight:540,outputWidth:1920,outputHeight:1080,proxyWidth:1280,proxyHeight:720,fps:10,duration:1.5,frameCount:15},
    sourceSha256,preview,full,nativeAudit:[preview,full].flatMap(({worker})=>[
      {event:'spawn',childId:worker.childId,pid:worker.pid,command:worker.command,result:worker.ready},
      {event:'worker-ready',childId:worker.childId,pid:worker.pid,command:worker.command,result:worker.ready}])};
  const reference={sourceSha256,frames:Array.from({length:15},(_,index)=>({pts:index*100000,width:960,height:540,bytes:960*540*3,bgrSha256:digest('input-'+index)}))};
  validateEnhancementRealOutputs(report,reference);
  const changes:Array<(value:typeof report)=>void>=[
    value=>{value.full.media.width=320;value.full.media.height=180;},
    value=>{value.full.frameCount=1;},
    value=>{value.full.probe.frames[7].best_effort_timestamp_time='.6';},
    value=>{value.full.pixels.bytes-=4;},
    value=>{value.full.pixels.frames.pop();},
    value=>{value.full.worker.ready.hardware.blocksToSwap=8;},
    value=>{value.preview.worker.ready.hardware.inferenceStrategy='temporal-windows-v1';},
    value=>{value.full.worker.ready.hardware.modelTemporalFrames=9;},
    value=>{value.nativeAudit=value.nativeAudit.filter(event=>event.event!=='worker-ready');},
    value=>{value.nativeAudit[3].pid=999;},
    value=>{value.full.pcmBytes-=4;},
  ];
  for(const change of changes){const changed=structuredClone(report);change(changed);assert.throws(()=>validateEnhancementRealOutputs(changed,reference));}
  const truncated=structuredClone(reference);truncated.frames.pop();assert.throws(()=>validateEnhancementRealOutputs(report,truncated));
  assert.throws(()=>validateEnhancementRealOutputs(report,{...reference,sourceSha256:digest('other')}));
});

test('Quality collector requires current complete output, finite metrics and its exact accepted review',async t=>{
  const {workspace}=await fixture(t);
  const base=path.join(workspace,'.test-artifacts/enhancement-quality'),run=path.join(base,'run-fixture');
  await fs.mkdir(run,{recursive:true});await fs.writeFile(path.join(base,'current.txt'),run);
  const files=['scripts/check-enhancement-quality.mjs','native/enhancement/seedvr_worker.py','native/enhancement/tensor_loader.py','native/enhancement/backend-manifest.json'];
  const sourceHashes:Record<string,string>={};
  for(const file of files){await fs.mkdir(path.dirname(path.join(workspace,file)),{recursive:true});await fs.writeFile(path.join(workspace,file),file);sourceHashes[file]=digest(file);}
  const buildReceipt={version:'1.11.0',contentId:'current-build',inputs:sourceHashes};
  const cases=await Promise.all(['hair-2x','dance-2x','cut-2x','portrait-4x'].map(async id=>{
    const scale=id.endsWith('4x')?4:2,filename=path.join(run,id+'.png'),pts=Array.from({length:15},(_,index)=>index*40000);
    const width=id==='dance-2x'?1280:1920,height=id==='dance-2x'?720:1080,blocksToSwap=id==='dance-2x'?0:8;
    const hardware=hardwareFixture(blocksToSwap);
    await fs.writeFile(filename,'sample');
    return {id,scale,inputWidth:width/scale,inputHeight:height/scale,width,height,blocksToSwap,hardware,frameCount:15,pts,
      inputSha256:digest('input'),outputSha256:digest('output'),referenceSha256:digest('reference'),samples:[{index:0,filename,sha256:digest('sample')}],
      metrics:pts.map((pts,index)=>({index,pts,emissionBoundary:index===0,ai:{mse:1,meanAbsoluteError:1,ssim:.5,temporalError:1},lanczos:{mse:1,meanAbsoluteError:1,ssim:.5,temporalError:1}})),
      batches:[{outputFirstFrame:0,frameCount:1,pts:pts.slice(0,1),bytes:width*height*4,complete:false},
        {outputFirstFrame:1,frameCount:5,pts:pts.slice(1,6),bytes:5*width*height*4,complete:false},
        {outputFirstFrame:6,frameCount:9,pts:pts.slice(6),bytes:9*width*height*4,complete:true}],
      diagnostics:[{event:'enhancement-worker-start',pid:123},{event:'enhancement-worker-ready',hardware},{event:'enhancement-worker-exit',pid:123}]};
  }));
  const report={passed:true,completedAt:new Date().toISOString(),version:'1.11.0',buildReceiptId:'current-build',sourceHashes,
    manifestSha256:sourceHashes[files[3]],runtimeRegistrySha256:digest('registry'),cases,qualityScope:'Descriptive paired review',distribution:'Metadata only'};
  const publish=async(accepted=true)=>{
    const text=JSON.stringify(report);
    await fs.writeFile(path.join(base,'results.json'),text);await fs.writeFile(path.join(run,'results.json'),text);
    await fs.writeFile(path.join(base,'review.json'),JSON.stringify({reportSha256:digest(text),accepted,limitations:['Synthetic degradation'],caseReviews:cases.map(item=>({id:item.id,observations:['Reviewed'],limitations:[]}))}));
  };
  await publish();await validateEnhancementQuality(workspace,buildReceipt);
  cases[0].width=640;await publish();await assert.rejects(validateEnhancementQuality(workspace,buildReceipt));
  cases[0].width=1920;cases[0].hardware.blocksToSwap=0;await publish();
  await assert.rejects(validateEnhancementQuality(workspace,buildReceipt),/device-placement plan/);
  cases[0].hardware.blocksToSwap=8;
  cases[0].hardware.inferenceStrategy='temporal-windows-v1';await publish();
  await assert.rejects(validateEnhancementQuality(workspace,buildReceipt),/independent-frame inference/);
  cases[0].hardware.inferenceStrategy='independent-frames-v1';
  const originalBatches=cases[0].batches;
  cases[0].batches=[{outputFirstFrame:0,frameCount:15,pts:cases[0].pts,bytes:15*1920*1080*4,complete:true}];await publish();
  await assert.rejects(validateEnhancementQuality(workspace,buildReceipt),/three transport batches/);
  cases[0].batches=originalBatches;
  await publish(false);await assert.rejects(validateEnhancementQuality(workspace,buildReceipt),/visual review/);
  await publish();await fs.writeFile(path.join(run,'results.json'),'{}');
  await assert.rejects(validateEnhancementQuality(workspace,buildReceipt),/latest quality attempt/);
  cases[0].metrics[1].ai.temporalError=Number.NaN;await publish();
  await assert.rejects(validateEnhancementQuality(workspace,buildReceipt),/finite quality metric/);
  cases[0].metrics[1].ai.temporalError=1;await publish();await fs.writeFile(cases[0].samples[0].filename,'changed');
  await assert.rejects(validateEnhancementQuality(workspace,buildReceipt),/quality image changed/);
});
