import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';

import path from 'node:path';
import {promises as fs} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';

const directory=path.resolve('.test-artifacts/source-revision/ipc');await fs.mkdir(directory,{recursive:true});
const work=await fs.mkdtemp(path.join(directory,'run-')),profile=path.join(work,'profile'),source=path.join(work,'source.mp4');
const run=promisify(execFile),ffmpeg=path.resolve('resources/bin/ffmpeg.exe');
const encode=async(color,duration=2,target=path.join(work,`${color}.mp4`))=>{await run(ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i',`color=c=${color}:s=320x180:r=30:d=${duration}`,'-c:v','libx264','-pix_fmt','yuv420p',target],{windowsHide:true});return target;};
const red=await encode('red'),blue=await encode('blue'),green=await encode('lime',1.5);await fs.copyFile(red,source);
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null,env={...process.env,SLU_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000});
const checks=[],errors=[],colors=[];let version;
try{
 const page=await app.firstWindow();page.on('pageerror',error=>errors.push(String(error)));page.on('dialog',dialog=>dialog.accept());
 await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();await page.evaluate(()=>{window.revisionWarnings=[];window.studio.onProjectWarning(message=>window.revisionWarnings.push(message));});
 version=(await page.evaluate(()=>window.studio.getSystemInfo())).version;assert.equal(version,JSON.parse(await fs.readFile('package.json','utf8')).version);
 const importSource=async file=>(await page.evaluate(file=>window.studio.importMedia([file]),file))[0];
 const initial=await importSource(source);assert.match(initial.sourceRevision,/^[a-f0-9]{64}$/);
 const template=JSON.parse(await fs.readFile('examples/AURORA.sluproj','utf8')),base=template.clips.find(c=>c.mediaId);
 const project={...template,id:'same-path-project',version:3,name:'same-path-project',width:320,height:180,media:[initial],clips:[{...base,id:'same-clip',mediaId:initial.id,trackId:'video-1',in:0,start:0,duration:1.5,speed:1,speedCurve:undefined,volume:0,fadeIn:0,fadeOut:0,opacity:1,x:0,y:0,scale:1,rotation:0,keyframes:[],sourceClipOffset:undefined,sourceClipDuration:undefined}],transitions:[]};
 const file=path.join(work,'same-path-project.sluproj');await fs.writeFile(file,JSON.stringify(project));
 const choose=async file=>app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
 const load=async file=>{while(await page.getByTitle('알림 닫기',{exact:true}).count())await page.getByTitle('알림 닫기',{exact:true}).first().click();await choose(file);await page.keyboard.press('Control+o');await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();};
 const sample=async()=>{
  await page.waitForFunction(()=>{const r=document.querySelector('.preview-gpu-stage')?.previewRuntime,n=r&&[...r.nodes.values()][0];return n?.loaded&&!n.failed&&n.element.readyState>=2&&!n.element.seeking&&!r.stats()?.seeking;});
  return page.locator('.preview-gpu-stage').evaluate(async stage=>{const r=stage.previewRuntime,n=[...r.nodes.values()][0],img=new Image();img.src=r.snapshot();await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const c=canvas.getContext('2d');c.drawImage(img,0,0);return {pixel:[...c.getImageData(img.width/2,img.height/2,1,1).data],key:n.key,url:n.url,revision:n.media.sourceRevision};});
 };
 await load(file);const first=await sample();assert.ok(first.pixel[0]>220&&first.pixel[2]<30);colors.push(first);
 await fs.copyFile(blue,source);const fresh=await importSource(source);assert.notEqual(fresh.sourceRevision,initial.sourceRevision);
 const originalDisk=await fs.readFile(file,'utf8');await choose(file);const refreshed=await page.evaluate(()=>window.studio.openProject());
 assert.equal(refreshed.modified,true);assert.equal(refreshed.project.media[0].id,initial.id);assert.equal(refreshed.project.media[0].sourceRevision,fresh.sourceRevision);assert.equal(await fs.readFile(file,'utf8'),originalDisk);
 await load(file);const second=await sample();assert.ok(second.pixel[2]>220&&second.pixel[0]<30);assert.notEqual(second.key,first.key);assert.notEqual(second.url,first.url);colors.push(second);
 checks.push('Same-path red→blue replacement reloads the decoder and GPU texture when reopening the same project/clip IDs; saved file remains unchanged and open.modified is true');

 const proxy=await page.evaluate(media=>new Promise(async(resolve,reject)=>{let id;const off=window.studio.onJob(event=>{if(event.id!==id)return;if(event.status==='complete'){off();resolve(event.media);}else if(event.status==='error'||event.status==='cancelled'){off();reject(new Error(event.message));}});try{id=(await window.studio.generateProxy(media)).jobId;}catch(error){off();reject(error);}}),{...fresh,id:initial.id});
 assert.ok(proxy.proxyPath);const withProxy={...refreshed.project,media:[proxy]};await fs.writeFile(file,JSON.stringify(withProxy));await load(file);const proxyBefore=await sample();assert.ok(proxyBefore.pixel[2]>220);assert.ok(proxyBefore.url.includes(encodeURIComponent(path.basename(proxy.proxyPath)))||proxyBefore.url.includes('-proxy.mp4'));
 await page.getByRole('button',{name:'source.mp4 소스 열기',exact:true}).click();await page.getByLabel('소스 시작점',{exact:true}).fill('1.4');await page.getByLabel('소스 끝점',{exact:true}).fill('1.9');
 await fs.copyFile(green,source);await choose(source);await page.getByRole('button',{name:'가져오기',exact:true}).first().click();await page.getByText('1개 미디어를 가져왔습니다.',{exact:true}).waitFor();
 await page.waitForFunction(old=>document.querySelector('.source-view video')?.currentSrc.includes('revision=')&&!document.querySelector('.source-view video')?.currentSrc.includes(old),fresh.sourceRevision);
 await page.waitForFunction(()=>{const element=document.querySelector('.source-view video');return element?.readyState>=2&&!element.seeking;});
 assert.equal(await page.getByLabel('소스 시작점',{exact:true}).inputValue(),'0');assert.equal(await page.getByLabel('소스 끝점',{exact:true}).inputValue(),'1.5');
 const nativeImage=path.join(work,'source-monitor-green.png');await page.locator('.source-view video').screenshot({path:nativeImage});
 const nativePixel=await run(ffmpeg,['-v','error','-i',nativeImage,'-vf','crop=1:1:iw/2:ih/2','-pix_fmt','rgb24','-f','rawvideo','-'],{windowsHide:true,encoding:'buffer'});assert.ok(nativePixel.stdout[1]>220&&nativePixel.stdout[2]<30);
 checks.push('Reimporting the same source path reloads the active source monitor and discards its obsolete I/O range');
 await page.getByRole('button',{name:'프로그램',exact:true}).click();const third=await sample();assert.ok(third.pixel[1]>220&&third.pixel[2]<30);assert.equal(third.url.includes('-proxy.mp4'),false);colors.push(third);
 checks.push('Changed original invalidates a previously generated proxy and displays the new source instead');

 // A replacement participant with insufficient actual frames detaches only the
 // transition in the returned snapshot, retaining both clips and the saved file.
 const current=await importSource(source),cuts={...project,id:'replacement-cuts',name:'replacement-cuts',media:[{...current,id:initial.id}],clips:[{...project.clips[0],id:'a',in:.5,duration:.5},{...project.clips[0],id:'b',in:.5,start:.5,duration:.5}],transitions:[{id:'ab',fromClipId:'a',toClipId:'b',kind:'dissolve',durationFrames:15}]};
 const cutFile=path.join(work,'replacement-cuts.sluproj'),cutDisk=JSON.stringify(cuts);await fs.writeFile(cutFile,cutDisk);await encode('white',.6,source);await choose(cutFile);const shortened=await page.evaluate(()=>window.studio.openProject());
 assert.equal(shortened.project.transitions,undefined);assert.deepEqual(shortened.project.clips,JSON.parse(cutDisk).clips);assert.equal(await fs.readFile(cutFile,'utf8'),cutDisk);
 checks.push('Actual insufficient replacement bounds detach the invalid transition without modifying clips or the saved file');

 // Relative relinking passes through the same participant-range validation.
 const relinkedFile=path.join(work,'relative-relink.sluproj'),relink={...cuts,id:'relative-relink',name:'relative-relink',media:[{...cuts.media[0],path:path.join(work,'missing','source.mp4')}]};await fs.writeFile(relinkedFile,JSON.stringify(relink));await choose(relinkedFile);const linked=await page.evaluate(()=>window.studio.openProject());
 assert.equal(linked.project.media[0].path,source);assert.equal(linked.project.transitions,undefined);assert.equal(linked.modified,true);assert.deepEqual(linked.missing,[]);
 checks.push('Automatic relative relinking validates actual participant ranges before returning a renderable project');
 const manualFile=path.join(work,'manual-relink.sluproj');await fs.writeFile(manualFile,JSON.stringify({...relink,id:'manual-relink',media:[{...relink.media[0],path:path.join(work,'missing','unavailable.mp4')}]}));
 await app.evaluate(({dialog},{file,source})=>{dialog.showMessageBox=async()=>({response:0});dialog.showOpenDialog=async(...args)=>({canceled:false,filePaths:[args.at(-1)?.title?.includes('다시 연결')?source:file]});},{file:manualFile,source});
 const manual=await page.evaluate(()=>window.studio.openProject());assert.equal(manual.project.media[0].path,source);assert.equal(manual.project.transitions,undefined);assert.equal(manual.modified,true);
 checks.push('Manual relinking follows the same validated range/reconcile transaction');

 // Cancel before a refresh probe starts: no partial asset/project completion.
 await choose(file);const cancelled=await page.evaluate(async()=>{const events=[];let requested=false;const off=window.studio.onJob(event=>{if(event.type!=='range')return;events.push(event);if(event.status==='running'&&!requested){requested=true;void window.studio.cancelJob(event.id);}});try{let error;try{await window.studio.openProject();}catch(value){error=String(value);}await new Promise(resolve=>setTimeout(resolve,100));return {error,events};}finally{off();}});
 assert.match(cancelled.error,/취소/);assert.ok(cancelled.events.some(event=>event.status==='cancelled'));assert.equal(cancelled.events.some(event=>event.status==='complete'),false);
 checks.push('Cancelling refresh rejects open without publishing a partial project');
 await fs.writeFile(source,'invalid media');await choose(file);const invalid=await page.evaluate(async()=>{try{await window.studio.openProject();return false;}catch{return true;}});assert.equal(invalid,true);checks.push('Invalid replacement rejects project loading rather than returning stale metadata');
 const warnings=await page.evaluate(()=>window.revisionWarnings);assert.ok(warnings.some(message=>message.includes('전환 1개')));assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(directory,'results.json'),JSON.stringify({date:new Date().toISOString(),version,executable,checks,errors,profile,colors,warnings},null,2));console.log('Source revision desktop integration passed',checks.length);
}catch(error){await fs.writeFile(path.join(directory,'failure.json'),JSON.stringify({version,checks,errors,colors,error:String(error),profile},null,2));throw error;}finally{await app.close();}
