import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {runProcess} from '../electron/media';

// Public research example linked by the model authors. Development fixture
// only: not included in the application, installer or distributable source ZIP.
const url='https://drive.google.com/uc?export=download&id=1cUIZ--PPoh-qbs2fV_bZc8IyCMsaWGl3';
const expected='fe24766bdc256c2c3977392d5b7b95ed5f4343332c00351875c6f8cf2c0d072e';
const cache=path.resolve('.build-cache/matting'),root=path.resolve('.test-artifacts/matting-fixtures');
const ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),file=path.join(cache,'b5.mp4');
const digest=async(file:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
await fs.mkdir(cache,{recursive:true});await fs.mkdir(root,{recursive:true});
if(await digest(file).catch(()=>undefined)!==expected){
 const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);
 const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.length,75889988);assert.equal(createHash('sha256').update(bytes).digest('hex'),expected);await fs.writeFile(file,bytes);
}
const width=1280,height=720,frames=60,raw=path.join(root,'b5.bgr');
await runProcess(ffmpeg,['-v','error','-nostdin','-y','-threads','2','-i',file,'-map','0:v:0','-an','-frames:v',String(frames),'-vf',`scale=${width}:${height}:flags=lanczos,format=bgr24`,'-fps_mode','passthrough','-f','rawvideo',raw],{timeoutMs:120000});
assert.equal((await fs.stat(raw)).size,width*height*3*frames);
await fs.writeFile(path.join(root,'fixture.json'),JSON.stringify({name:'b5',width,height,frames,raw,source:{file,url,sha256:expected,bytes:75889988},reference:'https://github.com/PeterL1n/RobustVideoMatting#showreel',decoderHash:await digest(ffmpeg),rawHash:await digest(raw),scope:'720p first 60 frames of real 4K human motion footage, for qualitative review and CPU/GPU comparison; no independent ground-truth alpha. Excluded from distribution.'},null,2)+'\n');
console.log(JSON.stringify({width,height,frames,raw}));
