import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import electron from 'electron';
const run=promisify(execFile),root=path.resolve('.test-artifacts/matting-long',Date.now().toString());await fs.mkdir(root,{recursive:true});
await fs.writeFile('.test-artifacts/matting-long/current.txt',root);
const source=path.resolve('.build-cache/matting/b5.mp4');await fs.access(source);
await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-y','-stream_loop','4','-i',source,'-f','lavfi','-i','aevalsrc=0.1*sin(2*PI*437*t)|0.07*sin(2*PI*701*t):s=48000:d=60','-map','0:v:0','-map','1:a:0','-t','60','-c:v','copy','-c:a','pcm_f32le','-video_track_timescale','1000000','-movie_timescale','1000000',path.join(root,'looped-4k.mov')],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});
const host=path.join(root,'host.cjs');await build({entryPoints:['scripts/matting-long-check.ts'],outfile:host,bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron','onnxruntime-node']});
const env={...process.env,SLU_LONG_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;
const gpu=[];let sampling=false;const sample=async()=>{if(sampling)return;sampling=true;try{const {stdout}=await run('nvidia-smi',['--query-gpu=memory.used,utilization.gpu,temperature.gpu','--format=csv,noheader,nounits'],{windowsHide:true,timeout:4000});gpu.push({at:new Date().toISOString(),systemGpu:stdout.trim()});}catch(error){gpu.push({at:new Date().toISOString(),error:String(error)});}finally{sampling=false;}};
await sample();const timer=setInterval(()=>void sample(),2000);
try{await run(electron,[host],{windowsHide:true,env,timeout:30*60*1000,maxBuffer:2*1024*1024});const result=JSON.parse(await fs.readFile(path.join(root,'results.json'),'utf8'));console.log(JSON.stringify({root,checks:result.checks.length,frames:result.processed,timing:result.timing,memory:result.memory,outputBytes:result.outputBytes,proxyBytes:result.proxyBytes}));}
catch(error){const failure=await fs.readFile(path.join(root,'failure.json'),'utf8').catch(()=>String(error));console.error(failure);process.exitCode=1;}
finally{clearInterval(timer);await fs.writeFile(path.join(root,'system-gpu.json'),JSON.stringify(gpu,null,2));}
