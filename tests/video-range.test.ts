import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,utimesSync} from 'node:fs';
import path from 'node:path';
import {runProcess,probeMedia,type EngineContext} from '../electron/media';
import {videoRangeFromProbe,probeVideoRange,cachedVideoRange,VideoFrameRangeReader} from '../electron/video-range';

const root=path.resolve('.test-artifacts/video-range');
const ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),ffprobe=path.resolve('resources/bin/ffprobe.exe');
const ff=(args:string[])=>runProcess(ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:60000,maxOutputBytes:8*1024*1024});
const probe=async(file:string)=>JSON.parse((await runProcess(ffprobe,['-v','error','-show_format','-show_streams','-of','json',file])).stdout.toString());
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
const exists=async(file:string)=>fs.access(file).then(()=>true,()=>false);
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const baseProbe={format:{format_name:'mov,mp4,m4a,3gp,3g2,mj2',start_time:'3',duration:'100'},streams:[{index:0,codec_type:'video',time_base:'1/12800',start_pts:47360,duration_ts:25600,nb_frames:'50',avg_frame_rate:'25/1',r_frame_rate:'25/1'}]};

test('video metadata shortcut requires consistent CFR sample tables and ignores container/audio duration',()=>{
  assert.deepEqual(videoRangeFromProbe(baseProbe),{videoStart:.7,videoEnd:2.7});
  assert.equal(videoRangeFromProbe({...baseProbe,format:{...baseProbe.format,format_name:'matroska,webm'}}),undefined);
  for(const fields of [{avg_frame_rate:'50/3'},{duration_ts:23040},{duration_ts:undefined},{nb_frames:undefined},{time_base:'0/0'},{duration_ts:Infinity},{start_pts:'N/A'}]){
    assert.equal(videoRangeFromProbe({...baseProbe,streams:[{...baseProbe.streams[0],...fields}]}),undefined);
  }
  assert.deepEqual(videoRangeFromProbe({...baseProbe,streams:[{...baseProbe.streams[0],index:7,disposition:{attached_pic:1}},{...baseProbe.streams[0],index:8}]}),{videoStart:.7,videoEnd:2.7});
  assert.equal(videoRangeFromProbe({format:{duration:'99'},streams:[{codec_type:'audio',duration:'99'}]}),undefined);
});

test('streaming frame range handles reordered records and pipe fragments without inventing a final duration',()=>{
  const reader=new VideoFrameRangeReader(.001,3);
  const text='frame|pts=3700|best_effort_timestamp=3700|duration=40\r\nframe|pts=3780|best_effort_timestamp=3780|duration=120\nframe|pts=3740|best_effort_timestamp=3740|duration=40';
  for(let offset=0;offset<text.length;offset+=7)reader.push(text.slice(offset,offset+7));
  assert.deepEqual(reader.finish(),{videoStart:.7,videoEnd:.9});assert.equal(reader.frames,3);
  const missing=new VideoFrameRangeReader(.001,0);missing.push('frame|pts=0|duration=40\nframe|pts=40|duration=N/A\n');assert.equal(missing.finish(),undefined);
  const invalid=new VideoFrameRangeReader(.001,0);invalid.push('frame|pts=N/A|duration=40\n');assert.equal(invalid.finish(),undefined);
  const many=new VideoFrameRangeReader(.001,0);
  for(let i=0;i<100000;i++)many.push(`frame|pts=${i*40}|duration=40\n`);
  assert.deepEqual(many.finish(),{videoStart:0,videoEnd:4000});assert.equal(many.frames,100000);assert.ok(many.peakPendingBytes<=4096);
  assert.throws(()=>new VideoFrameRangeReader(1,0).push('x'.repeat(4097)),/레코드/);
});

test('actual MP4/MKV/VFR/rotation/delayed tracks resolve presented video bounds in the input seek clock',{timeout:120000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const work=await fs.mkdtemp(path.join(root,'run-'));
  const ctx:EngineContext={ffmpeg,ffprobe,cacheDir:path.join(work,'cache')};
  const base=path.join(work,'audio-long.mp4');
  await ff(['-f','lavfi','-i','testsrc2=s=160x90:r=25:d=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-map','0:v','-map','1:a','-c:v','libx264','-preset','medium','-c:a','aac',base]);
  const delayed=path.join(work,'video-delay.mp4'),audioDelayed=path.join(work,'audio-delay.mp4'),mkv=path.join(work,'audio-long.mkv'),delayedMkv=path.join(work,'video-delay.mkv');
  await ff(['-itsoffset','0.7','-i',base,'-i',base,'-map','0:v','-map','1:a','-c','copy',delayed]);
  await ff(['-i',base,'-itsoffset','0.7','-i',base,'-map','0:v','-map','1:a','-c','copy',audioDelayed]);
  await ff(['-i',base,'-c','copy',mkv]);await ff(['-i',delayed,'-c','copy',delayedMkv]);
  const variable=path.join(work,'variable.mp4'),variableOnly=path.join(work,'variable-only.mp4'),origin=path.join(work,'video-origin.mp4'),rotated=path.join(work,'rotated.mp4'),edited=path.join(work,'edit-list.mp4');
  await ff(['-i',base,'-map','0:v','-map','0:a','-vf',"select='lt(n,20)+gte(n,20)*not(mod(n,3))'",'-fps_mode:v','vfr','-enc_time_base:v','filter','-c:v','libx264','-c:a','copy',variable]);
  await ff(['-i',variable,'-map','0:v','-c','copy',variableOnly]);
  await ff(['-itsoffset','3','-i',base,'-map','0:v','-c','copy','-copyts',origin]);
  await ff(['-display_rotation:v:0','90','-i',base,'-c','copy',rotated]);
  await ff(['-ss','0.137','-i',base,'-t','1.017','-c','copy',edited]);
  const fixtures:[string,number,number,boolean][]=[[base,0,2,true],[delayed,.7,2.7,true],[audioDelayed,0,2,true],[mkv,.021,2.021,false],[delayedMkv,.721,2.721,false],
    [variable,0,2.04,false],[variableOnly,0,2.04,false],[origin,0,2,true],[rotated,0,2,true],[edited,0,1.16,false]];
  const results=[];
  for(const [file,start,end,fast] of fixtures){
    const metadata=await probe(file),shortcut=videoRangeFromProbe(metadata),events:Record<string,unknown>[]=[];
    assert.equal(Boolean(shortcut),fast,path.basename(file));if(shortcut){near(shortcut.videoStart,start);near(shortcut.videoEnd,end);}
    const before=performance.now(),range=await probeVideoRange(file,{...ctx,diagnostics:event=>events.push(event)},undefined,{probe:metadata,forceScan:true});
    assert.ok(range);near(range.videoStart,start);near(range.videoEnd,end);
    const scan=events.find(event=>event.event==='video-range-scan');assert.ok(scan);assert.ok(Number(scan.peakPendingBytes)<=4096);
    results.push({name:path.basename(file),formatDuration:Number(metadata.format.duration),videoStart:range.videoStart,videoEnd:range.videoEnd,metadataShortcut:fast,frames:scan.frames,peakPendingBytes:scan.peakPendingBytes,seconds:(performance.now()-before)/1000});
  }
  // A default import must not decode all VFR frames. A later explicit scan may
  // legitimately extend media.duration beyond an underestimated format value.
  const importCtx={...ctx,cacheDir:path.join(work,'import-cache')},events:Record<string,unknown>[]=[];
  const before=await probeMedia(variableOnly,{...importCtx,diagnostics:event=>events.push(event)});
  near(before.duration,1.8);assert.equal(before.videoEnd,undefined);assert.equal(events.some(event=>event.event==='video-range-process'),false);
  const progress:number[]=[];await probeVideoRange(variableOnly,importCtx,undefined,{progress:value=>progress.push(value)});
  const after=await probeMedia(variableOnly,importCtx,undefined,{derivatives:false});near(after.duration,2.04);near(after.videoEnd!,2.04);assert.equal(after.id,before.id);assert.equal(progress.at(-1),1);
  const cachedEvents:Record<string,unknown>[]=[];assert.deepEqual(await probeVideoRange(variableOnly,{...importCtx,diagnostics:event=>cachedEvents.push(event)}),{videoStart:0,videoEnd:2.04});assert.equal(cachedEvents.length,0);
  // Changing the source fingerprint invalidates completed measurements.
  const copy=path.join(work,'changed.mp4');await fs.copyFile(variableOnly,copy);await probeVideoRange(copy,ctx);assert.ok(await cachedVideoRange(copy,ctx));const stamp=await fs.stat(copy);await fs.utimes(copy,stamp.atime,new Date(stamp.mtimeMs+2000));assert.equal(await cachedVideoRange(copy,ctx),undefined);
  const audio=path.join(work,'audio.wav');await ff(['-i',base,'-vn','-c:a','pcm_s16le',audio]);assert.equal(await probeVideoRange(audio,ctx),undefined);
  // The origin=3 fixture actually yields a zero-based decoded timestamp under
  // the same default input -ss clock used by the renderer.
  const seek=await runProcess(ffmpeg,['-hide_banner','-loglevel','info','-nostdin','-ss','0','-i',origin,'-frames:v','1','-an','-vf','showinfo','-f','null','-']);
  assert.match(seek.stderr,/pts_time:0(?:\s|\.)/);
  const report={generatedAt:new Date().toISOString(),results,defaultImportScans:false,vfrDurationBefore:before.duration,vfrDurationAfter:after.duration,completedCacheReused:true,changedSourceInvalidatesCache:true};
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));t.diagnostic(JSON.stringify(report));
});

test('range scan cancellation kills its actual child and changed sources are not published',{timeout:30000},async()=>{
  const source=path.resolve('examples/01 - Aurora motion.mp4');
  await fs.mkdir(root,{recursive:true});const work=await fs.mkdtemp(path.join(root,'cancel-'));
  const ctx:EngineContext={ffmpeg,ffprobe,cacheDir:path.join(work,'cache')};
  const controller=new AbortController(),pids:number[]=[];
  await assert.rejects(probeVideoRange(source,{...ctx,diagnostics:event=>{if(event.event==='video-range-process'){pids.push(Number(event.pid));controller.abort();}}},controller.signal,{forceScan:true}),error=>error instanceof Error&&error.name==='AbortError');
  assert.ok(pids.length);assert.deepEqual(pids.filter(alive),[]);assert.equal(await exists(ctx.cacheDir),false);
  const early=new AbortController();early.abort();await assert.rejects(probeVideoRange('not-a-file',ctx,early.signal),error=>error instanceof Error&&error.name==='AbortError');
  const changed=path.join(work,'changed-during-scan.mp4');await fs.copyFile(source,changed);const initial=await fs.stat(changed);
  await assert.rejects(probeVideoRange(changed,{...ctx,diagnostics:event=>{if(event.event==='video-range-process')utimesSync(changed,initial.atime,new Date(initial.mtimeMs+2000));}},undefined,{forceScan:true}),/변경/);
  assert.equal(await cachedVideoRange(changed,ctx),undefined);
});
