import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {probeMedia,runProcess,type EngineContext} from '../electron/media';
import {stabilizeMedia} from '../electron/stabilization';
import {presentedFrameTime} from '../electron/video-frame';
import {prepareColorFixtures,colorReference,patchSamples,type ColorFixture} from './fixtures/color-range';
import type {MediaAsset} from '../shared/types';

const root=path.resolve('.test-artifacts/stabilization-fidelity'),ctx:EngineContext&{derivedDir:string}={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),derivedDir:path.join(root,'derived')};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:120000,maxOutputBytes:32*1024*1024});
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const preceding=(pts:number[],at:number)=>pts.reduce((last,t,i)=>t<=at?i:last,-1);
const probe=async(file:string,extra:string[]=[])=>JSON.parse((await runProcess(ctx.ffprobe,['-v','error',...extra,'-of','json',file])).stdout.toString());
const times=async(file:string)=>(await probe(file,['-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time'])).frames.map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*1e6)) as number[];
const info=async(file:string)=>(await probe(file,['-show_streams','-show_format']));
const codes=async(file:string)=>{const raw=(await ff(['-i',file,'-map','0:v:0','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])).stdout;return Array.from({length:raw.length/(160*90*3)},(_,f)=>{let code=0;for(let bit=0;bit<8;bit++){const at=(f*160*90+5*160+bit*20+10)*3;if((raw[at]+raw[at+1]+raw[at+2])/3>128)code|=1<<bit;}return code;});};
const near=(a:number[][],b:number[][],label:string)=>{for(let i=0;i<b.length;i++)for(let c=0;c<3;c++)assert.ok(Math.abs(a[i][c]-b[i][c])<=2,`${label} patch${i} channel${c}: ${a[i][c]} vs ${b[i][c]}`);};
let colors:ColorFixture[];const assets:Record<string,MediaAsset>={},clockReports:unknown[]=[],colorReports:unknown[]=[];
before(async()=>{
  await fs.mkdir(root,{recursive:true});
  // The barcode changes, but a fixed textured camera view supplies stable motion
  // features. A moving testsrc2 pattern is itself interpreted as camera motion.
  const image=path.join(root,'static.ppm'),raw=Buffer.alloc(160*90*3);let seed=4513;for(let y=0;y<90;y++)for(let x=0;x<160;x++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const value=x%17<2||y%13<2?230:25+(seed>>>24)%100;for(let c=0;c<3;c++)raw[(y*160+x)*3+c]=value;}
  await fs.writeFile(image,Buffer.concat([Buffer.from('P6\n160 90\n255\n'),raw]));
  const bars="format=yuv420p,geq=lum='if(lt(Y,12),if(mod(floor(N/pow(2,floor(X/20))),2),235,16),p(X,Y))':cb='if(lt(Y,6),128,p(X,Y))':cr='if(lt(Y,6),128,p(X,Y))'",base=path.join(root,'base.mkv');
  await ff(['-loop','1','-framerate','10','-i',image,'-f','lavfi','-i','aevalsrc=0.1*sin(2*PI*1000*t)|0.05*sin(2*PI*750*t):s=48000:d=4','-t','4','-vf',bars,'-c:v','libx264','-preset','ultrafast','-crf','0','-g','20','-c:a','pcm_f32le',base]);assets.base=await probeMedia(base,ctx,undefined,{derivatives:false});
  for(const [name,extension,offset,audio] of [['shifted','mkv',2,'pcm_f32le'],['mp4','mp4',0,'aac'],['mp4-shifted','mp4',2,'aac']] as const){const file=path.join(root,`${name}.${extension}`);await ff(['-itsoffset',String(offset),'-i',base,'-c:v','copy','-c:a',audio,'-avoid_negative_ts','disabled',file]);assets[name]=await probeMedia(file,ctx,undefined,{derivatives:false});}
  const slow=path.join(root,'slow-bframes.mp4');await ff(['-loop','1','-framerate','1/2','-i',image,'-t','16','-vf',bars,'-c:v','libx264','-preset','medium','-crf','8','-bf','3','-g','120',slow]);assets.slow=await probeMedia(slow,ctx,undefined,{derivatives:false});
  const vfr=path.join(root,'vfr.mkv');await ff(['-i',assets.base.path,'-vf',"select='lt(n,10)+gte(n,10)*not(mod(n,2))'",'-fps_mode','vfr','-enc_time_base:v','filter','-c:v','libx264','-crf','8','-c:a','copy',vfr]);assets.vfr=await probeMedia(vfr,ctx,undefined,{derivatives:false});
  colors=await prepareColorFixtures(path.join(root,'colors'),ctx);
});

test('Presented-frame lookup uses decoded VFR/B-frame timestamps and closes its probe after cancellation',{timeout:120000},async()=>{
  for(const [name,media]of Object.entries(assets)){const pts=await times(media.path),origin=media.timing!.origin;for(const time of name==='slow'?[.137,2.937,4.137,9.999999,10,13.137]:[.137,.999999,1,1.137,2.937]){const wanted=Math.round((origin+time)*1e6),expected=pts[Math.max(0,preceding(pts,wanted))];assert.equal(await presentedFrameTime(media.path,0,origin,time,ctx),expected,`${name} at${time}`);}}
  const abort=new AbortController(),pids:number[]=[];await assert.rejects(presentedFrameTime(assets.base.path,0,0,3,{...ctx,diagnostics:e=>{if(typeof e.pid==='number'){pids.push(e.pid);abort.abort();}}},abort.signal),{name:'AbortError'});assert.ok(pids.length);for(const pid of pids)assert.throws(()=>process.kill(pid,0));
  await assert.rejects(presentedFrameTime(assets.base.path,0,0,Infinity,ctx));
});

test('Stabilization retains the held first frame and every following presentation time; audio PCM remains exact',{timeout:120000},async()=>{
  const cases=[...Object.entries(assets),['mp4-seek',assets.mp4],['mp4-shifted-seek',assets['mp4-shifted']]] as Array<[string,MediaAsset]>;
  for(const [name,media] of cases){const start=name==='slow'?4.137:name.endsWith('-seek')?2.137:.137,duration=name==='slow'?5.731:1.231,pts=await times(media.path),sourceCodes=await codes(media.path),at=Math.round((media.timing!.origin+start)*1e6),until=Math.round((media.timing!.origin+start+duration)*1e6),first=preceding(pts,at),indices=pts.flatMap((t,i)=>i>=Math.max(0,first)&&t<until?[i]:[]),expectedTimes=indices.map(i=>Math.max(0,pts[i]-at)),expectedCodes=indices.map(i=>sourceCodes[i]);
    const output=await stabilizeMedia(media,{start,duration,smoothing:0,crop:'black',zoom:0},ctx),actualTimes=await times(output.path),actualCodes=await codes(output.path);assert.deepEqual(actualCodes,expectedCodes,`${name} source frame identity`);assert.equal(actualTimes.length,expectedTimes.length);for(let i=0;i<actualTimes.length;i++)assert.ok(Math.abs(actualTimes[i]-expectedTimes[i])<=1,`${name} frame${i}: ${actualTimes[i]} vs ${expectedTimes[i]}`);assert.equal(actualTimes[0],0);
    let audio;if(media.hasAudio){const sourceInfo=await info(media.path),stream=sourceInfo.streams.find((s:any)=>s.codec_type==='audio'),rate=Number(stream.sample_rate),channels=stream.channels,full=(await ff(['-i',media.path,'-map','0:a:0','-f','f32le','pipe:1'])).stdout,firstDecoded=(await probe(media.path,['-select_streams','a:0','-show_frames','-show_entries','frame=best_effort_timestamp_time'])).frames[0],origin=Number(firstDecoded.best_effort_timestamp_time),from=Math.max(0,Math.round((at/1e6-origin)*rate)),to=Math.min(full.length/(channels*4),Math.round((until/1e6-origin)*rate)),expected=full.subarray(from*channels*4,to*channels*4),actual=(await ff(['-i',output.path,'-map','0:a:0','-f','f32le','pipe:1'])).stdout;assert.equal(actual.length,expected.length,name+' independent PCM length');assert.equal(sha(actual),sha(expected),`${name} independent full-decode PCM slice`);audio={frames:actual.length/(channels*4),channels,rate};}
    clockReports.push({name,media,output,start,duration,expectedTimes,actualTimes,expectedCodes,actualCodes,audio});
  }
});

test('Stabilized SDR files retain native source colors without changing matrix/range when the source is already compatible',{timeout:120000},async()=>{
  for(const row of colors){const expected=(await colorReference(row,ctx)).map(p=>p.rgb),output=await stabilizeMedia(row.media,{start:0,duration:1,smoothing:0,crop:'black',zoom:0},ctx),stream=(await info(output.path)).streams.find((s:any)=>s.codec_type==='video'),raw=(await ff(['-i',output.path,'-frames:v','1','-vf','scale=flags=bilinear+full_chroma_int+accurate_rnd','-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout,actual=patchSamples(raw,row.spec.width,row.spec.height);near(actual,expected,row.spec.name);assert.equal(stream.color_range,row.spec.previewRange);assert.equal(stream.color_space,row.spec.matrix==='bt601'?'smpte170m':'bt709');assert.ok(stream.color_primaries&&stream.color_transfer);colorReports.push({name:row.spec.name,media:row.media,output,width:row.project.width,height:row.project.height,expected,actual});}
  await fs.writeFile(path.join(root,'fixtures.json'),JSON.stringify({version:JSON.parse(await fs.readFile('package.json','utf8')).version,clock:clockReports,colors:colorReports},null,2));
});
