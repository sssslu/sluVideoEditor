import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createProxy,runProcess} from '../electron/media';
import type {Project} from '../shared/types';

const root=path.resolve(process.argv[2]||(await fs.readFile('.test-artifacts/matting-long/current.txt','utf8')).trim());
const project:Project=JSON.parse(await fs.readFile(path.join(root,'review.sluproj'),'utf8'));
const asset=project.media.find(m=>m.hasAlpha)!;assert.ok(asset);
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
async function times(file:string){const data=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts_time','-of','json',file],{maxOutputBytes:8*1024*1024})).stdout.toString());return data.packets.map((p:{pts_time:string})=>Number(p.pts_time)).sort((a:number,b:number)=>a-b) as number[];}
const start=performance.now();let last=-1;
const updated=await createProxy(asset,ctx,(progress)=>{const bucket=Math.floor(progress*10);if(bucket!==last){last=bucket;console.log(`proxy ${bucket*10}%`);}});
const proxyMs=performance.now()-start,native=await times(asset.path),old=await times(asset.proxyPath!),actual=await times(updated.proxyPath!);
assert.equal(actual.length,native.length);assert.notEqual(updated.proxyPath,asset.proxyPath);
const error=(values:number[])=>Math.max(...native.map((time,n)=>Math.abs(time-values[n])));
assert.ok(error(actual)<=.001,`Proxy clock error ${error(actual)}`);
project.media=project.media.map(m=>m.id===updated.id?updated:m);
const review=path.join(root,'review-timing.sluproj');await fs.writeFile(review,JSON.stringify(project));
const report={passed:true,frames:native.length,previousMaxSeconds:error(old),correctedMaxSeconds:error(actual),proxyMs,proxy:updated.proxyPath,review,nativeTimes:native,proxyTimes:actual};
await fs.writeFile(path.join(root,'proxy-timing-results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,nativeTimes:undefined,proxyTimes:undefined}));
