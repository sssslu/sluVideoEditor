import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import electron from 'electron';

const root=path.resolve('.test-artifacts/matting-process');await fs.mkdir(root,{recursive:true});
const built=await build({entryPoints:['scripts/matting-process-check.ts'],bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron','onnxruntime-node'],write:false});
const entry=path.join(root,'runner.cjs');await fs.writeFile(entry,built.outputFiles[0].contents);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
await promisify(execFile)(electron,[entry,'--no-first-run'],{env,windowsHide:true,timeout:180000,maxBuffer:1024*1024});
const result=JSON.parse(await fs.readFile(path.join(root,'results.json'),'utf8'));
console.log(JSON.stringify({checks:result.checks.length,maxMainThreadDelayMs:result.maxDelay,meanAlphaDifference:result.meanDifference,reports:result.reports.map(({coverage,...r})=>r),profiles:result.profiles,run:result.run}));
