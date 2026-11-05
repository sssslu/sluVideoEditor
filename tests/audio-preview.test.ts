import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AudioPreviewCache} from '../electron/audio-preview';
import {runProcess} from '../electron/media';
import {readSourceRevision} from '../electron/source-revision';

const root=path.resolve('.test-artifacts/audio-preview'),ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,`cache-${Date.now()}`)};
const files:string[]=[];
before(async()=>{
  await fs.mkdir(root,{recursive:true});
  for(const [rate,channels,vbr] of [[48000,2,false],[44100,1,true],[24000,2,true]] as const){
    const file=path.join(root,`${rate}-${channels}.mp3`);files.push(file);
    await runProcess(ctx.ffmpeg,['-v','error','-y','-f','lavfi','-i',`sine=frequency=937:sample_rate=${rate}:duration=3.25`,'-ac',String(channels),'-c:a','libmp3lame',...(vbr?['-q:a','3']:['-b:a','128k']),file]);
  }
});
const hash=async(file:string)=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const pcm=async(file:string)=>(await runProcess(ctx.ffmpeg,['-v','error','-i',file,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
test('MP3 preview remux preserves every decoded source sample across rates, VBR and mono without changing originals',async()=>{
  const cache=new AudioPreviewCache(ctx);
  try{for(const source of files){const before=await hash(source),preview=await cache.prepare(source,await readSourceRevision(source)),a=await pcm(source),b=await pcm(preview);
    assert.ok(b.length>=a.length);assert.deepEqual(b.subarray(0,a.length),a);assert.equal(await hash(source),before);
    const info=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-show_streams','-show_format','-of','json',preview])).stdout.toString());assert.equal(info.streams.length,1);assert.equal(info.streams[0].codec_name,'mp3');assert.equal(Number(info.format.start_time),0);
  }}finally{await cache.close();}
});
test('Concurrent preview requests share one process, reuse the cache and reject stale source revisions',async()=>{
  let starts=0;const cache=new AudioPreviewCache({...ctx,cacheDir:path.join(ctx.cacheDir,'concurrent'),diagnostics:()=>starts++});
  try{const source=files[0],revision=await readSourceRevision(source),paths=await Promise.all(Array.from({length:8},()=>cache.prepare(source,revision)));assert.equal(new Set(paths).size,1);assert.equal(starts,1);assert.equal(await cache.prepare(source,revision),paths[0]);assert.equal(starts,1);await assert.rejects(cache.prepare(source,'0'.repeat(64)),/변경/);
  }finally{await cache.close();}await assert.rejects(cache.prepare(files[0]),{name:'AbortError'});
});
test('Closing cancels an active preview process and cleans partial files',async()=>{
  let spawned!:()=>void;const started=new Promise<void>(resolve=>spawned=resolve),directory=path.join(ctx.cacheDir,'cancel');
  const cache=new AudioPreviewCache({...ctx,cacheDir:directory,diagnostics:()=>spawned()});
  const work=cache.prepare(files[0]);const rejected=assert.rejects(work,{name:'AbortError'});await started;await cache.close();await rejected;
  assert.equal((await fs.readdir(directory)).filter(file=>file.includes('.partial.')).length,0);
});
