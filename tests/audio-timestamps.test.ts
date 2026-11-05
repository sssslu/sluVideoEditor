import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newClip,newProject} from '../shared/project';
import {TimelineAudioMixer} from '../electron/render-audio';
import {probeMedia,runProcess} from '../electron/media';
import type {MediaAsset} from '../shared/types';

const root=path.resolve('.test-artifacts/audio-timestamps');
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args]);
type Report={curve:boolean;start:number;speed:number;delay?:number;silence:number;tone:number};
let delayed:MediaAsset,gapped:MediaAsset;
before(async()=>{
  await fs.mkdir(root,{recursive:true});
  const video=['-f','lavfi','-i','color=black:s=160x90:r=30:d=2'];
  const encoding=['-c:v','libx264','-preset','ultrafast','-c:a','pcm_s16le'];
  const delayedPath=path.join(root,'delayed.mkv'),gappedPath=path.join(root,'gapped.mkv');
  await ff([...video,'-itsoffset','0.5','-f','lavfi','-i','sine=frequency=437:sample_rate=48000:duration=1.5','-map','0:v:0','-map','1:a:0',...encoding,'-t','2',delayedPath]);
  await ff([...video,'-f','lavfi','-i','sine=frequency=437:sample_rate=48000:duration=1.5','-filter_complex',"[1:a]asetpts='PTS+gte(T,0.5)*0.5/TB'[a]",'-map','0:v:0','-map','[a]',...encoding,gappedPath]);
  const initial=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-show_entries','stream=codec_type,start_time','-of','json',delayedPath])).stdout.toString());
  assert.equal(Number(initial.streams.find((s:{codec_type:string})=>s.codec_type==='video').start_time),0);
  assert.equal(Number(initial.streams.find((s:{codec_type:string})=>s.codec_type==='audio').start_time),.5);
  const packets=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-select_streams','a:0','-show_packets','-show_entries','packet=pts_time','-of','json',gappedPath])).stdout.toString()).packets.map((p:{pts_time:string})=>Number(p.pts_time));
  assert.ok(packets.some((time:number,i:number)=>i&&time-packets[i-1]>.5),'Fixture must contain an actual timestamp gap');
  delayed=await probeMedia(delayedPath,ctx,undefined,{derivatives:false});gapped=await probeMedia(gappedPath,ctx,undefined,{derivatives:false});
});

function rms(pcm:Buffer,from:number,to:number){
  const start=Math.round(from*48000),end=Math.round(to*48000);assert.ok(start>=0&&end<=pcm.length/8&&end>start);
  let sum=0;for(let frame=start;frame<end;frame++)sum+=pcm.readFloatLE(frame*8)**2;return Math.sqrt(sum/(end-start));
}
async function mix(media:MediaAsset,start:number,sourceDuration:number,speed:number,curve:boolean){
  const project=newProject(),clip={...newClip('video-1',media),in:start,duration:sourceDuration/speed,speed,speedCurve:curve?[{position:0,speed},{position:1,speed}]:undefined};
  project.media=[media];project.clips=[clip];const mixer=new TimelineAudioMixer(project,ctx.ffmpeg,new AbortController().signal),parts:Buffer[]=[];
  const frames=Math.round(clip.duration*48000);
  try{for(let at=0;at<frames;at+=4096)parts.push(await mixer.mix(at,Math.min(4096,frames-at)));}finally{await mixer.close();}
  const pcm=Buffer.concat(parts);assert.equal(pcm.length,frames*8);return pcm;
}

test('delayed audio retains its source-time silence through seeks and constant or curve speed changes',{timeout:60000},async t=>{
  const reports:Report[]=[];
  for(const curve of [false,true])for(const start of [0,.25,.75])for(const speed of [1,2]){
    await t.test(`${curve?'curve':'constant'} ${speed}x source-in ${start}`,async()=>{
      const pcm=await mix(delayed,start,1,speed,curve),delay=Math.max(0,.5-start)/speed;
      const silence=delay>0?rms(pcm,0,delay-.06/speed):0,tone=rms(pcm,delay+.08/speed,delay+.18/speed);
      assert.ok(silence<.001,`Sound leaked ahead of delayed source start: RMS ${silence}`);
      assert.ok(tone>.03,`Tone was lost or shifted after source start: RMS ${tone}`);
      reports.push({curve,start,speed,delay,silence,tone});
    });
  }
  await fs.writeFile(path.join(root,'delayed-results.json'),JSON.stringify(reports,null,2));
});

test('timestamp gaps remain silence at the correct source interval after trims and speed changes',{timeout:60000},async t=>{
  const reports:Report[]=[];
  for(const curve of [false,true])for(const start of [0,.25,.75])for(const speed of [1,2]){
    await t.test(`${curve?'curve':'constant'} ${speed}x source-in ${start}`,async()=>{
      const pcm=await mix(gapped,start,2-start,speed,curve);
      const silence=rms(pcm,(.82-start)/speed,(.90-start)/speed),tone=rms(pcm,(1.2-start)/speed,(1.3-start)/speed);
      assert.ok(silence<.001,`Source timestamp gap was collapsed: RMS ${silence}`);
      assert.ok(tone>.03,`Tone did not resume at original source time: RMS ${tone}`);
      reports.push({curve,start,speed,silence,tone});
    });
  }
  await fs.writeFile(path.join(root,'gap-results.json'),JSON.stringify(reports,null,2));
});
