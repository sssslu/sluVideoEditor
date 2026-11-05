import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import electron from 'electron';

const label=process.argv[2]||'current';if(!/^[a-z0-9-]+$/.test(label))throw new Error('Invalid benchmark label');
const root=path.resolve('.test-artifacts/tracking-performance',Date.now()+'-'+label);await fs.mkdir(root,{recursive:true});
const built=await build({entryPoints:['scripts/benchmark-tracking-host.ts'],bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron','onnxruntime-node'],write:false});
const entry=path.join(root,'runner.cjs');await fs.writeFile(entry,built.outputFiles[0].contents);
const env={...process.env,SLU_TRACKING_BENCH_ROOT:root,SLU_TRACKING_BENCH_LABEL:label};delete env.ELECTRON_RUN_AS_NODE;
await fs.writeFile(path.resolve(`.test-artifacts/tracking-performance-${label}-current.txt`),root);
await promisify(execFile)(electron,[entry,'--no-first-run'],{env,windowsHide:true,timeout:1200000,maxBuffer:1024*1024});
const result=JSON.parse(await fs.readFile(path.join(root,'results.json'),'utf8'));console.log(JSON.stringify({root,reports:result.reports.map(({name,seconds,frames,decodedFrames,decoders,peakParentRss,maxMainGap})=>({name,seconds,frames,decodedFrames,decoders,peakParentRss,maxMainGap}))},null,2));
