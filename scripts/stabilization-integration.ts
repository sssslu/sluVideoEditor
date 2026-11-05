import {launchTestElectron} from './e2e-launch.mjs';
/** Run after: npx tsx --test tests/stabilization.test.ts
 * Repeats the difficult translation fixture and verifies actual Chromium PCM MOV playback. */
import {promises as fs,copyFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

import {probeMedia,runProcess} from '../electron/media';
import {stabilizeMedia,type StabilizationContext} from '../electron/stabilization';

const root=path.resolve('.test-artifacts/stabilization');
const fixture=JSON.parse(await fs.readFile(path.join(root,'results.json'),'utf8')) as {source:string;sourceHash:string};
const run=await fs.mkdtemp(path.join(root,'repeat-'));
const ctx:StabilizationContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(run,'cache'),derivedDir:path.join(run,'derived')};
const media=await probeMedia(fixture.source,ctx,undefined,{derivatives:false});
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
const results:Array<{frames:number;missingMarkers:number;translationVariance:number;motionHash:string;rgbHash:string;seconds:number}>=[];
let output='';const originalEnvironment=process.env.OMP_NUM_THREADS;
for(let index=0;index<20;index++){
  const motion=path.join(run,`motions-${index}.trf`),started=performance.now();
  const asset=await stabilizeMedia(media,{start:.137,duration:2.731,smoothing:15,accuracy:15,crop:'auto'},{...ctx,diagnostics:event=>{
    if(event.event==='stabilization-process'&&event.phase==='transform'){
      const directory=readdirSync(ctx.derivedDir!).find(name=>name.startsWith('.stabilize-'))!;
      copyFileSync(path.join(ctx.derivedDir!,directory,'transforms.trf'),motion);
    }
  }});output=asset.path;
  const seconds=(performance.now()-started)/1000;
  const raw=(await runProcess(ctx.ffmpeg,['-v','error','-i',output,'-an','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{maxOutputBytes:64*1024*1024})).stdout;
  const positions:Array<[number,number]>=[];let missingMarkers=0;
  for(let frame=0;frame<raw.length/(320*240*3);frame++){
    let count=0,sumX=0,sumY=0;
    for(let y=0;y<240;y++)for(let x=0;x<320;x++){
      const i=(frame*320*240+y*320+x)*3;
      if(raw[i]>160&&raw[i+1]<100&&raw[i+2]>160){count++;sumX+=x;sumY+=y;}
    }
    if(count<100)missingMarkers++;else positions.push([sumX/count,sumY/count]);
  }
  const meanX=positions.reduce((sum,p)=>sum+p[0],0)/positions.length,meanY=positions.reduce((sum,p)=>sum+p[1],0)/positions.length;
  const variance=positions.reduce((sum,p)=>sum+(p[0]-meanX)**2+(p[1]-meanY)**2,0)/positions.length;
  assert.equal(missingMarkers,0);assert.equal(positions.length,82);assert.ok(variance<1);
  results.push({frames:positions.length,missingMarkers,translationVariance:variance,motionHash:hash(await fs.readFile(motion)),rgbHash:hash(raw),seconds});
}
assert.equal(new Set(results.map(item=>item.motionHash)).size,1,'Motion analysis must be deterministic');
assert.equal(new Set(results.map(item=>item.rgbHash)).size,1,'Identical stabilization runs must yield identical decoded frames');
assert.equal(process.env.OMP_NUM_THREADS,originalEnvironment,'OpenMP override leaked into the parent environment');
assert.equal(hash(await fs.readFile(fixture.source)),fixture.sourceHash);

const env:Record<string,string>=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
env.SLU_USER_DATA=path.join(run,'electron-profile');delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({args:['.'],env});let playback;
try{
  const page=await app.firstWindow();await page.waitForFunction(()=>Boolean(window.studio));
  playback=await page.evaluate(async file=>{
    const [media]=await window.studio.importMedia([file]);const video=document.createElement('video');video.crossOrigin='anonymous';
    document.body.append(video);video.src=window.studio.mediaUrl(media.path);
    await new Promise<void>((resolve,reject)=>{video.onloadeddata=()=>resolve();video.onerror=()=>reject(new Error(video.error?.message||'Video decode failed'));});
    const audio=new AudioContext(),source=audio.createMediaElementSource(video),analyser=audio.createAnalyser(),muted=audio.createGain();
    muted.gain.value=0;source.connect(analyser);analyser.connect(muted);muted.connect(audio.destination);await audio.resume();await video.play();
    await new Promise(resolve=>setTimeout(resolve,500));const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
    const rms=Math.sqrt(samples.reduce((sum,sample)=>sum+sample*sample,0)/samples.length);
    const result={width:video.videoWidth,height:video.videoHeight,duration:video.duration,audioRms:rms,currentTime:video.currentTime,error:video.error?.message};
    video.pause();await audio.close();video.remove();return result;
  },output);
  assert.equal(playback.width,320);assert.equal(playback.height,240);assert.ok(playback.audioRms>.02);assert.ok(playback.currentTime>.25);assert.equal(playback.error,undefined);
}finally{await app.close();}
const report={generatedAt:new Date().toISOString(),repeats:results,playback,originalUnchanged:true,parentEnvironmentUnchanged:true,notes:['A pixel-preserving copy before vidstabtransform guarantees independent frame ownership and avoids the bundled libvidstab shared/writable-frame transition bug.','Single-thread OpenMP is scoped to stabilization subprocesses for reproducible field ordering; normal video decode/encode threading remains enabled.','Repeated runs cover a synthetic translation fixture, not all real-world camera motions.']};
await fs.writeFile(path.join(root,'repeat-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
