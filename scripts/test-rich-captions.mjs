import {build as esbuild} from 'esbuild';
import {build as viteBuild} from 'vite';
import {spawn} from 'node:child_process';
import path from 'node:path';
import electron from 'electron';
import {openSync,closeSync,writeFileSync,rmSync,promises as fs} from 'node:fs';

const benchmark=process.argv.includes('--benchmark'),root=path.resolve(`.test-artifacts/rich-captions${benchmark?'/benchmark':''}`);await fs.mkdir(root,{recursive:true});
if(!benchmark)await viteBuild({configFile:false,base:'./',build:{outDir:path.join(root,'reference'),emptyOutDir:false,target:'esnext',rollupOptions:{input:'tests/caption-reference.html'}}});
await esbuild({entryPoints:[benchmark?'tests/caption-benchmark-host.ts':'tests/caption-export-host.ts'],outfile:path.join(root,'host.cjs'),bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron']});
const supervisor=path.join(root,`supervisor-${process.pid}-${Date.now()}.token`);writeFileSync(supervisor,'owned caption test');
const log=path.join(root,`host-${Date.now()}.log`),fd=openSync(log,'a'),env={...process.env,SLU_USER_DATA:path.join(root,`profile-${Date.now()}`),SLU_TEST_PARENT_PID:String(process.pid),SLU_TEST_SUPERVISOR_FILE:supervisor,SLU_TEST_LOG:log,SLU_TEST_CLEANUP_REPORT:path.join(root,'cleanup.json')};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,[path.join(root,'host.cjs')],{env,stdio:['ignore',fd,fd],windowsHide:true});
let closed=false,stopping=false,forceKillTimer;child.once('close',()=>{closed=true;clearTimeout(forceKillTimer);});
const detach=()=>{try{rmSync(supervisor,{force:true});}catch{}};
const stop=()=>{if(closed||stopping)return;stopping=true;detach();forceKillTimer=setTimeout(()=>{if(!closed&&child.pid)spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});},6000);forceKillTimer.unref();};
process.once('exit',detach);
process.once('SIGINT',stop);process.once('SIGTERM',stop);const timeout=setTimeout(stop,300000);
try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});process.exitCode=Number(code??1);const report=JSON.parse(await fs.readFile(path.join(root,code===0?'results.json':'failure.json'),'utf8'));console.log(JSON.stringify({code,log,checks:report.checks,error:report.error,...(benchmark?{details:report.details}:{})},null,2));}
finally{clearTimeout(timeout);clearTimeout(forceKillTimer);process.off('SIGINT',stop);process.off('SIGTERM',stop);process.off('exit',detach);detach();closeSync(fd);}
