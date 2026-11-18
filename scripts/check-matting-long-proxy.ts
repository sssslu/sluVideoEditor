import {promises as fs,createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProxy,runProcess} from '../electron/media';
import {proxyCacheKey,hasLegacyProxyTiming} from '../electron/proxy-cache';
import type {Project} from '../shared/types';

const root=path.resolve(process.argv[2]||(await fs.readFile('.test-artifacts/matting-long/current.txt','utf8')).trim());
const project:Project=JSON.parse(await fs.readFile(path.join(root,'review.sluproj'),'utf8'));
const asset=project.media.find(m=>m.hasAlpha)!;assert.ok(asset);
assert.ok(asset.proxyPath,'Long fixture must contain its original verified proxy');
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const hash=async(file:string)=>{const digest=createHash('sha256');for await(const chunk of createReadStream(file))digest.update(chunk);return digest.digest('hex');};
const previousStat=await fs.stat(asset.proxyPath),previousHash=await hash(asset.proxyPath);
async function times(file:string){const data=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts_time','-of','json',file],{maxOutputBytes:8*1024*1024})).stdout.toString());return data.packets.map((p:{pts_time:string})=>Number(p.pts_time)).sort((a:number,b:number)=>a-b) as number[];}
const start=performance.now();let last=-1;
const updated=await createProxy(asset,ctx,(progress)=>{const bucket=Math.floor(progress*10);if(bucket!==last){last=bucket;console.log(`proxy ${bucket*10}%`);}});
const proxyMs=performance.now()-start,native=await times(asset.path),old=await times(asset.proxyPath!),actual=await times(updated.proxyPath!);
assert.equal(updated.sourceRevision,asset.sourceRevision,'Fixture source changed during proxy verification');assert.equal(updated.hasAlpha,true);
const expected=path.join(ctx.cacheDir,`${proxyCacheKey(updated)}-alpha-proxy.webm`),reused=path.resolve(asset.proxyPath)===path.resolve(expected);
assert.equal(path.resolve(updated.proxyPath!),path.resolve(expected),'Proxy must use the current cache generation and source identity');
assert.equal(actual.length,native.length);
if(hasLegacyProxyTiming(asset))assert.equal(reused,false,'Legacy proxy must migrate to the current path');
if(reused){assert.equal(updated.proxyPath,asset.proxyPath);assert.equal((await fs.stat(asset.proxyPath)).mtimeMs,previousStat.mtimeMs,'Current proxy must be reused without rewriting it');}
else assert.notEqual(updated.proxyPath,asset.proxyPath,'Older or externally named proxy must use the current cache path');
assert.equal(await hash(asset.proxyPath),previousHash,'Generating or reusing a proxy must preserve the previous file');
const error=(values:number[])=>Math.max(...native.map((time,n)=>Math.abs(time-values[n])));
assert.ok(error(actual)<=.001,`Proxy clock error ${error(actual)}`);
project.media=project.media.map(m=>m.id===updated.id?updated:m);
const review=path.join(root,'review-timing.sluproj');await fs.writeFile(review,JSON.stringify(project));
const report={passed:true,frames:native.length,reused,previousPreserved:true,previousMaxSeconds:error(old),correctedMaxSeconds:error(actual),proxyMs,proxy:updated.proxyPath,review,nativeTimes:native,proxyTimes:actual};
await fs.writeFile(path.join(root,'proxy-timing-results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,nativeTimes:undefined,proxyTimes:undefined}));
