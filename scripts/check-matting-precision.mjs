import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import electron from 'electron';
import {validateBuildReceipt} from './build-receipt.mjs';

async function hash(file){
 const digest=createHash('sha256');
 for await(const chunk of createReadStream(file))digest.update(chunk);
 return digest.digest('hex');
}
const models={
 cpu:{file:path.resolve('resources/models/person-matting-rvm-resnet50.onnx'),bytes:107479165,sha256:'25db300fcb6ee27f941a1b52c97856e8d1f13c7f35817f81a612f89af0e8a85c'},
 dml:{file:path.resolve('resources/models/person-matting-rvm-resnet50-bgr.onnx'),bytes:107483061,sha256:'f95503b9719810647c58a1c5136a9e3b052d3612ae93ee233edc3b56e50a6c32'},
};
const receipt=await validateBuildReceipt();
for(const model of Object.values(models)){
 assert.equal((await fs.stat(model.file)).size,model.bytes);
 assert.equal(await hash(model.file),model.sha256);
}
const workerPath=path.resolve('dist-electron/matting-worker.cjs');
assert.ok((await fs.readFile(workerPath,'utf8')).includes(models.cpu.sha256),'Build the precision-capable worker before running this check');
const fixture=JSON.parse(await fs.readFile('.test-artifacts/matting-fixtures/fixture.json','utf8'));
assert.equal(fixture.width,1280);assert.equal(fixture.height,720);
assert.equal(await hash(fixture.raw),fixture.rawHash);
assert.equal(await hash(fixture.source.file),fixture.source.sha256);
const base=path.resolve('.test-artifacts/matting-precision');
await fs.mkdir(base,{recursive:true});
const root=await fs.mkdtemp(path.join(base,'run-')),host=path.join(root,'host.cjs');
await fs.writeFile(path.join(base,'current.txt'),root);
const built=await build({entryPoints:['scripts/matting-precision-check.ts'],outfile:host,bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron','onnxruntime-node'],metafile:true});
const files=[...new Set([
 'scripts/check-matting-precision.mjs','scripts/build-receipt.mjs','electron/matting-model.ts','electron/matting-worker.ts',
 ...Object.values(built.metafile.outputs).flatMap(output=>Object.entries(output.inputs).filter(([,input])=>input.bytesInOutput>0).map(([file])=>file)),
])].sort();
const sources={};for(const file of files)sources[file]=await hash(file);
const manifest={
 root,models,workerPath,workerSha256:await hash(workerPath),fixture,sources,version:receipt.version,buildReceiptId:receipt.contentId,
 ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),
 maximumNativeAttempts:24,hostSha256:await hash(host),
 scope:'Bounded native ResNet CPU/DirectML integration, state recovery and process ownership. GPU contention may occur. Durations are not benchmarks.',
 distribution:'External source footage and derived review artifacts are development-only and excluded from release inputs.',
};
manifest.ffmpegSha256=await hash(manifest.ffmpeg);
manifest.ffprobeSha256=await hash(manifest.ffprobe);
await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(manifest,null,2));
const env={...process.env,SLU_MATTING_PRECISION_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;
try{
 await promisify(execFile)(electron,[host],{env,windowsHide:true,timeout:600000,maxBuffer:1024*1024});
 const result=JSON.parse(await fs.readFile(path.join(root,'results.json'),'utf8'));
 assert.equal(result.buildReceiptId,receipt.contentId);assert.equal(result.version,receipt.version);
 assert.ok(result.nativeAttemptUpperBound<=manifest.maximumNativeAttempts);
 assert.equal(await hash(host),manifest.hostSha256);
 assert.equal(await hash(manifest.ffmpeg),manifest.ffmpegSha256);
 assert.equal(await hash(manifest.ffprobe),manifest.ffprobeSha256);
 assert.equal(await hash(fixture.raw),fixture.rawHash);
 assert.equal(await hash(fixture.source.file),fixture.source.sha256);
 assert.equal(await hash(workerPath),manifest.workerSha256);
 for(const model of Object.values(models))assert.equal(await hash(model.file),model.sha256);
 const changedSources=[];for(const file of files)if(await hash(file)!==sources[file])changedSources.push(file);
 assert.deepEqual(changedSources,[],'Executed source changed during the check');
 assert.deepEqual(await validateBuildReceipt(),receipt,'Build receipt changed during native checks');
 await fs.writeFile(path.join(root,'source-stability.json'),JSON.stringify({
  changedSources,buildReceiptId:receipt.contentId,buildReceiptValidatedBefore:true,buildReceiptValidatedAfter:true,
  hostVerified:true,modelsVerified:true,workerVerified:true,ffmpegVerified:true,ffprobeVerified:true,fixtureRawVerified:true,fixtureSourceVerified:true,
 },null,2));
 console.log(JSON.stringify({root,frameRequests:result.frameRequests,nativeAttemptUpperBound:result.nativeAttemptUpperBound,checks:result.checks,profiles:result.profiles}));
}catch(error){
 console.error(await fs.readFile(path.join(root,'failure.json'),'utf8').catch(()=>String(error)));
 process.exitCode=1;
}
