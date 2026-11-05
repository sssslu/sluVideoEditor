import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,utimesSync} from 'node:fs';
import path from 'node:path';
import {probeMedia,runProcess,type EngineContext} from '../electron/media';
import {prepareTrackingInput,prepareTrackingSource} from '../electron/tracking-source';
import {verifyVideoSelection} from '../electron/video-selection';
import {cachedVideoRange} from '../electron/video-range';
import {decodeTrackingFrames} from '../electron/tracking-decode';
import {NutVideoStream} from '../electron/nut-video';
import {ffprobeIntervalFrom} from '../electron/probe-interval';

const root=path.resolve('.test-artifacts/video-selection',`${Date.now()}-${process.pid}`);
const binaries={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe')};
const files={long:path.join(root,'long.mkv'),short:path.join(root,'short.mov'),shifted:path.join(root,'shifted.mov'),negative:path.join(root,'negative.ts'),delayed:path.join(root,'delayed.mov'),sparse:path.join(root,'sparse.mov')};
const ff=(args:string[])=>runProcess(binaries.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:60000,maxOutputBytes:8*1024*1024});
const context=(label:string,diagnostics?:EngineContext['diagnostics']):EngineContext=>({...binaries,cacheDir:path.join(root,label),diagnostics});
const probes=(events:Record<string,unknown>[])=>events.filter(event=>event.event==='frame-probe-exit');
const rangeScans=(events:Record<string,unknown>[])=>events.filter(event=>event.event==='video-range-process');
async function frameTimes(file:string){
  const result=await runProcess(binaries.ffprobe,['-v','error','-threads','1','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time:frame_side_data=','-of','csv=p=0',file],{timeoutMs:60000});
  return result.stdout.toString().split(/\r?\n/).map(line=>line.split(',')[0].trim()).filter(Boolean).map(value=>Math.round(Number(value)*1e6));
}
async function input(file:string,ctx:EngineContext){
  const media=await probeMedia(file,ctx,undefined,{derivatives:false});
  const prepared=await prepareTrackingInput(media,1280,ctx);
  return {media,prepared,source:{...prepared.plan,revision:prepared.revision,probe:prepared.probe}};
}
const assertExited=(events:Record<string,unknown>[])=>{
  for(const event of events)if(typeof event.pid==='number')assert.throws(()=>process.kill(event.pid as number,0),{code:'ESRCH'});
};
const firstAt=(times:number[],time:number)=>{
  let index=0;for(let n=0;n<times.length&&times[n]<=time;n++)index=n;return times[index];
};

before(async()=>{
  await fs.mkdir(root,{recursive:true});
  // The top eight cells encode the original frame number before VFR selection.
  const barcode="geq=lum='if(lt(Y,8),if(mod(floor(N/pow(2,floor(X/16))),2),235,16),p(X,Y))':cb='if(lt(Y,8),128,p(X,Y))':cr='if(lt(Y,8),128,p(X,Y))'";
  await ff(['-f','lavfi','-i','testsrc2=s=128x72:r=30:d=120','-vf',`${barcode},select='not(eq(mod(n,7),3))'`,'-fps_mode','passthrough','-enc_time_base:v','1:1000000','-c:v','libx264','-preset','ultrafast','-crf','8','-bf','3','-g','60','-threads','1','-avoid_negative_ts','disabled',files.long]);
  await ff(['-i',files.long,'-t','3','-map','0:v:0','-c','copy','-video_track_timescale','1000000','-movie_timescale','1000000',files.short]);
  await ff(['-itsoffset','3','-i',files.short,'-map','0:v:0','-c','copy','-avoid_negative_ts','disabled','-movie_timescale','1000000',files.shifted]);
  await ff(['-copyts','-itsoffset','-2','-i',files.short,'-map','0:v:0','-c','copy','-avoid_negative_ts','disabled','-mpegts_copyts','1','-muxdelay','0',files.negative]);
  await ff(['-itsoffset','0.375','-i',files.short,'-f','lavfi','-i','sine=frequency=437:sample_rate=48000:duration=5','-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','pcm_f32le','-video_track_timescale','1000000','-movie_timescale','1000000',files.delayed]);
  const stream=new NutVideoStream(32,24),raw=path.join(root,'sparse.nut'),output=await fs.open(raw,'w');
  try{
    await output.write(stream.header);
    for(const [index,pts] of [0,3600000000].entries()){
      const data=Buffer.alloc(32*24*4);for(let pixel=0;pixel<32*24;pixel++){data[pixel*4]=index?200:30;data[pixel*4+1]=120;data[pixel*4+2]=70;data[pixel*4+3]=255;}
      for(const part of stream.frame(data,pts))await output.write(part);
    }
  }finally{await output.close();}
  // MOV sample deltas use signed32-bit durations. A1kHz track clock safely
  // represents the one-hour gap while retaining this fixture's exact timing.
  await ff(['-copyts','-i',raw,'-map','0:v:0','-an','-fps_mode','passthrough','-enc_time_base:v','1:1000000','-c:v','ffv1','-pix_fmt','bgr0','-bsf:v',"setts=duration='if(eq(N,1),1250000,DURATION)'",'-video_track_timescale','1000','-movie_timescale','1000',files.sparse]);
  assert.deepEqual(await frameTimes(files.sparse),[0,3600000000]);
});

test('a cold interior VFR selection uses bounded decoded witnesses and preserves every selected barcode',{timeout:60000},async()=>{
  const events:Record<string,unknown>[]=[],ctx=context('bounded',event=>events.push(event));
  const {prepared,source}=await input(files.long,ctx),all=await frameTimes(files.long);
  const selected=await verifyVideoSelection(source,60.137,1.231,ctx);
  assert.equal(selected.firstPts,firstAt(all,selected.startPts));
  assert.equal(rangeScans(events).length,0);
  assert.equal(probes(events).length,2);
  const records=probes(events).reduce((sum,event)=>sum+Number(event.records),0);
  assert.ok(records>0&&records<all.length/4,`${records} records for ${all.length} source frames`);
  assert.equal(await cachedVideoRange(files.long,ctx),undefined,'An interval proof must not become a global range cache');
  const actual:number[]=[],codes:number[]=[];
  for await(const frame of decodeTrackingFrames(prepared.plan,selected.firstPts,selected.endPts,ctx)){
    actual.push(frame.pts);let code=0;
    for(let bit=0;bit<8;bit++)if(frame.data[(4*frame.width+8+bit*16)*3]>127)code|=1<<bit;
    codes.push(code);
  }
  const expected=all.filter(pts=>pts>=selected.firstPts&&pts<selected.endPts);
  assert.deepEqual(actual,expected);
  assert.deepEqual(codes,expected.map(pts=>Math.round(pts/1e6*30)&255));
  assertExited(events);
  await fs.writeFile(path.join(root,'bounded.json'),JSON.stringify({selected,records,sourceFrames:all.length,frames:actual,codes,events},null,2));
});

test('positive and negative origins, delayed video, and longer audio keep source-clock bounds',{timeout:60000},async()=>{
  for(const name of ['shifted','negative','delayed'] as const){
    const events:Record<string,unknown>[]=[],ctx=context(name,event=>events.push(event));
    const {source}=await input(files[name],ctx),all=await frameTimes(files[name]);
    const selection=await verifyVideoSelection(source,1.137,.731,ctx);
    assert.equal(selection.startPts,Math.round((source.origin+1.137)*1e6));
    assert.equal(selection.firstPts,firstAt(all,selection.startPts));
    assert.equal(rangeScans(events).length,0,name+' must use actual nearby frames');
    assertExited(events);
  }
  const ctx=context('delayed-invalid'),{source}=await input(files.delayed,ctx);
  await assert.rejects(verifyVideoSelection(source,.1,.4,ctx),/표시 범위/);
  await assert.rejects(verifyVideoSelection(source,4,.5,ctx),/표시 범위/,'Long audio cannot extend the video selection');
});

test('sparse held frames and an exact final PTS use witnesses while the terminal hold requires its real duration',{timeout:60000},async()=>{
  for(const [label,start,duration] of [['held',100,10],['last-boundary',3599,1]] as const){
    const events:Record<string,unknown>[]=[],ctx=context(label,event=>events.push(event)),{source}=await input(files.sparse,ctx);
    const selected=await verifyVideoSelection(source,start,duration,ctx);
    assert.equal(selected.firstPts,0);assert.equal(rangeScans(events).length,0);
    assert.equal(await cachedVideoRange(files.sparse,ctx),undefined);assertExited(events);
  }
  const events:Record<string,unknown>[]=[],ctx=context('terminal',event=>events.push(event)),{media,source}=await input(files.sparse,ctx);
  const terminal=await verifyVideoSelection(source,3600.2,1,ctx);
  assert.equal(terminal.firstPts,3600000000);assert.equal(rangeScans(events).length,1);
  assert.deepEqual(await cachedVideoRange(files.sparse,ctx),{videoStart:0,videoEnd:3601.25});
  await assert.rejects(verifyVideoSelection(source,3600.2,1.1,ctx),/표시 범위/);
  // The established tracking API still exposes the complete source interval.
  assert.deepEqual((await prepareTrackingSource(media,1280,ctx)).range,{videoStart:0,videoEnd:3601.25});assertExited(events);
});

test('decoder errors with a successful FFprobe exit cannot become accepted frame witnesses',{timeout:60000},async()=>{
  const corrupted=path.join(root,'corrupted.mov');await fs.copyFile(files.short,corrupted);
  const packetData=JSON.parse((await runProcess(binaries.ffprobe,['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts_time,pos,size,flags','-of','json',corrupted])).stdout.toString());
  const packet=packetData.packets.find((p:{pts_time:string;size:string})=>Number(p.pts_time)>.5&&Number(p.size)>32);assert.ok(packet);
  const handle=await fs.open(corrupted,'r+');try{const invalid=Buffer.alloc(4,255);await handle.write(invalid,0,4,Number(packet.pos));}finally{await handle.close();}
  const decoded=await runProcess(binaries.ffprobe,['-v','error','-threads','1','-err_detect','explode','-read_intervals',ffprobeIntervalFrom(0),'-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','csv=p=0',corrupted]);
  assert.ok(decoded.stderr.trim(),'Fixture must produce a decoder error despite exit0');
  const ctx=context('corrupted'),{source}=await input(corrupted,ctx);
  await assert.rejects(verifyVideoSelection(source,1.137,.731,ctx),/정확히 확인|미디어 처리/);
  assert.equal(await cachedVideoRange(corrupted,ctx),undefined);
});

test('cancellation and source replacement discard partial boundary proofs and close their probes',{timeout:60000},async()=>{
  const cancellation=new AbortController(),events:Record<string,unknown>[]=[];
  const cancelCtx=context('cancel',event=>{events.push(event);if(event.event==='frame-probe-start')cancellation.abort();});
  const {source}=await input(files.long,cancelCtx);
  await assert.rejects(verifyVideoSelection(source,60.137,1.231,cancelCtx,cancellation.signal),{name:'AbortError'});
  assertExited(events);assert.equal(await cachedVideoRange(files.long,cancelCtx),undefined);
  const mutable=path.join(root,'mutable.mkv');await fs.copyFile(files.long,mutable);let changed=false;
  const initial=await fs.stat(mutable),changedCtx=context('changed',event=>{
    if(event.event==='frame-probe-start'&&!changed){changed=true;utimesSync(mutable,initial.atime,new Date(initial.mtimeMs+2000));}
  });
  const changedInput=await input(mutable,changedCtx);
  await assert.rejects(verifyVideoSelection(changedInput.source,60.137,1.231,changedCtx),/변경|바뀌/);assert.equal(changed,true);
  assert.equal(await cachedVideoRange(mutable,changedCtx),undefined);
});
