import path from 'node:path';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { installSpeechModel, transcribeMedia, modelReady } from '../electron/services';
import type { ServiceContext } from '../electron/services';
import type { MediaAsset } from '../shared/types';

async function main() {
  const root = path.resolve('.test-artifacts/services');
  await mkdir(root, { recursive: true });
  const ctx: ServiceContext = {ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),modelDir:path.join(root,'models'),cacheDir:path.join(root,'cache')};
  let last = '';
  const progress = (p:number,message:string) => {const status=`${Math.floor(p*20)*5}% ${message.split(' · ')[0]}`;if(status!==last){console.log(status);last=status;}};
  await installSpeechModel(ctx,progress);
  assert.ok(await modelReady(ctx));
  const sample = path.join(root,'jfk.wav');
  const response = await fetch('https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav');
  assert.ok(response.ok);
  await writeFile(sample,Buffer.from(await response.arrayBuffer()));
  const media:MediaAsset = {id:'test-jfk',name:'jfk.wav',path:sample,kind:'audio',duration:11,width:0,height:0,fps:0,hasAudio:true};
  const started = performance.now();
  const cues = await transcribeMedia(media,'en',ctx,progress);
  const elapsed = (performance.now()-started)/1000;
  assert.ok(cues.length>0,'Expected speech cues');
  assert.match(cues.map(c=>c.text).join(' '),/country/i);
  assert.ok(cues.every(c=>c.end>c.start&&c.start>=0&&c.end<=11));
  console.log(JSON.stringify({transcriptionSeconds:elapsed,cues},null,2));
  const cancelContext = {...ctx,modelDir:path.join(root,`cancel-model-${Date.now()}`)};
  const modelAbort = new AbortController();
  await assert.rejects(installSpeechModel(cancelContext,(p)=>{if(p>0)modelAbort.abort();},modelAbort.signal),{name:'AbortError'});
  assert.equal(await modelReady(cancelContext),false);
  assert.deepEqual(await readdir(cancelContext.modelDir),[],'Cancelled model must not leave .part files');
  console.log('Partially downloaded model cancellation verified; no ready model or partial file remains.');
  const speechAbort = new AbortController();
  const speechTimer = setTimeout(()=>speechAbort.abort(),250);
  try { await assert.rejects(transcribeMedia(media,'en',ctx,()=>{},speechAbort.signal),{name:'AbortError'}); }
  finally {clearTimeout(speechTimer);}
  assert.ok(!(await readdir(ctx.modelDir)).some(f=>f.startsWith('captions-')),'Cancelled FFmpeg must not leave captions');
  console.log('Running FFmpeg speech process cancellation verified.');
  await writeFile(path.join(root,'results.json'),JSON.stringify({date:new Date().toISOString(),transcriptionSeconds:elapsed,cues,modelCancellation:true,speechProcessCancellation:true},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
