import path from 'node:path';
import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {installSpeechModel,transcribeMedia,type ServiceContext} from '../electron/services';
import {installSpeechEngine,speechCudaReady} from '../electron/speech';
import {probeMedia} from '../electron/media';
const dir=path.resolve('.test-artifacts/services');
const ctx:ServiceContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),whisper:path.resolve('resources/bin/whisper-cpu/Release/whisper-cli.exe'),modelDir:path.join(dir,'models'),cacheDir:path.join(dir,'cache')};
await mkdir(ctx.cacheDir,{recursive:true});let last=0;const progress=(p:number,m:string)=>{if(Date.now()-last>3000||p===1){console.log(`${Math.round(p*100)}% ${m}`);last=Date.now();}};
if(process.env.SLU_TEST_CUDA==='1')await installSpeechEngine(ctx,progress);
const results:any[]=[];
for(const model of (process.env.SLU_TEST_TURBO==='1'?['base','turbo']:['base']) as ('base'|'turbo')[]){
  await installSpeechModel(ctx,progress,undefined,model);
  for(const name of ['korean-heami.wav','jfk.wav']){
    const media=await probeMedia(path.join(dir,name),{ffmpeg:ctx.ffmpeg,ffprobe:ctx.ffprobe!,cacheDir:ctx.cacheDir});
    const start=performance.now();const cues=await transcribeMedia(media,name.startsWith('korean')?'ko':'en',ctx,progress,undefined,{model,device:process.env.SLU_TEST_CUDA==='1'?'cuda':'cpu',start:0,duration:media.duration,maxChars:28,maxDuration:4});
    assert.ok(cues.length>0);assert.ok(cues.every(c=>c.start>=0&&c.end<=media.duration+.01&&c.end>c.start&&c.end-c.start<=4.001&&Array.from(c.text).length<=28));
    results.push({model,name,seconds:(performance.now()-start)/1000,cues});
  }
}
const media=await probeMedia(path.join(dir,'korean-heami.wav'),{ffmpeg:ctx.ffmpeg,ffprobe:ctx.ffprobe!,cacheDir:ctx.cacheDir});
const clipped=await transcribeMedia(media,'ko',ctx,progress,undefined,{start:1.7,duration:3.9,model:'base',device:'cpu',maxChars:18,maxDuration:3});assert.ok(clipped.length>0);assert.ok(clipped.every(c=>c.start>=1.7&&c.end<=5.601));results.push({case:'source-range',cues:clipped});
const cancelled=new AbortController();cancelled.abort();await assert.rejects(()=>transcribeMedia(media,'ko',ctx,progress,cancelled.signal),{name:'AbortError'});
const activeCancel=new AbortController(),timer=setTimeout(()=>activeCancel.abort(),100);try{await assert.rejects(()=>transcribeMedia(media,'ko',ctx,progress,activeCancel.signal,{device:'cpu'}),{name:'AbortError'});}finally{clearTimeout(timer);}assert.equal((await readdir(ctx.cacheDir)).filter(name=>name.startsWith('speech-')).length,0);results.push({case:'in-flight-cancel',temporaryDirectories:0});
await writeFile(path.join(dir,'speech-upgrade-results.json'),JSON.stringify({cudaInstalled:await speechCudaReady(ctx),results},null,2));console.log(JSON.stringify(results,null,2));
