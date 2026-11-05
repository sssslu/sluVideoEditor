import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {openSync,closeSync,writeFileSync,rmSync,promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import electron from 'electron';
const root=path.resolve('.test-artifacts/rich-captions/log-sink');await fs.mkdir(root,{recursive:true});
await build({entryPoints:['tests/caption-log-probe.ts'],outfile:path.join(root,'probe.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron']});
const disconnect=process.argv.includes('--disconnect'),mode=disconnect?'parent-disconnect':'closed-sink';
const supervisor=path.join(root,`${mode}-${Date.now()}.token`);writeFileSync(supervisor,'owned caption test');
const log=path.join(root,`${mode}.log`),fd=openSync(log,'a'),report=path.join(root,`${mode}-cleanup.json`),env={...process.env,SLU_USER_DATA:path.join(root,`profile-${Date.now()}`),SLU_TEST_LOG:log,SLU_TEST_PARENT_PID:String(process.pid),SLU_TEST_SUPERVISOR_FILE:supervisor,SLU_TEST_CLEANUP_REPORT:report};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,[path.join(root,'probe.cjs')],{env,windowsHide:true,stdio:['ignore','pipe',fd]});let ready=false;
child.stdout.on('data',data=>{if(String(data).includes('READY')){ready=true;if(disconnect)rmSync(supervisor,{force:true});else child.stdout.destroy();}});
const timer=setTimeout(()=>rmSync(supervisor,{force:true}),15000);
try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(ready,true);assert.equal(code,1);const cleanup=JSON.parse(await fs.readFile(report,'utf8'));assert.equal(cleanup.windows,0);assert.match(cleanup.error,disconnect?/supervisor disconnected/i:/EPIPE|broken pipe/i);await fs.writeFile(path.join(root,disconnect?'parent-disconnect-results.json':'results.json'),JSON.stringify({passed:true,mode,code,cleanup,log},null,2));console.log(`${mode} regression passed; private caption renderer closed, zero remaining windows.`);}
finally{clearTimeout(timer);rmSync(supervisor,{force:true});closeSync(fd);}
