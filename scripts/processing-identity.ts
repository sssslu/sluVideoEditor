import assert from 'node:assert/strict';
import {promises as fs,utimesSync} from 'node:fs';
import path from 'node:path';
import {probeMedia,runProcess} from '../electron/media';
import {transcribeMedia,type ServiceContext} from '../electron/services';
import {stabilizeMedia} from '../electron/stabilization';
import {readSourceRevision} from '../electron/source-revision';

const root=path.resolve('.test-artifacts/processing-identity');await fs.mkdir(root,{recursive:true});
const work=await fs.mkdtemp(path.join(root,'run-')),ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),ffprobe=path.resolve('resources/bin/ffprobe.exe');
const engine={ffmpeg,ffprobe,cacheDir:path.join(work,'cache')};
const modelDir=path.resolve('.test-artifacts/services/models');await fs.access(path.join(modelDir,'ggml-base.bin'));
const context:ServiceContext={...engine,modelDir,whisper:path.resolve('resources/bin/whisper-cpu/Release/whisper-cli.exe')};
const checks=[];
for(const backend of ['cli','filter'] as const){
 const file=path.join(work,`${backend}.wav`);await runProcess(ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=1.2','-c:a','pcm_s16le',file]);
 const media=await probeMedia(file,engine,undefined,{derivatives:false}),stamp=await fs.stat(file);let changed=false,completed=false;
 const started=performance.now();await assert.rejects(transcribeMedia(media,'en',backend==='cli'?context:{...context,whisper:undefined},(value,message)=>{
  if(value===1)completed=true;
  if(!changed&&(backend==='cli'?message.startsWith('음성 인식 ·'):value>0)){changed=true;utimesSync(file,stamp.atime,new Date(stamp.mtimeMs+2000));}
 },undefined,{model:'base',device:'cpu',duration:1.2}),/원본 파일이 변경/);
 assert.equal(changed,true);assert.equal(completed,false);assert.notEqual(await readSourceRevision(file),media.sourceRevision);
 const leftovers=(await fs.readdir(engine.cacheDir)).filter(name=>name.startsWith('speech-'));assert.deepEqual(leftovers,[]);
 checks.push({backend,sourceChangedAfterAudioRead:true,returnedCues:false,completed:false,seconds:(performance.now()-started)/1000});
}
const source=path.join(work,'stabilize.mp4');await runProcess(ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=160x90:r=25:d=1','-c:v','libx264',source]);
const media=await probeMedia(source,engine,undefined,{derivatives:false}),stamp=await fs.stat(source),derivedDir=path.join(work,'derived');let changed=false,completed=false;
await assert.rejects(stabilizeMedia(media,{duration:.5,smoothing:0,accuracy:5,shakiness:1},{...engine,derivedDir},value=>{if(value===1)completed=true;if(!changed&&value>=.96){changed=true;utimesSync(source,stamp.atime,new Date(stamp.mtimeMs+2000));}}),/원본 파일이 변경/);
assert.equal(changed,true);assert.equal(completed,false);assert.deepEqual(await fs.readdir(derivedDir),[]);
checks.push({backend:'stabilization',sourceChangedAfterTransform:true,derivedPublished:false,completed:false});
await fs.writeFile(path.join(root,'results.json'),JSON.stringify({date:new Date().toISOString(),checks},null,2));console.log(JSON.stringify(checks,null,2));
