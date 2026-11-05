import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,utimesSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {trackMedia,normalizeTrackingOptions,type TrackingContext,type TrackingSession} from '../electron/tracking';
import {ObjectTracker} from '../electron/tracking-model';
import {MotionFileReader,MotionSampleWriter,assembleMotionFile} from '../electron/tracking-file';
import type {TrackingFrame,TrackingObservation} from '../electron/tracking-math';
import {probeMedia,runProcess} from '../electron/media';
import {prepareClockFixtures} from './fixtures/media-clock';
import {prepareColorFixtures,colorReference,patchSamples,type ColorFixture} from './fixtures/color-range';
import type {MediaAsset} from '../shared/types';
import type {MotionSample,TrackingOptions} from '../shared/tracking';
import {trackingStill} from '../electron/tracking-source';

const root=path.resolve('.test-artifacts/tracking-pipeline'),box={x:.25,y:.25,width:.25,height:.25},reports:unknown[]=[];
const mock=(observe?:(frame:TrackingFrame,anchor:boolean)=>void):TrackingSession=>({backend:'cpu',anchor(frame){observe?.(frame,true);return {box:[8,8,16,16],score:1,status:'tracked'};},async update(frame){observe?.(frame,false);return {box:[8,8,16,16],score:.75,status:'tracked'};},async close(){}});
const ctx:TrackingContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),derivedDir:path.join(root,'derived'),backwardBufferBytes:160*90*3*3,createTracker:async()=>mock()};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:120000,maxOutputBytes:32*1024*1024});
const probe=async(file:string,args:string[])=>JSON.parse((await runProcess(ctx.ffprobe,['-v','error',...args,'-of','json',file])).stdout.toString());
const readAll=async(file:string)=>{const reader=await MotionFileReader.open(file),samples:MotionSample[]=[];try{let i=0;while(i<reader.metadata.frames){const range=await reader.range((await reader.sample(i)).time,256);assert.equal(range.startIndex,i);samples.push(...range.samples);i+=range.samples.length;}return {metadata:reader.metadata,samples};}finally{await reader.close();}};
const assets:Record<string,MediaAsset>={};let colors:ColorFixture[];
before(async()=>{
  await fs.mkdir(root,{recursive:true});Object.assign(assets,(await prepareClockFixtures(path.join(root,'clock'),ctx)).assets);
  const add=async(name:string,extension:string,args:string[])=>{const file=path.join(root,`${name}.${extension}`);await ff([...args,file]);assets[name]=await probeMedia(file,ctx,undefined,{derivatives:false});};
  await add('vfr','mkv',['-i',assets.base.path,'-an','-vf',"select='lt(n,10)+gte(n,10)*not(mod(n,2))'",'-fps_mode','vfr','-enc_time_base:v','filter','-c:v','libx264','-crf','8']);
  await add('sparse','mp4',['-i',assets.base.path,'-an','-vf',"select='not(mod(n,10))',setpts=N*2/TB",'-fps_mode','vfr','-enc_time_base:v','filter','-c:v','libx264','-crf','8','-bf','3','-g','120']);
  await add('hours','mov',['-itsoffset','10002','-i',assets.base.path,'-map','0','-c','copy','-avoid_negative_ts','disabled','-movie_timescale','1000000']);
  // Matroska loses the negative packet timestamps; keep it as a rejection
  // fixture. MPEG-TS retains genuinely negative PTS and exercises that clock.
  await add('missing-pts','mkv',['-itsoffset','-2','-i',assets.base.path,'-map','0','-c','copy','-avoid_negative_ts','disabled']);
  await add('negative','ts',['-copyts','-itsoffset','-2','-i',assets.base.path,'-an','-c:v','copy','-avoid_negative_ts','disabled','-mpegts_copyts','1','-muxdelay','0']);
  await add('fractional','mov',['-i',assets.base.path,'-an','-vf','settb=1/30000,setpts=N*1001','-fps_mode','passthrough','-enc_time_base:v','filter','-c:v','libx264','-crf','8','-video_track_timescale','30000']);
  await add('late-video','mov',['-itsoffset','0.250123','-i',assets.base.path,'-i',assets.base.path,'-map','0:v:0','-map','1:a:0','-c','copy','-movie_timescale','1000000']);
  colors=await prepareColorFixtures(path.join(root,'colors'),ctx);
});

test('tracking validates anchors and rejects duplicate anchors on one held frame',async()=>{
  const options:TrackingOptions={start:0,duration:1,anchors:[{time:0,box}]};assert.equal(normalizeTrackingOptions(options).maxDimension,1280);
  for(const update of [{duration:0},{duration:Infinity},{start:-1},{maxDimension:9000},{anchors:[]},{anchors:[{time:1,box}]},{anchors:[{time:0,box:{...box,x:.9}}]}])assert.throws(()=>normalizeTrackingOptions({...options,...update}));
  await assert.rejects(trackMedia(assets.base,{...options,anchors:[{time:.11,box},{time:.12,box}]},ctx),/같은 영상 프레임/);
  const missing=(await probe(assets['missing-pts'].path,['-show_frames','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time'])).frames;assert.ok(missing.some((f:{best_effort_timestamp_time?:string})=>!f.best_effort_timestamp_time));
  await assert.rejects(trackMedia(assets['missing-pts'],options,ctx),/정확한 표시 구간/);
});

test('tracking pairs every decoded barcode with its actual PTS, forwards and backwards across bounded windows',{timeout:180000},async()=>{
  for(const name of ['base','shifted','mp4','mp4-shifted','vfr','sparse','hours','negative','fractional','late-video']){
    const media=assets[name],start=['sparse','fractional'].includes(name)?.137:name==='late-video'?.337:1.137,duration=name==='sparse'?5.731:name==='fractional'?1.131:1.731,anchorTime=name==='sparse'?4.137:start+.8;
    const info=await probe(media.path,['-show_streams','-show_format']),origin=media.timing!.origin,rawFrames=(await probe(media.path,['-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time'])).frames as {best_effort_timestamp_time:string}[],pts=rawFrames.map(f=>Math.round(Number(f.best_effort_timestamp_time)*1e6));
    if(name==='negative'){assert.equal(origin,-2);assert.equal(pts[0],-2000000);}if(name==='fractional')assert.equal(info.streams[0].time_base,'1/30000');
    const raw=(await ff(['-i',media.path,'-map','0:v:0','-fps_mode','passthrough','-pix_fmt','bgr24','-f','rawvideo','pipe:1'])).stdout,stride=160*90*3,sourceCodes=pts.map((_,i)=>{let code=0;for(let bit=0;bit<8;bit++)if(raw[i*stride+(5*160+bit*20+10)*3]>128)code|=1<<bit;return code;});
    const at=Math.round((origin+start)*1e6),until=Math.round((origin+start+duration)*1e6),first=Math.max(0,pts.reduce((last,t,i)=>t<=at?i:last,-1)),indices=pts.flatMap((t,i)=>i>=first&&t<until?[i]:[]),expected=indices.map(i=>Math.max(start,pts[i]/1e6-origin));
    const codes:number[]=[],events:Record<string,unknown>[]=[],pids=new Set<number>(),factory=async()=>mock(frame=>{let code=0;for(let bit=0;bit<8;bit++)if(frame.data[(5*160+bit*20+10)*3]>128)code|=1<<bit;codes.push(code);});
    const result=await trackMedia(media,{start,duration,anchors:[{time:anchorTime,box}],device:'cpu'}, {...ctx,createTracker:factory,diagnostics:e=>{events.push(e);if(typeof e.pid==='number')pids.add(e.pid);}}),data=await readAll(result.path);
    assert.equal(data.samples.length,expected.length,name+' frame count');for(let i=0;i<expected.length;i++)assert.ok(Math.abs(data.samples[i].time-expected[i])<.000002,name+' timestamp '+i);
    const anchor=pts.reduce((last,t,i)=>t<=Math.round((origin+anchorTime)*1e6)?i:last,0),anchorAt=indices.indexOf(anchor),expectedCodes=[...indices.slice(anchorAt).map(i=>sourceCodes[i]),...(anchorAt?[sourceCodes[anchor],...indices.slice(0,anchorAt).reverse().map(i=>sourceCodes[i])]:[])];
    assert.deepEqual(codes,expectedCodes,name+' decoder barcode sequence');assert.equal(data.samples.filter(s=>s.anchor).length,1);assert.ok(events.some(e=>e.event==='tracking-buffer'&&e.capacity===3));
    for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    const still=await trackingStill(media,anchorTime,1280,{...ctx,diagnostics:e=>{if(typeof e.pid==='number')pids.add(e.pid);}});let stillCode=0;for(let bit=0;bit<8;bit++)if(still.bgr[(5*160+bit*20+10)*3]>128)stillCode|=1<<bit;
    assert.equal(stillCode,sourceCodes[anchor],name+' selected still barcode');assert.ok(Math.abs(still.time-(pts[anchor]/1e6-origin))<.000002);assert.equal(still.previousTime,anchor>0?pts[anchor-1]/1e6-origin:undefined);assert.equal(still.nextTime,pts[anchor+1]===undefined?undefined:pts[anchor+1]/1e6-origin);for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    reports.push({name,frames:expected.length,times:expected,codes,origin,still:{time:still.time,previousTime:still.previousTime,nextTime:still.nextTime,code:stillCode}});assert.ok(info.streams.length);
  }
  await fs.writeFile(path.join(root,'clock-results.json'),JSON.stringify(reports,null,2));
});

test('tracking uses the preview SDR color conventions before downscaling',{timeout:120000},async()=>{
  const rows=[];
  for(const row of colors){
    const expected=(await colorReference(row,ctx)).map(p=>p.rgb),captured:number[][][]=[];
    await trackMedia(row.media,{start:.137,duration:.6,anchors:[{time:.2,box}],device:'cpu',maxDimension:1280},{...ctx,createTracker:async()=>mock(frame=>{captured.push(patchSamples(frame.data,frame.width,frame.height,3).map(pixel=>pixel.reverse()));})});
    const still=await trackingStill(row.media,.2,1280,ctx);captured.push(patchSamples(still.bgr,still.width,still.height,3).map(pixel=>pixel.reverse()));
    let max=0;for(const pixels of captured)for(let i=0;i<pixels.length;i++)for(let c=0;c<3;c++)max=Math.max(max,Math.abs(pixels[i][c]-expected[i][c]));assert.ok(max<=2,row.spec.name+' difference '+max);rows.push({name:row.spec.name,maxDifference:max,frames:captured.length});
  }
  await fs.writeFile(path.join(root,'color-results.json'),JSON.stringify(rows,null,2));
});

test('tracking normalizes rotation, pixel aspect and transparent inputs into displayed source coordinates',{timeout:120000},async()=>{
  const rgb=Buffer.alloc(320*192*3),palette=[[255,0,0],[0,255,0],[0,0,255],[255,255,0]];
  for(let y=0;y<192;y++)for(let x=0;x<320;x++)for(let c=0;c<3;c++)rgb[(y*320+x)*3+c]=palette[(y>=96?2:0)+(x>=160?1:0)][c];
  const image=path.join(root,'geometry.ppm'),source=path.join(root,'geometry.mp4');await fs.writeFile(image,Buffer.concat([Buffer.from('P6\n320 192\n255\n'),rgb]));
  await ff(['-loop','1','-framerate','10','-i',image,'-t','1','-vf','scale=out_color_matrix=bt709:out_range=tv,format=yuv444p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709','-c:v','libx264','-crf','0',source]);
  const cases=[{name:'rot90',rotation:90,sar:1,w:192,h:320,order:[1,3,0,2]},{name:'rot180',rotation:180,sar:1,w:320,h:192,order:[3,2,1,0]},{name:'rot270',rotation:270,sar:1,w:192,h:320,order:[2,0,3,1]},{name:'wide',rotation:0,sar:2,w:640,h:192,order:[0,1,2,3]},{name:'tall',rotation:0,sar:.5,w:320,h:384,order:[0,1,2,3]},{name:'wide-rot90',rotation:90,sar:2,w:192,h:640,order:[1,3,0,2]}],rows=[];
  for(const row of cases){
    let input=source;if(row.sar!==1){input=path.join(root,`sar-${row.name}.mp4`);await ff(['-i',source,'-vf',`setsar=${row.sar}`,'-c:v','libx264','-crf','0',input]);}
    const file=path.join(root,`${row.name}.mp4`);await ff([...(row.rotation?['-display_rotation',String(row.rotation)]:[]),'-i',input,'-c','copy',file]);const media=await probeMedia(file,ctx,undefined,{derivatives:false}),captured:number[][][]=[];
    const analysis=await trackMedia(media,{start:.137,duration:.6,anchors:[{time:.3,box}],device:'cpu'},{...ctx,backwardBufferBytes:4*1024*1024,createTracker:async()=>mock(frame=>{assert.equal(frame.width,row.w);assert.equal(frame.height,row.h);captured.push([.25,.75].flatMap(y=>[.25,.75].map(x=>{const at=(Math.floor(y*frame.height)*frame.width+Math.floor(x*frame.width))*3;return Array.from(frame.data.subarray(at,at+3)).reverse();})));})});
    assert.equal(analysis.sourceWidth,row.w);assert.equal(analysis.sourceHeight,row.h);let max=0;for(const samples of captured)for(let i=0;i<4;i++)for(let c=0;c<3;c++)max=Math.max(max,Math.abs(samples[i][c]-palette[row.order[i]][c]));assert.ok(max<=2,row.name+' geometry difference '+max);rows.push({...row,maxDifference:max});
  }
  for(const codec of ['libvpx','libvpx-vp9']){
    const file=path.join(root,`alpha-${codec}.webm`);await ff(['-f','lavfi','-i',"nullsrc=s=160x96:r=10:d=1,format=yuva420p,geq=lum=235:cb=128:cr=128:a='if(lt(X,50),0,if(lt(X,100),128,255))'",'-c:v',codec,...(codec==='libvpx'?['-auto-alt-ref','0','-crf','4','-b:v','1M']:['-lossless','1']),'-pix_fmt','yuva420p',file]);
    const media=await probeMedia(file,ctx,undefined,{derivatives:false});assert.equal(media.hasAlpha,true);const observed:number[][]=[];
    await trackMedia(media,{start:.137,duration:.6,anchors:[{time:.3,box}],device:'cpu'},{...ctx,createTracker:async()=>mock(frame=>{observed.push([25,75,125].map(x=>frame.data[(48*frame.width+x)*3]));})});
    for(const samples of observed)for(let i=0;i<3;i++)assert.ok(Math.abs(samples[i]-[0,128,255][i])<=2,codec+' alpha '+samples);rows.push({codec,observed});
  }
  await fs.writeFile(path.join(root,'geometry-results.json'),JSON.stringify(rows,null,2));
});

test('tracking cancellation and source replacement never publish partial paths or strand decoders',{timeout:120000},async()=>{
  for(const phase of ['forward','backward','source'] as const){
    const input=path.join(root,`cancel-${phase}.mkv`);await fs.copyFile(assets.base.path,input);const media=await probeMedia(input,ctx,undefined,{derivatives:false}),directory=path.join(root,'cleanup-'+phase),controller=new AbortController(),pids=new Set<number>();let changed=false,closed=0;
    await assert.rejects(trackMedia(media,{start:.137,duration:2.731,anchors:[{time:1.5,box}],device:'cpu'},{...ctx,derivedDir:directory,createTracker:async()=>({...mock(),async close(){closed++;}}),diagnostics:e=>{if(typeof e.pid==='number')pids.add(e.pid);}},(p,message)=>{
      if(!changed&&((phase==='backward'&&message==='뒤 방향 추적 중')||(phase!=='backward'&&message==='앞 방향 추적 중'&&p>.1))){changed=true;if(phase==='source')utimesSync(input,new Date(),new Date(Date.now()+10000));else controller.abort();}
    },controller.signal),phase==='source'?/원본 파일이 변경/:{name:'AbortError'});
    assert.ok(changed);assert.equal(closed,1);assert.deepEqual(await fs.readdir(directory),[]);for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  }
});

test('native still cancellation and source replacement tear down owned decoders without publishing stale frames',async()=>{
  for(const phase of ['cancel','source'] as const){
    const file=path.join(root,`still-${phase}.mkv`);await fs.copyFile(assets.base.path,file);const media=await probeMedia(file,ctx,undefined,{derivatives:false}),controller=new AbortController(),pids=new Set<number>();let triggered=false;
    await assert.rejects(trackingStill(media,1.137,1280,{...ctx,diagnostics:e=>{if(typeof e.pid==='number')pids.add(e.pid);if(e.event==='tracking-decoder-start'&&!triggered){triggered=true;if(phase==='cancel')controller.abort();else utimesSync(file,new Date(),new Date(Date.now()+10000));}}},controller.signal),phase==='source'?/원본 파일이 변경/:{name:'AbortError'});
    assert.ok(triggered);for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  }
});

test('native-process failure restarts the entire analysis on CPU, discarding earlier GPU records',async()=>{
  const backends:string[]=[],directory=path.join(root,'fallback');let calls=0;
  const factory:TrackingContext['createTracker']=async backend=>{backends.push(backend);const session=mock();if(backend==='auto')return {...session,backend:'dml',async update(){if(++calls===3)throw Object.assign(new Error('simulated utility exit'),{name:'TrackingProcessError'});return {box:[20,20,20,20],score:.6,status:'tracked'};}};return session;};
  const options:TrackingOptions={start:.137,duration:1.231,anchors:[{time:.7,box}]},result=await trackMedia(assets.base,options,{...ctx,derivedDir:directory,createTracker:factory}),reference=await trackMedia(assets.base,{...options,device:'cpu'},ctx);
  assert.deepEqual(backends,['auto','cpu']);assert.equal(result.backend,'cpu');assert.deepEqual((await readAll(result.path)).samples,(await readAll(reference.path)).samples);assert.equal((await fs.readdir(directory)).filter(n=>n.startsWith('.')).length,0);
});

test('automatic mode does not retry a CPU worker failure as a GPU fallback',async()=>{
  const backends:string[]=[];
  await assert.rejects(trackMedia(assets.base,{start:0,duration:1,anchors:[{time:0,box}]},{...ctx,createTracker:async backend=>{backends.push(backend);return {...mock(),async update(){throw Object.assign(new Error('CPU failed'),{name:'TrackingProcessError'});}};}}),/CPU failed/);
  assert.deepEqual(backends,['auto']);
});

test('tiny high-rate video does not overflow timestamp pairing or lose frames',{timeout:60000},async()=>{
  const file=path.join(root,'tiny.mp4');await ff(['-f','lavfi','-i','color=c=white:s=4x4:r=1000:d=1','-c:v','libx264','-crf','0',file]);const media=await probeMedia(file,ctx,undefined,{derivatives:false});
  const observation=():TrackingObservation=>({box:[0,0,4,4],score:1,status:'tracked'}),result=await trackMedia(media,{start:0,duration:1,anchors:[{time:.5,box:{x:0,y:0,width:1,height:1}}],device:'cpu'},{...ctx,createTracker:async()=>({backend:'cpu',anchor:()=>observation(),async update(){return observation();},async close(){}})}),data=await readAll(result.path);
  assert.equal(data.samples.length,1000);for(let i=0;i<1000;i++)assert.ok(Math.abs(data.samples[i].time-i/1000)<.000001);
});

test('motion path files preserve dense sub-frame times, bounded paging and reject damaged records',async()=>{
  const directory=path.join(root,'records');await fs.mkdir(directory,{recursive:true});const stamp=Date.now(),forward=path.join(directory,`forward-${stamp}`),backward=path.join(directory,`backward-${stamp}`),target=path.join(directory,`track-${stamp}`),writer=await MotionSampleWriter.open(forward,1),back=await MotionSampleWriter.open(backward,-1),count=20005;
  try{for(let i=0;i<count;i++)await writer.append({time:i/120,box,score:.75,status:'tracked',anchor:i===0});}finally{await writer.close();await back.close();}
  await assembleMotionFile(target,{version:1,id:'test',mediaId:'media',sourceRevision:'a'.repeat(64),sourceWidth:1920,sourceHeight:1080,analysisWidth:1280,analysisHeight:720,start:0,end:count/120,firstFrameTime:0,frames:count,anchors:[{time:0,box}],backend:'cpu'},backward,forward);
  const reader=await MotionFileReader.open(target);try{assert.equal(await reader.indexAt(123.456),14814);const range=await reader.range(123.456,5);assert.equal(range.samples.length,5);assert.equal(range.startIndex,14814);assert.equal(range.nextIndex,14819);assert.equal(range.samples[0].time,14814/120);await assert.rejects(reader.range(0,50000));}finally{await reader.close();}
  const damaged=target+'-bad',bytes=await fs.readFile(target),offset=16+bytes.readUInt32LE(8);bytes.writeFloatLE(NaN,offset+8);await fs.writeFile(damaged,bytes);const bad=await MotionFileReader.open(damaged);try{await assert.rejects(bad.sample(0),/손상/);}finally{await bad.close();}
  await fs.writeFile(target+'-short',bytes.subarray(0,bytes.length-1));await assert.rejects(MotionFileReader.open(target+'-short'),/크기/);
});

test('disk reverse windows preserve every decoded frame and record across VFR, negative clocks and fractional cuts',{timeout:180000},async()=>{
  for(const name of ['base','vfr','sparse','negative','fractional']){
    const media=assets[name],start=['sparse','fractional'].includes(name)?.137:name==='negative'?2.137:1.137,duration=name==='sparse'?5.731:name==='fractional'?1.131:name==='negative'?.731:1.731,anchorTime=name==='sparse'?4.137:start+(name==='negative'?.4:.8);
    const rows=[];for(const mode of ['memory','disk']){const observed:string[]=[],events:Record<string,unknown>[]=[];
      const context={...ctx,backwardSpoolBytes:mode==='disk'?160*90*3*9:0,createTracker:async()=>mock(frame=>observed.push(createHash('sha256').update(frame.data).digest('hex'))),diagnostics:(e:Record<string,unknown>)=>events.push(e)};
      const result=await trackMedia(media,{start,duration,anchors:[{time:anchorTime,box}],device:'cpu'},context),data=await readAll(result.path);rows.push({observed,samples:data.samples});
      assert.ok(events.some(e=>e.event==='tracking-buffer'&&e.mode===mode));for(const event of events)if(typeof event.pid==='number')assert.throws(()=>process.kill(Number(event.pid),0),{code:'ESRCH'});
      if(mode==='disk'){const plan=events.find(e=>e.event==='tracking-buffer')!;assert.ok(Number(plan.diskBytes)<=160*90*3*9);assert.equal(plan.payloadBytes,160*90*3);}
    }
    assert.deepEqual(rows[1],rows[0],name+' disk vs memory inference inputs and stored records');
  }
  assert.ok(!(await fs.readdir(ctx.derivedDir!)).some(n=>n.startsWith('.tracking-')));
});

test('disk reverse-window cancellation closes its file and decoder before owned work cleanup',async()=>{
  for(const phase of ['decode','infer'] as const){const controller=new AbortController(),directory=await fs.mkdtemp(path.join(root,'spool-cancel-')),pids=new Set<number>();let armed=false,triggered=false;
    await assert.rejects(trackMedia(assets.base,{start:.137,duration:1.731,anchors:[{time:1.1,box}],device:'cpu'},{...ctx,derivedDir:directory,backwardSpoolBytes:160*90*3*9,diagnostics:e=>{if(typeof e.pid==='number')pids.add(e.pid);if(e.event==='tracking-buffer')armed=true;if(armed&&phase==='decode'&&e.event==='tracking-decoder-start'){triggered=true;controller.abort();}},createTracker:async()=>mock((_frame,anchor)=>{if(armed&&phase==='infer'&&!anchor){triggered=true;controller.abort();}})},undefined,controller.signal),{name:'AbortError'});
    assert.ok(triggered);assert.deepEqual(await fs.readdir(directory),[]);for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  }
});

test('an hour-long sparse VFR source retains its held frame without allocating nominal frames for the gap',async()=>{
  const file=path.join(root,'hour-gap.mp4');await ff(['-f','lavfi','-i','color=c=white:s=160x90:r=10:d=0.2','-vf','setpts=N*3600/TB','-fps_mode','vfr','-enc_time_base:v','filter','-c:v','libx264','-g','1','-crf','0',file]);
  const media=await probeMedia(file,ctx,undefined,{derivatives:false}),events:Record<string,unknown>[]=[];
  const analysis=await trackMedia(media,{start:3590,duration:10.05,anchors:[{time:3600,box}],device:'cpu'},{...ctx,backwardSpoolBytes:160*90*3*9,diagnostics:e=>events.push(e)}),data=await readAll(analysis.path);
  assert.equal(analysis.frames,2);assert.equal(analysis.firstFrameTime,0);assert.deepEqual(data.samples.map(s=>s.time),[3590,3600]);assert.deepEqual(data.samples.map(s=>s.anchor),[false,true]);assert.ok(events.filter(e=>e.event==='tracking-decoder-start').length<=3);assert.ok((await fs.stat(analysis.path)).size<2048);
  const still=await trackingStill(media,3599,1280,ctx);assert.equal(still.time,0);assert.equal(still.previousTime,undefined);assert.equal(still.nextTime,3600);
});
