import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {transcribeMedia,type ServiceContext} from '../electron/services';
import {stabilizeMedia} from '../electron/stabilization';
import {readSourceRevision,requireSourceRevision} from '../electron/source-revision';
import type {MediaAsset} from '../shared/types';

test('ASR backends and stabilization reject a stale requested source before spawning any process',async()=>{
 const root=path.resolve('.test-artifacts/processing-identity');await fs.mkdir(root,{recursive:true});const work=await fs.mkdtemp(path.join(root,'preflight-')),file=path.join(work,'source.mp4');
 await fs.writeFile(file,'original');const revision=await readSourceRevision(file),stamp=await fs.stat(file);await fs.utimes(file,stamp.atime,new Date(stamp.mtimeMs+2000));
 const media:MediaAsset={id:'source',path:file,name:'source',kind:'video',duration:2,width:160,height:90,fps:25,hasAudio:true,sourceRevision:revision};
 const services:ServiceContext={ffmpeg:path.join(work,'must-not-spawn.exe'),modelDir:path.join(work,'missing-models'),cacheDir:path.join(work,'cache')};
 await assert.rejects(transcribeMedia(media,'ko',services),/원본 파일이 변경/);
 await assert.rejects(transcribeMedia(media,'ko',{...services,whisper:path.join(work,'must-not-spawn-whisper.exe')}),/원본 파일이 변경/);
 await assert.rejects(stabilizeMedia(media,{duration:1},{ffmpeg:services.ffmpeg,ffprobe:path.join(work,'must-not-spawn-probe.exe'),cacheDir:services.cacheDir,derivedDir:path.join(work,'derived')}),/원본 파일이 변경/);
 assert.deepEqual((await fs.readdir(work)).sort(),['source.mp4']);
 const current=await requireSourceRevision(file);assert.notEqual(current,revision);await requireSourceRevision(file,current);
});
