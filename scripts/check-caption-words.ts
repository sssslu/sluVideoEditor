import path from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {transcribeWithCLI} from '../electron/speech';
import {probeMedia} from '../electron/media';
import {assertCaptionWords} from '../shared/captions';
import {newClip} from '../shared/project';
import {sourceCuesToTimeline} from '../shared/processing';

// Prerequisites: npm run pretest:e2e and the local multilingual base model.
const directory=path.resolve('.test-artifacts/caption-words');await mkdir(directory,{recursive:true});
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),whisper:path.resolve('resources/bin/whisper-cpu/Release/whisper-cli.exe'),modelDir:path.resolve('.test-artifacts/services/models'),cacheDir:path.join(directory,'cache')};
const hash=async(file:string)=>createHash('sha256').update(await readFile(file)).digest('hex');
const sources=['electron/speech.ts','shared/processing.ts','shared/captions.ts','shared/speed.ts','scripts/check-caption-words.ts'];
const sourceHashes=Object.fromEntries(await Promise.all(sources.map(async file=>[file,await hash(file)])));
const results=[];
for(const [name,language]of [['jfk','en'],['korean-heami','ko']]){
  const file=path.resolve(`tests/fixtures/${name}.wav`),media=await probeMedia(file,ctx,undefined,{derivatives:false});
  const cues=await transcribeWithCLI(media,language,ctx,()=>{},undefined,{model:'base',device:'cpu',start:.2,duration:media.duration-.2,maxChars:28,maxDuration:4});
  let measured=0,estimated=0;for(const cue of cues){assert.ok(cue.start>=.2&&cue.end<=media.duration);assertCaptionWords(cue.text,cue.words??[],cue.start,cue.end);measured+=(cue.words??[]).filter(word=>word.timing==='measured').length;estimated+=(cue.words??[]).filter(word=>word.timing==='estimated').length;}
  assert.ok(cues.length>0&&measured>0,'Actual model must return measured token intervals');
  const clip={...newClip('video-1',media),in:.2,start:5,duration:3,speedCurve:[{position:0,speed:.5},{position:.5,speed:2},{position:1,speed:1}]};
  const mapped=sourceCuesToTimeline(clip,cues);assert.ok(mapped.length>0);mapped.forEach(cue=>assertCaptionWords(cue.text,cue.words??[],cue.start,cue.end));
  results.push({name,language,fixtureSha256:await hash(file),sourceDuration:media.duration,cues:cues.length,measuredWords:measured,estimatedWords:estimated,sourceCues:cues,timelineCues:mapped});
}
for(const [file,expected]of Object.entries(sourceHashes))assert.equal(await hash(file),expected,'Sources changed during inference');
const version=JSON.parse(await readFile('package.json','utf8')).version;
const report={passed:true,version,engine:'whisper.cpp 1.8.7 CPU',model:'multilingual base',sourceHashes,engineSha256:await hash(ctx.whisper),modelSha256:await hash(path.join(ctx.modelDir,'ggml-base.bin')),tests:results};
await writeFile(path.join(directory,'results.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:true,version,results:results.map(({name,cues,measuredWords,estimatedWords})=>({name,cues,measuredWords,estimatedWords}))}));
