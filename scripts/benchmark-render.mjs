import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';

// Run alone after UI checks. These measure source-engine output, not UI speed.
const run=promisify(execFile),version=JSON.parse(await fs.readFile('package.json','utf8')).version,root=path.resolve(`.test-artifacts/render-performance-${version}`);
await fs.mkdir(root,{recursive:true});
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const files=['package.json','tests/render-stress.test.ts','scripts/benchmark-render.mjs','electron/media.ts','electron/render-audio.ts','electron/video-color.ts','electron/video-input.ts','electron/media-timing.ts','shared/media-clock.ts','resources/bin/ffmpeg.exe','resources/bin/slu-audio-stretch.exe'];
const sourceHashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,await hash(file)])));
// Keep previous measurements when replacing the ordinary working reports.
for(const name of ['results.json','cuda-results.json']){const previous=path.join('.test-artifacts/render-stress',name),archive=path.join(root,`previous-${name}`);try{await fs.copyFile(previous,archive,constants.COPYFILE_EXCL);}catch(error){if(!['ENOENT','EEXIST'].includes(error.code))throw error;}}
const ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),input=path.resolve('.test-artifacts/media-benchmark/source1080.mp4');await fs.mkdir(path.dirname(input),{recursive:true});
await run(ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=1920x1080:r=30:d=3','-f','lavfi','-i','sine=f=440:r=48000:d=3','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',input],{windowsHide:true});
const startedAt=new Date().toISOString(),log=path.join(root,'tests.log');
try{const result=await run(process.execPath,['--import','tsx','--test','tests/render-stress.test.ts'],{env:{...process.env,SLU_STRESS:'1',SLU_GPU_BENCH:'1'},windowsHide:true,maxBuffer:8*1024*1024,timeout:600000});await fs.writeFile(log,result.stdout+result.stderr);}
catch(error){await fs.writeFile(log,String(error.stdout||'')+String(error.stderr||''));throw error;}
const stress=JSON.parse(await fs.readFile('.test-artifacts/render-stress/results.json','utf8')),cuda=JSON.parse(await fs.readFile('.test-artifacts/render-stress/cuda-results.json','utf8'));
assert.equal(stress.frames,1997);assert.deepEqual(stress.errors,[]);assert.deepEqual(stress.orphanPids,[]);assert.equal(cuda.runs.length,5);assert.equal(cuda.audioIdentical,true);
for(const [file,expected]of Object.entries(sourceHashes))assert.equal(await hash(file),expected,`Source changed during benchmark: ${file}`);
const report={version,startedAt,completedAt:new Date().toISOString(),passed:true,scope:'Source engine on this PC; synthetic SDR inputs, no UI benchmark or guaranteed speed',sourceHashes,inputSha256:await hash(input),stress,cuda};
await fs.writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({version,stress:{seconds:stress.elapsedSeconds,frames:stress.frames,peakBytes:stress.peakFfmpegWorkingSetBytes,cancelSeconds:stress.cancelSeconds},cuda:cuda.runs},null,2));
