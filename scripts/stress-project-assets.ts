import {promises as fs,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {newProject,newClip} from '../shared/project';
import {runProcess,probeMedia} from '../electron/media';
import {saveProjectWithAssets,resolveProjectAssets} from '../electron/project-assets';
import {readProject,serializeProject} from '../electron/project-store';
import {insideDirectory} from '../electron/file-policy';

const root=path.resolve('.test-artifacts/project-assets-stress',Date.now().toString());await fs.mkdir(root,{recursive:true});
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')},file=path.join(root,'sixteen-minutes-uhd.mp4');
const digest=async(file:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-stream_loop','7','-i',path.resolve('.test-artifacts/tracking-stress-fixtures/uhd-30-120s.mp4'),'-map','0:v:0','-c','copy','-movflags','+faststart',file],{timeoutMs:120000});
const media=await probeMedia(file,ctx,undefined,{derivatives:false}),bytes=(await fs.stat(file)).size,sha256=await digest(file);assert.ok(bytes>1024**3);assert.ok(Math.abs(media.duration-960)<.01);
const project=newProject();project.media=[media];project.clips=Array.from({length:10000},(_,i)=>({...newClip('video-1',media,i),duration:1,in:i%900}));
const reports:Record<string,unknown>[]=[];
async function measure<T>(name:string,work:()=>Promise<T>){
  const start=performance.now();let last=start,maxGap=0,peakRss=process.memoryUsage().rss,ticks=0;
  const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;peakRss=Math.max(peakRss,process.memoryUsage().rss);},10);
  try{const value=await work();await new Promise(resolve=>setTimeout(resolve,15));reports.push({name,seconds:(performance.now()-start)/1000,maxGap,peakRss,ticks});return value;}finally{clearInterval(timer);}
}
const folder=path.join(root,'collection'),projectFile=path.join(folder,'edit.sluproj');
const saved=await measure('collect',()=>saveProjectWithAssets(project,projectFile,{collect:true}));
assert.equal(saved.fileReferences?.[0].sha256,sha256);assert.equal(saved.fileReferences?.[0].bytes,bytes);assert.equal(saved.clips.length,10000);assert.equal(await digest(saved.media[0].path),sha256);
// Both directory endpoints are owned children of this run, checked before move.
const actualRoot=await fs.realpath(root),moved=path.join(actualRoot,'moved');assert.ok(insideDirectory(await fs.realpath(folder),actualRoot));assert.ok(insideDirectory(path.resolve(moved),actualRoot));await fs.rename(folder,moved);
const movedProject=path.join(moved,'edit.sluproj'),opened=await measure('resolve after directory move',async()=>resolveProjectAssets(await readProject(movedProject),movedProject,path.join(root,'restored')));
assert.ok(insideDirectory(opened.media[0].path,moved));assert.equal(opened.clips.length,10000);assert.equal(await digest(opened.media[0].path),sha256);
const cancelFile=path.join(root,'cancel.sluproj'),previous=serializeProject({...project,name:'previous complete save'},true);await fs.writeFile(cancelFile,previous);
const controller=new AbortController();let cancelAt=0,cancelledAt=0;
await measure('cancel after copying over 40 percent',async()=>{
  await assert.rejects(saveProjectWithAssets(project,cancelFile,{collect:true,signal:controller.signal,progress:(value,message)=>{if(!cancelAt&&value>.6&&message.includes('복사 중')){cancelAt=performance.now();controller.abort();}}}),{name:'AbortError'});cancelledAt=performance.now();
});
assert.ok(cancelAt>0);assert.equal(await fs.readFile(cancelFile,'utf8'),previous);assert.deepEqual(await fs.readdir(path.join(root,'cancel.slu-data')),[]);assert.equal(await digest(file),sha256);
const sources=['electron/project-assets.ts','electron/file-digest.ts','electron/project-store.ts','scripts/stress-project-assets.ts'],sourceHashes=Object.fromEntries(await Promise.all(sources.map(async file=>[file,await digest(file)])));
await fs.writeFile(path.join(root,'results.json'),JSON.stringify({version:JSON.parse(await fs.readFile('package.json','utf8')).version,scope:'Source engine on this PC and filesystem, 10000 clips sharing one valid 1 GiB UHD file; process RSS and event-loop timers, not renderer/VRAM or external-drive testing',bytes,sha256,clips:project.clips.length,projectBytes:(await fs.stat(movedProject)).size,reports,cancelMs:cancelledAt-cancelAt,sourceHashes,passed:true},null,2));await fs.writeFile('.test-artifacts/project-assets-stress-current.txt',root);console.log(JSON.stringify({root,bytes,reports,cancelMs:cancelledAt-cancelAt}));
