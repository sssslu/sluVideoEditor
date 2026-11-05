import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {createProxy,detectEncoders,enrichMedia,probeMedia,runProcess} from '../electron/media';
import {changedProjectSources,refreshProjectSources} from '../electron/project-sources';
import {hasLegacyProxyTiming,proxyCacheKey} from '../electron/proxy-cache';
import {newProject,newClip} from '../shared/project';

const root=path.resolve('.test-artifacts/proxy-timing',String(Date.now()));
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const width=160,height=90,frameBytes=width*height*4;
// Long holds and sub-frame irregularities expose both automatic CFR duplication
// and timestamp rounding. Each independently written raw frame identifies itself.
const profiles={holds:[0,32978,66267,99544,132822,166111,199400,350000,400123,433444,900444,1033333,1100333],jitter:Array.from({length:40},(_,n)=>n===0?0:Math.round(n*33278-300+(n%3)*5))};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:90000,maxOutputBytes:32*1024*1024});
async function frames(file:string){
  const data=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time,pkt_duration_time','-of','json',file])).stdout.toString());
  return data.frames.map((f:any)=>Number(f.best_effort_timestamp_time)) as number[];
}
before(async()=>{
  await fs.mkdir(root,{recursive:true});const raw=Buffer.alloc(40*frameBytes);
  for(let n=0;n<40;n++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=n*frameBytes+(y*width+x)*4,code=(n>>Math.floor(x/20))&1;
    raw[i]=y<12?(code?255:0):210;raw[i+1]=y<12?(code?255:0):75;raw[i+2]=y<12?(code?255:0):30;
    raw[i+3]=y<12?255:x<50?0:x<100?128:255;
  }
  await fs.writeFile(path.join(root,'numbered.rgba'),raw);
});

function registerFallbackTest(){test('A real hardware encoder failure falls back to CPU without changing VFR frames or times',{timeout:120000},async t=>{
  const encoders=await detectEncoders(ctx);if(!encoders.some(e=>['h264_nvenc','h264_qsv','h264_amf'].includes(e))){t.skip('No usable hardware encoder to fail on this machine');return;}
  const asset=await probeMedia(path.join(root,'jitter-opaque-2.mov'),ctx,undefined,{derivatives:false});
  const original=childProcess.spawn,attempts:{codec:string;code:number|null}[]=[];
  childProcess.spawn=function(this:typeof childProcess,...args:any[]){
    const argv=args[1];let row:{codec:string;code:number|null}|undefined;
    if(Array.isArray(argv)&&argv.includes('-progress')&&argv.includes('-c:v')){
      const codec=argv[argv.indexOf('-c:v')+1];row={codec,code:null};attempts.push(row);
      // Let a real FFmpeg process reject an invalid option in the hardware
      // attempt. The following CPU attempt still runs the production arguments.
      if(codec!=='libx264')args[1]=[...argv.slice(0,-1),'-slu-injected-invalid-option',argv.at(-1)];
    }
    const child=Reflect.apply(original,this,args);if(row)child.once('close',(code:number|null)=>row!.code=code);return child;
  } as typeof childProcess.spawn;syncBuiltinESMExports();
  try{
    const proxy=await createProxy(asset,{...ctx,cacheDir:path.join(root,'cpu-fallback-cache')});
    const actual=await frames(proxy.proxyPath!);assert.equal(actual.length,profiles.jitter.length);
    for(let n=0;n<actual.length;n++)assert.ok(Math.abs(actual[n]-profiles.jitter[n]/1e6)<.000002,`CPU frame ${n}: ${actual[n]}`);
    const raw=(await ff(['-i',proxy.proxyPath!,'-an','-fps_mode','passthrough','-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout;
    assert.equal(raw.length,profiles.jitter.length*frameBytes);
    for(let n=0;n<profiles.jitter.length;n++){let code=0;for(let bit=0;bit<8;bit++)if(raw[n*frameBytes+(5*width+10+20*bit)*4]>127)code|=1<<bit;assert.equal(code,n);}
    assert.equal(attempts.length,2);assert.notEqual(attempts[0].code,0);assert.deepEqual(attempts[1],{codec:'libx264',code:0});
    await fs.writeFile(path.join(root,'cpu-fallback.json'),JSON.stringify({attempts,actual,proxy:proxy.proxyPath},null,2));
  }finally{childProcess.spawn=original;syncBuiltinESMExports();}
});}
for(const [profile,times] of Object.entries(profiles))for(const alpha of [true,false])for(const origin of [0,2])test(`${alpha?'Transparent':'Opaque'} VFR ${profile} proxy preserves every numbered frame and its normalized time (origin ${origin})`,{timeout:120000},async()=>{
  const source=path.join(root,`${profile}-${alpha?'alpha':'opaque'}-${origin}.mov`);
  let expression=String(times[times.length-1]);for(let n=times.length-2;n>=0;n--)expression=`if(eq(N,${n}),${times[n]},${expression})`;
  await ff(['-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-framerate','30','-i',path.join(root,'numbered.rgba'),'-f','lavfi','-i',`aevalsrc=0.08*sin(2*PI*437*t)|0.04*sin(2*PI*701*t):s=48000:d=${(times[times.length-1]+33333)/1e6}`,'-vf',`settb=AVTB,setpts='${expression}'`,'-frames:v',String(times.length),'-fps_mode','passthrough','-enc_time_base:v','1:1000000','-c:v',alpha?'ffv1':'libx264',...(alpha?['-level','3','-pix_fmt','bgra']:['-preset','ultrafast','-crf','0','-pix_fmt','yuv420p','-bf','0']),'-c:a','pcm_f32le','-video_track_timescale','1000000','-movie_timescale','1000000','-output_ts_offset',String(origin),'-avoid_negative_ts','disabled',source]);
  const sourceTimes=await frames(source);assert.equal(sourceTimes.length,times.length);
  for(let n=0;n<times.length;n++)assert.ok(Math.abs(sourceTimes[n]-origin-times[n]/1e6)<.000002,`fixture ${n}: ${sourceTimes[n]}`);
  const asset=await probeMedia(source,ctx,undefined,{derivatives:false});assert.equal(!!asset.hasAlpha,alpha);
  const proxy=await createProxy(asset,ctx),actual=await frames(proxy.proxyPath!);
  const pixels=(await ff([...(alpha?['-c:v','libvpx-vp9']:[]),'-i',proxy.proxyPath!,'-map','0:v:0','-an','-fps_mode','passthrough','-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout;
  const identities=[];for(let n=0;n<pixels.length/frameBytes;n++){let code=0;for(let bit=0;bit<8;bit++)if(pixels[n*frameBytes+(5*width+10+20*bit)*4]>127)code|=1<<bit;identities.push(code);}
  const report={alpha,origin,sourceTimes,proxyTimes:actual,identities,source,proxy:proxy.proxyPath};
  await fs.writeFile(path.join(root,`${profile}-${alpha?'alpha':'opaque'}-${origin}.json`),JSON.stringify(report,null,2));
  assert.deepEqual(identities,times.map((_,i)=>i),'Proxy dropped, duplicated, or reordered source frames');
  assert.equal(actual.length,times.length);
  for(let n=0;n<times.length;n++)assert.ok(Math.abs(actual[n]-times[n]/1e6)<(alpha?.001:.000002),`Frame ${n}: proxy ${actual[n]} vs source ${times[n]/1e6}`);
  if(alpha)for(const [x,expected] of [[25,0],[75,128],[125,255]])assert.ok(Math.abs(pixels[(45*width+x)*4+3]-expected)<=2);
  const metadata=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-show_streams','-of','json',proxy.proxyPath!])).stdout.toString());
  assert.equal(metadata.streams.find((s:any)=>s.codec_type==='audio')?.channels,2);
});
registerFallbackTest();
test('Opening an old cached proxy refreshes timing metadata without changing edits or removing files',async()=>{
  for(const alpha of [true,false]){
    const asset=await probeMedia(path.join(root,`jitter-${alpha?'alpha':'opaque'}-2.mov`),ctx,undefined,{derivatives:false});
    for(let version=1;version<=(alpha?3:2);version++){
      const kind=alpha?'alpha':'color',hash=createHash('sha256').update(`proxy-${kind}-source-v${version}|${asset.sourceRevision}`).digest('hex').slice(0,28);
      const old=path.join(root,`${hash}-${kind}-proxy.${alpha?'webm':'mp4'}`),sentinel=Buffer.from('Retain the previous file');await fs.writeFile(old,sentinel);
      const media={...asset,name:'User asset title',proxyPath:old},project=newProject();project.media=[media];project.clips=[{...newClip('video-1',media),in:.2,duration:.5,start:3}];
      assert.equal(hasLegacyProxyTiming(media),true);const snapshot=JSON.stringify(project),changed=await changedProjectSources(project);assert.deepEqual([...changed],[asset.path]);
      const refreshed=await refreshProjectSources(project,changed,ctx);assert.equal(refreshed.changedSources,0);assert.deepEqual(refreshed.project.clips,project.clips);assert.equal(refreshed.project.media[0].name,media.name);assert.equal(refreshed.project.media[0].proxyPath,undefined);assert.equal(JSON.stringify(project),snapshot);
      assert.equal((await enrichMedia(media,ctx)).proxyPath,undefined);assert.ok((await fs.readFile(old)).equals(sentinel));
    }
    const current=await createProxy(asset,ctx);assert.equal(hasLegacyProxyTiming(current),false);assert.ok(current.proxyPath!.includes(proxyCacheKey(asset)));
    const named={...asset,proxyPath:`externally-named-${alpha?'alpha-proxy.webm':'color-proxy.mp4'}`};assert.equal(hasLegacyProxyTiming(named),false);
  }
});
