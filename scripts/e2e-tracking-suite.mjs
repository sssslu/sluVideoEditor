import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {trackingSuites,trackingEvidence,testExecutable} from './e2e-release-evidence.mjs';

const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
console.log(`slu-video-editor@${version} tracking ${testExecutable()?'packaged':'source'}`);
for(const suite of trackingSuites){
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['scripts/'+suite.script],{env:process.env,windowsHide:true,stdio:'inherit'});
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${suite.name} exited ${code}`)));
  });
}
const reports=await trackingEvidence({packaged:!!testExecutable()});
console.log(JSON.stringify({version,suites:reports.length,checks:reports.reduce((n,r)=>n+r.checks.length,0)}));
