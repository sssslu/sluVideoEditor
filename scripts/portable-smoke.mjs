import {chromium} from 'playwright';
import {launchPrivateDesktop} from './quiet-desktop.mjs';
import {createServer} from 'node:net';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve('.test-artifacts/portable');await fs.mkdir(root,{recursive:true});
const profile=path.join(root,`profile-${Date.now()}`);await fs.mkdir(profile,{recursive:true});
const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const executable=path.resolve(`release/SLU-Studio-${version}-Windows-x64.exe`);await fs.access(executable);
const started=performance.now(),privateApp=await launchPrivateDesktop(executable,[`--remote-debugging-port=${port}`],{env});
let browser,cdp,browserOwned=false,result;
try{
  let ready=false;for(let i=0;i<240;i++){privateApp.assertRunning();try{const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}
  assert.ok(ready,'portable application must start its embedded Chromium');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  cdp=await browser.newBrowserCDPSession();const processes=await cdp.send('SystemInfo.getProcessInfo');
  const mainPid=processes.processInfo.find(process=>process.type==='browser')?.id;assert.ok(Number.isSafeInteger(mainPid));
  await privateApp.verifyProcess(mainPid);browserOwned=true;
  const context=browser.contexts()[0];let page=context.pages()[0];if(!page)page=await context.waitForEvent('page');
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor({timeout:30000});const startupSeconds=(performance.now()-started)/1000;
  assert.equal(await page.evaluate(()=>Object.hasOwn(window.studio,'downloadVideo')),false);assert.equal(await page.getByRole('button',{name:/영상 다운로드|URL 다운로드/}).count(),0);
  const system=await page.evaluate(()=>window.studio.getSystemInfo());assert.equal(system.version,version,'portable binary must match the current package version');assert.ok(system.encoders.includes('h264_nvenc'));
  const media=await page.evaluate(file=>new Promise((resolve,reject)=>{let asset,done=false;const pending=[];const normalize=value=>value.replaceAll('\\','/').toLowerCase();const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);off();error?reject(error):resolve(value);};const accept=m=>{if(m.thumbnail)finish(null,m);else finish(new Error('Background thumbnail generation finished without a thumbnail'));};const off=window.studio.onMediaUpdated(m=>{if(asset&&(m.id===asset.id||normalize(m.path)===normalize(asset.path)))accept(m);else pending.push(m);});const timer=setTimeout(()=>finish(new Error('Background thumbnail generation timed out after 60 seconds')),60000);void window.studio.importMedia([file]).then(assets=>{asset=assets[0];if(!asset)return finish(new Error('Bundled import returned no media'));if(asset.thumbnail)return finish(null,asset);const updated=pending.find(m=>m.id===asset.id||normalize(m.path)===normalize(asset.path));if(updated)accept(updated);}).catch(error=>finish(error));}),path.resolve('examples/01 - Aurora motion.mp4'));assert.equal(media.kind,'video');assert.ok(media.thumbnail);
  const playback=await page.evaluate(async media=>{const v=document.createElement('video');v.muted=true;v.style.cssText='position:fixed;left:-2000px;width:640px;height:360px';document.body.append(v);const waitEvent=(name,action)=>new Promise((resolve,reject)=>{const finish=error=>{clearTimeout(timer);v.removeEventListener(name,ready);v.removeEventListener('error',failed);error?reject(error):resolve();};const ready=()=>finish(),failed=()=>finish(new Error(`Bundled media ${name} failed`));const timer=setTimeout(()=>finish(new Error(`Bundled media ${name} timed out after 30 seconds`)),30000);v.addEventListener(name,ready,{once:true});v.addEventListener('error',failed,{once:true});action();});try{await waitEvent('loadeddata',()=>{v.src=window.studio.mediaUrl(media.path);});await waitEvent('seeked',()=>{v.currentTime=2;});await v.play();await new Promise(r=>setTimeout(r,500));return {width:v.videoWidth,height:v.videoHeight,time:v.currentTime};}finally{v.pause();v.remove();}},media);assert.equal(playback.width,1280);assert.ok(playback.time>2.2);
  const proxy=await page.evaluate(media=>new Promise((resolve,reject)=>{let id,done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);off();error?reject(error):resolve(value);};const off=window.studio.onJob(e=>{if(e.id!==id)return;if(e.status==='complete')finish(null,e);if(e.status==='error'||e.status==='cancelled')finish(new Error(e.message));});const timer=setTimeout(()=>finish(new Error('Bundled proxy encode timed out after 90 seconds')),90000);void window.studio.generateProxy(media).then(result=>{id=result.jobId;}).catch(error=>finish(error));}),media);assert.equal(proxy.status,'complete');assert.ok(proxy.media.proxyPath);
  await page.screenshot({path:path.join(root,'portable-running.png')});
  result={date:new Date().toISOString(),version,executable,startupSeconds,timingScope:'Private-desktop launch including helper setup, desktop creation, portable extraction and automation attachment; other application load is uncontrolled.',privateDesktop:privateApp.evidence,system,playback,checks:['Actual standalone portable wrapper launches embedded app','Binary version matches package.json','UI and secure bridge loaded','Video download UI and API absent','Bundled FFprobe/FFmpeg import and thumbnails','Custom media protocol seek and video playback','Actual NVIDIA hardware detection','Proxy encode through bundled binary'],proxyPath:proxy.media.proxyPath};
}finally{
  if(browser){if(browserOwned)await Promise.race([cdp.send('Browser.close').catch(()=>{}),new Promise(r=>setTimeout(r,1500))]);await Promise.race([browser.close().catch(()=>{}),new Promise(r=>setTimeout(r,1000))]);}
  await privateApp.close();
}
await fs.writeFile(path.join(root,'results.json'),JSON.stringify(result,null,2));
console.log(`Portable smoke passed; private-desktop editor observed after ${result.startupSeconds.toFixed(2)}s`);
