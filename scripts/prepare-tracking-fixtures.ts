import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {runProcess} from '../electron/media';

// Public research footage and ground truth are downloaded only for development.
// They are never included in the app or its source archive. No Python required.
const commit='ebf9366b3845efe1e54bf2440cf238fd68905bab';
const fixtures=[
  {name:'david',first:299,width:320,height:240,frames:471,video:'4bbe69b7d097379af4d7ad128f02692820dc57a6d8275ea2b9e7eef4399a3e61',gt:'8e46f079b39f7877f9650bcf2fc42879b03f22d77ef832ca1d3e1ed258269588'},
  {name:'dudek',first:0,width:720,height:480,frames:1145,video:'679c95a22c71e259971ccaaabf805fdba55c70e224b28eafa7536b7989c722e1',gt:'6645d041ab014a2b3b7f34ca271c1ac42d3d72a9546443c7cc9c542f772f56c4'},
  {name:'faceocc2',first:0,width:320,height:240,frames:812,video:'5ffedeca4fb3acfd65e6f6aa71f016f748628727be1e24914fde2198b42089c5',gt:'7d7b2dc7251e20fbb2fedfc36356ffbc7146ce59f49c21dfe251b8714b87ab88'}
];
const root=path.resolve('.test-artifacts/tracking-fixtures'),cache=path.resolve('.build-cache/tracking/samples'),ffmpeg=path.resolve('resources/bin/ffmpeg.exe');
const digest=async(file:string)=>{const hash=createHash('sha256');for await(const data of createReadStream(file))hash.update(data);return hash.digest('hex');};
await fs.mkdir(root,{recursive:true});const decoderHash=await digest(ffmpeg),rows=[];
for(const fixture of fixtures){
  const directory=path.join(cache,fixture.name);await fs.mkdir(directory,{recursive:true});
  const sources=[];
  for(const [name,remote,expected] of [[fixture.name+'.webm','data/'+fixture.name+'.webm',fixture.video],['gt.txt','gt.txt',fixture.gt]]){
    const file=path.join(directory,name),url=`https://raw.githubusercontent.com/opencv/opencv_extra/${commit}/testdata/cv/tracking/${fixture.name}/${remote}`;
    if(await digest(file).catch(()=>undefined)!==expected){const response=await fetch(url,{signal:AbortSignal.timeout(120000)});assert.ok(response.ok,`HTTP ${response.status}`);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),expected);await fs.writeFile(file,bytes);}
    sources.push({file,url,sha256:expected});
  }
  const ground=(await fs.readFile(path.join(directory,'gt.txt'),'utf8')).trim().split(/\r?\n/).map(line=>line.split(/[ ,]+/).map(Number));
  assert.equal(ground.length,fixture.frames);for(const box of ground)assert.ok(box.length===4&&box.every(Number.isFinite));
  const raw=path.join(root,fixture.name+'.bgr'),record=path.join(root,fixture.name+'.json'),existing=await fs.readFile(record,'utf8').then(JSON.parse).catch(()=>undefined);
  if(existing?.decoderHash!==decoderHash||existing?.videoHash!==fixture.video||existing?.rawHash!==await digest(raw).catch(()=>undefined)){
    await runProcess(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-protocol_whitelist','file,pipe','-i',path.join(directory,fixture.name+'.webm'),'-map','0:v:0','-an','-vf',`select=gte(n\\,${fixture.first})`,'-fps_mode','passthrough','-pix_fmt','bgr24','-f','rawvideo',raw],{timeoutMs:120000});
  }
  assert.equal((await fs.stat(raw)).size,fixture.frames*fixture.width*fixture.height*3);
  const data={...fixture,ground,raw,rawHash:await digest(raw),decoderHash,sources};await fs.writeFile(record,JSON.stringify(data,null,2)+'\n');rows.push({name:fixture.name,frames:fixture.frames,record});
}
await fs.writeFile(path.join(root,'fixtures.json'),JSON.stringify({commit,scope:'Research inputs only; excluded from distribution',rows},null,2)+'\n');console.log(JSON.stringify(rows));
