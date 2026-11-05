import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {probeMedia,runProcess} from '../electron/media';
import {removePersonBackground,type PersonCutoutContext} from '../electron/matting';

const root=path.resolve('.test-artifacts/matting-selection',`${Date.now()}-${process.pid}`);
const binaries={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe')};
const ff=(args:string[])=>runProcess(binaries.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:60000});

function inference():Awaited<ReturnType<PersonCutoutContext['createMatting']>>{
  return {backend:'cpu',async process(frame,pts){
    const bgra=new Uint8Array(frame.width*frame.height*4);
    for(let pixel=0;pixel<frame.width*frame.height;pixel++){
      bgra.set(frame.data.subarray(pixel*3,pixel*3+3),pixel*4);bgra[pixel*4+3]=255;
    }
    return {width:frame.width,height:frame.height,pts,backend:'cpu',data:bgra};
  },async close(){}};
}

test('cutout preserves silence and exact stereo samples before, after and partially across a finite audio track',{timeout:60000},async()=>{
  await fs.mkdir(root,{recursive:true});
  for(const audioOffset of [0,2.5]){
    const source=path.join(root,`audio-${audioOffset}.mov`);
    await ff(['-f','lavfi','-i','testsrc2=s=128x72:r=30:d=3','-itsoffset',String(audioOffset),'-f','lavfi','-i','aevalsrc=0.1*sin(2*PI*997*t)|0.05*sin(2*PI*701*t):s=48000:d=0.25','-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast','-threads','1','-c:a','pcm_f32le',source]);
    for(const start of [1,audioOffset===0?.1:2.4]){
      const directory=path.join(root,`derived-${audioOffset}-${start}`);let processed=0;
      const ctx:PersonCutoutContext={...binaries,cacheDir:path.join(root,`cache-${audioOffset}`),derivedDir:directory,createMatting:async()=>({
        backend:'cpu',async process(frame,pts){
          processed++;const bgra=new Uint8Array(frame.width*frame.height*4);
          for(let pixel=0;pixel<frame.width*frame.height;pixel++){
            bgra.set(frame.data.subarray(pixel*3,pixel*3+3),pixel*4);bgra[pixel*4+3]=255;
          }
          return {width:frame.width,height:frame.height,pts,backend:'cpu',data:bgra};
        },async close(){},
      })};
      const media=await probeMedia(source,ctx,undefined,{derivatives:false});assert.equal(media.hasAudio,true);
      const expected=(await ff(['-copyts','-i',source,'-map','0:a:0','-af',`atrim=start=${start}:end=${start+.5},asetpts=PTS-round(${start}/TB)`,'-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
      const result=await removePersonBackground(media,{start,duration:.5},ctx);
      assert.equal(result.hasAlpha,true);assert.equal(result.duration,.5);assert.equal(result.hasAudio,true);assert.equal(processed,15);
      const info=JSON.parse((await runProcess(binaries.ffprobe,['-v','error','-show_frames','-show_streams','-of','json',result.path])).stdout.toString());
      const audio=info.streams.filter((stream:{codec_type:string})=>stream.codec_type==='audio');
      assert.equal(audio.length,1);assert.equal(audio[0].channels,2);assert.equal(audio[0].sample_rate,'48000');
      const actual=(await ff(['-i',result.path,'-map','0:a:0','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
      // An empty selection retains this track's slot with one zero sample per
      // channel. Real selected samples remain byte-exact and keep their delay.
      assert.deepEqual(actual,expected.length?expected:Buffer.alloc(8));
      const first=info.frames.find((frame:{media_type:string})=>frame.media_type==='audio');
      const firstTime=expected.length?Math.max(0,audioOffset-start):0;
      assert.ok(Math.abs(Number(first.best_effort_timestamp_time)-firstTime)<.000001);
      assert.equal((await fs.readdir(directory)).some(name=>name.startsWith('.cutout-')),false);
    }
  }
});

test('empty selections retain every source audio ordinal, rate and channel layout',{timeout:60000},async()=>{
  await fs.mkdir(root,{recursive:true});
  for(const [name,firstDuration,secondDuration] of [['first-empty',.25,3],['second-empty',3,.25],['all-empty',.25,.25]] as const){
    const source=path.join(root,`multiple-audio-${name}.mov`);
    await ff(['-f','lavfi','-i','testsrc2=s=128x72:r=30:d=3','-f','lavfi','-i',`aevalsrc=0.1:s=44100:d=${firstDuration}`,'-f','lavfi','-i',`aevalsrc=0.2|0.15:s=48000:d=${secondDuration}`,'-map','0:v:0','-map','1:a:0','-map','2:a:0','-c:v','libx264','-preset','ultrafast','-threads','1','-c:a','pcm_f32le','-disposition:a:0','default','-disposition:a:1','0',source]);
    const directory=path.join(root,`multi-derived-${name}`);
    const ctx:PersonCutoutContext={...binaries,cacheDir:path.join(root,`multi-cache-${name}`),derivedDir:directory,createMatting:async()=>inference()};
    const media=await probeMedia(source,ctx,undefined,{derivatives:false}),output=await removePersonBackground(media,{start:1,duration:.5},ctx);
    const info=JSON.parse((await runProcess(binaries.ffprobe,['-v','error','-show_streams','-show_frames','-of','json',output.path])).stdout.toString());
    const streams=info.streams.filter((stream:{codec_type:string})=>stream.codec_type==='audio');
    assert.equal(streams.length,2,'Every original audio stream must retain its ordinal position');
    assert.equal(output.hasAudio,true);assert.equal(output.duration,.5);
    for(const [ordinal,channels,rate] of [[0,1,44100],[1,2,48000]]){
      assert.equal(streams[ordinal].channels,channels);assert.equal(Number(streams[ordinal].sample_rate),rate);
      const actual=(await ff(['-i',output.path,'-map',`0:a:${ordinal}`,'-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
      const expected=(await ff(['-copyts','-i',source,'-map',`0:a:${ordinal}`,'-af','atrim=start=1:end=1.5,asetpts=PTS-round(1/TB)','-c:a','pcm_f32le','-f','f32le','pipe:1'])).stdout;
      // A single zero sample represents an empty track without promoting a
      // later track. In particular the editor's first-track playback stays mute.
      assert.deepEqual(actual,expected.length?expected:Buffer.alloc(channels*4));
      const first=info.frames.find((frame:{stream_index:number})=>frame.stream_index===streams[ordinal].index);
      assert.equal(Number(first.best_effort_timestamp_time),0);
    }
    assert.equal((await fs.readdir(directory)).some(name=>name.startsWith('.cutout-')),false);
  }
});

test('audio decoder errors cannot be published as a silent placeholder',{timeout:60000},async()=>{
  await fs.mkdir(root,{recursive:true});const source=path.join(root,'corrupt-audio.mov');
  await ff(['-f','lavfi','-i','testsrc2=s=128x72:r=30:d=3','-f','lavfi','-i','sine=frequency=997:sample_rate=48000:duration=2','-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast','-threads','1','-c:a','aac',source]);
  const packetData=JSON.parse((await runProcess(binaries.ffprobe,['-v','error','-select_streams','a:0','-show_packets','-show_entries','packet=pts_time,pos,size','-of','json',source])).stdout.toString());
  const packet=packetData.packets.find((value:{pts_time:string;size:string})=>Number(value.pts_time)>1.1&&Number(value.size)>32);assert.ok(packet);
  const handle=await fs.open(source,'r+');
  try{const invalid=Buffer.alloc(Number(packet.size));await handle.write(invalid,0,invalid.length,Number(packet.pos));}finally{await handle.close();}
  const check=await ff(['-i',source,'-map','0:a:0','-f','null','-']);
  assert.ok(check.stderr.trim(),'The corrupt fixture must report a decoder error even when FFmpeg exits successfully');
  const events:Record<string,unknown>[]=[],directory=path.join(root,'corrupt-derived');
  const ctx:PersonCutoutContext={...binaries,cacheDir:path.join(root,'corrupt-cache'),derivedDir:directory,createMatting:async()=>inference(),diagnostics:event=>events.push(event)};
  const media=await probeMedia(source,ctx,undefined,{derivatives:false});
  await assert.rejects(removePersonBackground(media,{start:1,duration:.5},ctx),/오디오 처리 중 오류/);
  assert.equal(events.filter(event=>event.event==='matting-mux-start').length,1);
  assert.deepEqual(await fs.readdir(directory),[],'A corrupt mux must leave neither a published output nor a partial working directory');
});
