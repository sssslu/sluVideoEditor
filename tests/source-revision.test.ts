import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newClip,newProject} from '../shared/project';
import {assertMedia} from '../shared/validation';
import {mergeAsset} from '../src/editor';
import {probeMedia,runProcess,type EngineContext} from '../electron/media';
import {readSourceRevision,sourceRevisionFromStat} from '../electron/source-revision';
import {changedProjectSources,refreshProjectSources} from '../electron/project-sources';
import type {MediaAsset} from '../shared/types';

const revisionA='a'.repeat(64),revisionB='b'.repeat(64);
const media:MediaAsset={id:'m',name:'m',path:'C:/source.mp4',kind:'video',duration:40,videoStart:0,videoEnd:40,width:320,height:180,fps:30,hasAudio:true,sourceRevision:revisionA,proxyPath:'current-color-proxy.mp4',thumbnail:'thumb.jpg',waveform:[1,.5]};
const root=path.resolve('.test-artifacts/source-revision'),ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),ffprobe=path.resolve('resources/bin/ffprobe.exe');
const ff=(args:string[])=>runProcess(ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:60000});

test('source revision includes size, mtime, ctime and actual file identity',()=>{
 const stat={size:100,mtimeMs:1000,ctimeMs:2000,ino:10,dev:2},base=sourceRevisionFromStat(media.path,stat);
 assert.equal(base.length,64);assert.equal(base,sourceRevisionFromStat(media.path,{...stat}));
 for(const field of ['size','mtimeMs','ctimeMs','ino','dev'] as const)assert.notEqual(base,sourceRevisionFromStat(media.path,{...stat,[field]:stat[field]+1}));
 assertMedia({...media,sourceRevision:base});assert.throws(()=>assertMedia({...media,sourceRevision:'untrusted'}));
});

test('fresh revision drops previous proxies, thumbnails, waveform and exact range without changing asset identity',()=>{
 const updated=mergeAsset(media,{sourceRevision:revisionB,duration:2,hasAudio:false});
 assert.equal(updated.id,media.id);assert.equal(updated.duration,2);assert.equal(updated.hasAudio,false);
 for(const field of ['proxyPath','thumbnail','waveform','videoStart','videoEnd'] as const)assert.equal(updated[field],undefined);
 const same=mergeAsset(media,{sourceRevision:revisionA,waveform:[.3]});assert.equal(same.proxyPath,media.proxyPath);assert.equal(same.videoEnd,40);
 assert.equal(mergeAsset(media,{sourceRevision:revisionB,videoStart:.5,videoEnd:2}).videoStart,.5);
});

test('source refresh scans only changed transition videos, preserves valid cuts, rejects invalid files and cancellation',{timeout:60000},async()=>{
 await fs.mkdir(root,{recursive:true});const work=await fs.mkdtemp(path.join(root,'run-')),source=path.join(work,'original.mp4');
 const ctx:EngineContext={ffmpeg,ffprobe,cacheDir:path.join(work,'cache')};
 await ff(['-f','lavfi','-i','testsrc2=s=160x90:r=25:d=2','-c:v','libx264',source]);
 const original=await probeMedia(source,ctx,undefined,{derivatives:false}),p=newProject();p.media=[{...original,proxyPath:'original-color-proxy.mp4',waveform:[.5]}];
 p.clips=[{...newClip('video-1',original),id:'a',in:.5,duration:.5},{...newClip('video-1',original,.5),id:'b',in:.5,duration:.5}];
 p.transitions=[{id:'ab',fromClipId:'a',toClipId:'b',kind:'dissolve',durationFrames:15}];
 assert.equal((await changedProjectSources(p)).size,0);
 await ff(['-f','lavfi','-i','testsrc2=s=160x90:r=25:d=2','-vf',"select='lt(n,20)+gte(n,20)*not(mod(n,3))'",'-fps_mode:v','vfr','-enc_time_base:v','filter','-c:v','libx264',source]);
 const changed=await changedProjectSources(p);assert.equal(changed.size,1);assert.notEqual(await readSourceRevision(source),original.sourceRevision);
 const serialized=JSON.stringify(p),events:Record<string,unknown>[]=[];
 const ordinary=await refreshProjectSources({...p,transitions:undefined},changed,{...ctx,diagnostics:event=>events.push(event)});
 assert.equal(ordinary.project.media[0].videoEnd,undefined);assert.equal(events.some(event=>event.event==='video-range-process'),false);
 const refreshed=await refreshProjectSources(p,changed,{...ctx,diagnostics:event=>events.push(event)});
 assert.equal(refreshed.project.media[0].videoEnd,2.04);assert.equal(refreshed.project.media[0].duration,2.04);assert.equal(refreshed.detachedTransitions,0);
 assert.equal(refreshed.project.media[0].proxyPath,undefined);assert.equal(refreshed.project.media[0].id,original.id);assert.equal(JSON.stringify(p),serialized);
 assert.ok(events.some(event=>event.event==='video-range-process'));
 await ff(['-f','lavfi','-i','testsrc2=s=160x90:r=25:d=0.6','-c:v','libx264',source]);
 const short=await refreshProjectSources(p,await changedProjectSources(p),ctx);assert.equal(short.detachedTransitions,1);assert.equal(short.project.transitions,undefined);assert.equal(short.project.clips,p.clips);
 await fs.writeFile(source,'invalid media bytes');await assert.rejects(refreshProjectSources(p,await changedProjectSources(p),ctx),/실패|시간|스트림/);assert.equal(JSON.stringify(p),serialized);
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(refreshProjectSources(p,changed,ctx,undefined,cancelled.signal),error=>error instanceof Error&&error.name==='AbortError');
 await fs.writeFile(path.join(root,'results.json'),JSON.stringify({date:new Date().toISOString(),unchangedStatOnly:true,ordinaryVfrScan:false,transitionVfrEnd:refreshed.project.media[0].videoEnd,sourceChanged:refreshed.project.media[0].sourceRevision!==original.sourceRevision,staleProxyRemoved:true,insufficientSourceDetached:short.detachedTransitions,invalidFileRejected:true,cancelledRejected:true},null,2));
});
