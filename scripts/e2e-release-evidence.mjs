import {promises as fs,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {validateBuildReceipt,validatePackagedBuild} from './build-receipt.mjs';

export const testExecutable=()=>process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
export async function hashFile(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function sourceFiles(directory){
  const files=[];
  for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const file=path.join(directory,entry.name).replaceAll('\\','/');
    if(entry.isDirectory())files.push(...await sourceFiles(file));else if(entry.isFile())files.push(file);
  }
  return files;
}
// This module is imported before any test launches Electron. Retain the
// verified build and entry script so a later edit/rebuild cannot label an
// already-running application with the new files' hashes.
const workspace=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const initialBuildReceipt=await validateBuildReceipt(workspace);
const initialScript=process.argv[1]?path.resolve(process.argv[1]):null;
const initialScriptHash=initialScript?await hashFile(initialScript):null;
const initialExecutable=testExecutable();
const initialAsar=initialExecutable?path.join(path.dirname(initialExecutable),'resources','app.asar'):null;
const initialExeHash=initialExecutable?await hashFile(initialExecutable):null;
const initialAsarHash=initialAsar?await hashFile(initialAsar):null;
if(initialAsar)await validatePackagedBuild(initialAsar,initialBuildReceipt);

export async function verifyEditorBuild(evidence){
  const current=await validateBuildReceipt(workspace);
  assert.equal(current.contentId,initialBuildReceipt.contentId,'Build changed during editor verification');
  assert.equal(evidence.buildReceiptId,current.contentId,'Editor evidence belongs to another build');
  for(const [file,digest] of Object.entries(evidence.sourceHashes)){
    assert.equal(await hashFile(file),digest,`Source changed during editor verification: ${file}`);
  }
  if(evidence.executable){
    assert.equal(evidence.executable,initialExecutable);
    assert.equal(evidence.exeSha256,initialExeHash);
    assert.equal(evidence.asarSha256,initialAsarHash);
    assert.equal(await hashFile(initialExecutable),initialExeHash,'Executable changed during verification');
    assert.equal(await hashFile(initialAsar),initialAsarHash,'Packaged application changed during verification');
    await validatePackagedBuild(initialAsar,current);
  }
}
export async function editorEvidence(app,script,{matting=false}={}){
  const executable=testExecutable(),version=JSON.parse(await fs.readFile('package.json','utf8')).version;
  const runtime=await app.evaluate(({app,BrowserWindow})=>({version:app.getVersion(),executable:process.execPath,resources:process.resourcesPath,packaged:app.isPackaged,argv:process.argv,frameRateLimitDisabled:app.commandLine.hasSwitch('disable-frame-rate-limit'),hidden:BrowserWindow.getAllWindows().every(w=>!w.isVisible())}));
  assert.equal(runtime.version,version);assert.equal(runtime.packaged,!!executable);assert.equal(runtime.hidden,true);
  if(executable)assert.equal(path.resolve(runtime.executable),executable);
  const sourceHashes={};
  for(const file of ['package.json','package-lock.json','scripts/e2e-launch.mjs','scripts/e2e-release-evidence.mjs',path.relative('.',fileURLToPath(script)).replaceAll('\\','/'),...await sourceFiles('electron'),...await sourceFiles('shared'),...await sourceFiles('src')])sourceHashes[file]=await hashFile(file);
  const modelSha256=await hashFile('resources/models/object-tracking-vit.onnx');
  if(executable)assert.equal(await hashFile(path.join(runtime.resources,'models/object-tracking-vit.onnx')),modelSha256,'Packaged tracking model must match the reviewed model');
  const mattingModels={};
  if(matting){
    for(const filename of ['person-matting-rvm.onnx','person-matting-rvm-bgr.onnx','person-matting-rvm-resnet50.onnx','person-matting-rvm-resnet50-bgr.onnx']){
      const digest=await hashFile(path.join('resources/models',filename));
      mattingModels[filename]=digest;
      if(executable)assert.equal(await hashFile(path.join(runtime.resources,'models',filename)),digest,`Packaged matting model differs: ${filename}`);
    }
  }
  const entry=path.resolve(fileURLToPath(script));
  assert.equal(entry,initialScript,'Capture editor evidence from the launched test entry point');
  assert.equal(await hashFile(entry),initialScriptHash,'Test script changed after its launch');
  const evidence={version,executable,runtime,modelSha256,sourceHashes,buildReceiptId:initialBuildReceipt.contentId,...(matting?{mattingModels}:{}),asarSha256:executable?await hashFile(path.join(runtime.resources,'app.asar')):null,exeSha256:executable?await hashFile(executable):null};
  await verifyEditorBuild(evidence);
  return evidence;
}

export const trackingSuites=[
  {name:'motion-binding-ui',script:'e2e-motion-binding.mjs',minimum:7},
  {name:'motion-split-ui',script:'e2e-motion-split.mjs',minimum:6},
  {name:'tracking-authoring-ui',script:'e2e-tracking-authoring.mjs',minimum:11},
  {name:'tracking-ipc',script:'e2e-tracking-ipc.mjs',minimum:5},
  {name:'project-assets-ui',script:'e2e-project-assets.mjs',minimum:7,pointer:true},
  {name:'tracking-reconnect-ui',script:'e2e-tracking-reconnect.mjs',minimum:11,pointer:true},
  {name:'tracking-stress-ui',script:'e2e-tracking-stress.mjs',minimum:6,pointer:true,normalFlags:true},
];
async function collectEditorEvidence(suites,{packaged=false}={}){
  const version=JSON.parse(await fs.readFile('package.json','utf8')).version,executable=packaged?path.resolve('release/win-unpacked/SLU Studio.exe'):null;
  const reports=[],currentHashes=new Map(),hash=async file=>{if(!currentHashes.has(file))currentHashes.set(file,await hashFile(file));return currentHashes.get(file);};
  for(const suite of suites){
    const directory=suite.pointer?(await fs.readFile(`.test-artifacts/${suite.name}-current.txt`,'utf8')).trim():path.resolve('.test-artifacts',suite.name);
    assert.ok(path.resolve(directory).startsWith(path.resolve('.test-artifacts')+path.sep));
    const result=JSON.parse(await fs.readFile(path.join(directory,'results.json'),'utf8'));
    assert.equal(result.buildReceiptId,initialBuildReceipt.contentId,`Stale build in ${suite.name}`);
    assert.equal(result.version,version,suite.name);assert.equal(result.executable,executable,suite.name);assert.deepEqual(result.errors,[]);assert.ok(result.checks.length>=suite.minimum,suite.name);
    assert.equal(result.runtime.version,version);assert.equal(result.runtime.packaged,packaged);assert.equal(result.runtime.hidden,true);
    assert.equal(result.runtime.frameRateLimitDisabled,!suite.normalFlags);
    assert.ok(Object.keys(result.sourceHashes).length>=100);
    for(const [file,value] of Object.entries(result.sourceHashes))assert.equal(await hash(file),value,`Stale ${suite.name}: ${file}`);
    assert.equal(result.modelSha256,await hash('resources/models/object-tracking-vit.onnx'));
    if(packaged){assert.equal(result.runtime.executable,executable);assert.equal(result.exeSha256,await hash(executable));assert.equal(result.asarSha256,await hash('release/win-unpacked/resources/app.asar'));}
    if(suite.name==='tracking-ipc'){assert.equal(result.result.tracking.backend,'dml');assert.equal(result.result.tracking.frames,50);assert.equal(result.cpu.tracking.backend,'cpu');assert.equal(result.cpu.tracking.frames,50);for(const backend of ['dml','cpu'])assert.ok(result.audit.some(e=>e.type==='backend'&&e.backend===backend));}
    if(suite.name==='tracking-stress-ui'){assert.equal(result.result.tracking.frames,600);assert.equal(result.result.tracking.backend,'dml');}
    reports.push({name:suite.name,directory,...result});
  }
  return reports;
}

export const trackingEvidence=options=>collectEditorEvidence(trackingSuites,options);

export const cutoutSuites=[
  {name:'cutout-ui',minimum:24,pointer:true},
  {name:'cutout-long-ui',minimum:5,pointer:true},
  {name:'cutout-recovery-ui',minimum:5,pointer:true},
];
export async function cutoutEvidence(options){
  const reports=await collectEditorEvidence(cutoutSuites,options);
  for(const report of reports){
    for(const filename of ['person-matting-rvm.onnx','person-matting-rvm-bgr.onnx','person-matting-rvm-resnet50.onnx','person-matting-rvm-resnet50-bgr.onnx']){
      assert.equal(report.mattingModels?.[filename],await hashFile(path.join('resources/models',filename)),`Stale matting model in ${report.name}: ${filename}`);
    }
  }
  return reports;
}
