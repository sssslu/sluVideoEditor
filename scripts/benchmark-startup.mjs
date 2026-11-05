import {chromium} from 'playwright';
import {execFile} from 'node:child_process';
import {launchPrivateDesktop} from './quiet-desktop.mjs';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';

// Launch the real binaries with ordinary Chromium flags. Profiles are disposable
// and owned by this run. Measurements never overwrite release smoke evidence.
const run=promisify(execFile),matrixIndex=process.argv.indexOf('--matrix');
const matrix=matrixIndex>=0?JSON.parse(await fs.readFile(process.argv[matrixIndex+1],'utf8')):undefined;
const version=matrix?.version||JSON.parse(await fs.readFile('package.json','utf8')).version;
const stamp=new Date().toISOString().replaceAll(':','-'),root=path.resolve('.test-artifacts/startup',stamp);
const localRoot=path.join(process.env.LOCALAPPDATA,'SLU-Studio-QA','startup',stamp);
await fs.mkdir(root,{recursive:true});await fs.mkdir(localRoot,{recursive:true});
const executables=matrix?.executables||{unpacked:path.resolve('release/win-unpacked/SLU Studio.exe'),portable:path.resolve(`release/SLU-Studio-${version}-Windows-x64.exe`)};
const evidence={version,startedAt:new Date().toISOString(),flags:[],observations:[],errors:[],
  timingScope:'Private-desktop launch to observed editor button in a fresh profile. Includes helper setup/compilation, desktop creation, portable extraction, OS launch/security scanning and automation attachment. OS caches, other application load and the effect of an inactive desktop are uncontrolled.',
  hashes:Object.fromEntries(await Promise.all(Object.entries(executables).map(async([name,file])=>[name,createHash('sha256').update(await fs.readFile(file)).digest('hex')])))};
const save=()=>fs.writeFile(path.join(root,'results.json'),JSON.stringify(evidence,null,2)+'\n');
await fs.copyFile(new URL(import.meta.url),path.join(root,'benchmark-script.mjs'));
async function measure(kind,profileLocation,index){
  const profile=path.join(profileLocation==='local'?localRoot:root,`${index}-${kind}`);await fs.mkdir(profile,{recursive:true});
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
  const wallStart=Date.now(),started=performance.now(),privateApp=await launchPrivateDesktop(executables[kind],[`--remote-debugging-port=${port}`],{env});
  let browser,cdp,browserOwned=false,result;
  try{
    let ready=false;const deadline=performance.now()+120000;
    while(performance.now()<deadline){
      privateApp.assertRunning();
      try{const response=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(300)});if(response.ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(ready,'Real application must start within120 seconds');const debuggerSeconds=(performance.now()-started)/1000;
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    cdp=await browser.newBrowserCDPSession();const processes=await cdp.send('SystemInfo.getProcessInfo');
    const mainPid=processes.processInfo.find(process=>process.type==='browser')?.id;assert.ok(Number.isSafeInteger(mainPid));
    await privateApp.verifyProcess(mainPid);browserOwned=true;
    const context=browser.contexts()[0];
    const page=context.pages()[0]||await context.waitForEvent('page',{timeout:30000});
    const pageErrors=[];page.on('pageerror',error=>pageErrors.push(String(error)));
    await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor({timeout:60000});
    const editorSeconds=(performance.now()-started)/1000;
    const navigation=await page.evaluate(()=>({navigation:performance.getEntriesByType('navigation').map(entry=>entry.toJSON()),paint:performance.getEntriesByType('paint').map(entry=>entry.toJSON())}));
    const info=await run('powershell.exe',['-NoProfile','-Command',`$p=Get-Process -Id ${mainPid}; @{started=$p.StartTime.ToUniversalTime().ToString('o');file=$p.Path}|ConvertTo-Json -Compress`],{windowsHide:true,timeout:20000});
    const processInfo=JSON.parse(info.stdout.trim()),mainCreated=Date.parse(processInfo.started);assert.ok(Number.isFinite(mainCreated));
    const system=await page.evaluate(()=>window.studio.getSystemInfo());const systemReadySeconds=(performance.now()-started)/1000;
    assert.equal(system.version,version);assert.deepEqual(pageErrors,[]);
    result={index,kind,profileLocation,profile,wallStart:new Date(wallStart).toISOString(),preAppSeconds:(mainCreated-wallStart)/1000,debuggerSeconds,editorSeconds,systemReadySeconds,mainPid,mainExecutable:processInfo.file,gpu:system.gpu,navigation,privateDesktop:privateApp.evidence};
    if(matrix?.verifyPayload){
      const extracted=path.dirname(processInfo.file),reference=path.resolve(matrix.verifyPayload);
      const files=async directory=>{const out=[];for(const item of await fs.readdir(directory,{withFileTypes:true})){if(item.isDirectory())for(const child of await files(path.join(directory,item.name)))out.push(path.join(item.name,child));else if(item.isFile())out.push(item.name);else throw Error('Unexpected packaged link');}return out.sort();};
      // electron-builder adds the NSIS-only elevation helper to win-unpacked
      // after building the portable ZIP. An explicitly declared omission is
      // limited to that helper; every application/runtime file must still match.
      const omissions=matrix.payloadOmissions?.[kind]||[];assert.ok(Array.isArray(omissions)&&omissions.every(name=>name==='resources/elevate.exe'));
      const allExpected=await files(reference),expected=allExpected.filter(name=>!omissions.includes(name.replaceAll('\\','/')));assert.equal(allExpected.length-expected.length,omissions.length);
      assert.deepEqual(await files(extracted),expected);result.payloadOmissions=omissions;
      for(const relative of expected){const digest=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');assert.equal(await digest(path.join(extracted,relative)),await digest(path.join(reference,relative)),relative);}
      result.payloadFiles=expected.length;
    }
  }finally{
    if(browser){if(browserOwned)await Promise.race([cdp.send('Browser.close').catch(()=>{}),new Promise(resolve=>setTimeout(resolve,2000))]);await Promise.race([browser.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,1000))]);}
    await privateApp.close();
  }
  evidence.observations.push(result);await save();console.log(JSON.stringify({index,kind,profileLocation,preAppSeconds:result.preAppSeconds,debuggerSeconds:result.debuggerSeconds,editorSeconds:result.editorSeconds,systemReadySeconds:result.systemReadySeconds}));
}
try{
  const cases=matrix?.cases||[['unpacked','local'],['portable','local'],['portable','workspace'],['unpacked','workspace'],['unpacked','workspace'],['portable','workspace'],['portable','local'],['unpacked','local']];
  for(let i=0;i<cases.length;i++)await measure(...cases[i],i);
  evidence.completedAt=new Date().toISOString();await save();console.log('Startup evidence:',root);
}catch(error){evidence.errors.push(String(error));await save();throw error;}
