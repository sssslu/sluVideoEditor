import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {probeMedia,createProxy,detectEncoders,renderProject,type EngineContext} from '../electron/media';
import {newProject,newClip} from '../shared/project';
import type {ExportSettings} from '../shared/types';
const exec=promisify(execFile),root=path.resolve('.test-artifacts/integration');await fs.mkdir(root,{recursive:true});
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
async function ff(args:string[]){return exec(ctx.ffmpeg,['-hide_banner','-loglevel','error','-y',...args],{windowsHide:true,maxBuffer:8*1024*1024});}
const source=path.join(root,'한글 원본 sample.mp4');
await ff(['-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-shortest',source]);
const media=await probeMedia(source,ctx);assert.equal(media.kind,'video');assert.equal(media.width,640);assert.equal(media.height,360);assert.ok(media.hasAudio);assert.ok(Math.abs(media.duration-4)<.1);assert.ok(media.thumbnail);assert.ok(media.waveform?.length);
const encoders=await detectEncoders(ctx);console.log('Available encoders:',encoders.join(', '));
const p=newProject();p.name='Integration Korean test';p.width=640;p.height=360;p.media=[media];
const c=newClip('video-1',media);c.start=.5;c.in=.4;c.duration=2;c.speed=1.5;c.fadeIn=.2;c.fadeOut=.2;c.preset='warm';
p.clips=[c];
const t=newClip('text-1');t.start=1;t.duration=1.5;t.text='한글 자막 검증\nSLU STUDIO';t.fontSize=32;t.y=85;t.textStyle='box';t.animation='fade';p.clips.push(t);
p.tracks.push({id:'video-2',name:'PiP',type:'video',muted:false,hidden:false,locked:false});
const pip=newClip('video-2',media,1.5);pip.duration=1.5;pip.in=.5;pip.scale=.35;pip.x=175;pip.y=-75;pip.rotation=10;pip.volume=0;pip.keyframes=[{time:0,x:150,y:-75,scale:.3,opacity:.7,rotation:0},{time:1.5,x:175,y:-65,scale:.4,opacity:1,rotation:15}];p.clips.push(pip);
const common:ExportSettings={width:640,height:360,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'draft'};
const results:any[]=[];
for(const [name,settings] of [['cpu',common],['nvenc',{...common,encoder:'nvenc'}],['webm',{...common,format:'webm'}],['gif',{...common,format:'gif',width:320,height:180,fps:12}],['audio',{...common,format:'wav'}]] as [string,ExportSettings][]){
  if(name==='nvenc'&&!encoders.includes('h264_nvenc'))continue;
  const file=path.join(root,`render-${name}.${settings.format}`),start=performance.now();await renderProject(p,{...settings,outputPath:file},ctx);
  const result=await probeMedia(file,ctx);assert.ok(Math.abs(result.duration-3)<.25,`${name} duration ${result.duration}`);if(name!=='audio'){assert.equal(result.width,settings.width);assert.equal(result.height,settings.height);}else assert.equal(result.kind,'audio');
  results.push({name,path:file,seconds:(performance.now()-start)/1000,outputBytes:(await fs.stat(file)).size,duration:result.duration});console.log(results.at(-1));
}
const proxy=await createProxy(media,ctx);assert.ok(proxy.proxyPath);const proxyMeta=await probeMedia(proxy.proxyPath!,ctx);assert.ok(Math.abs(proxyMeta.duration-media.duration)<.1);
// Audio must remain silent before the source starts and audible afterward.
for(const [time,audible] of [[.1,false],[1,true]] as const){const r=await exec(ctx.ffmpeg,['-hide_banner','-ss',String(time),'-t','0.15','-i',path.join(root,'render-cpu.mp4'),'-vn','-af','volumedetect','-f','null','-'],{windowsHide:true});const volume=Number(/mean_volume: ([-\d.]+) dB/.exec(r.stderr)?.[1]);assert.ok(Number.isFinite(volume));assert.ok(audible?volume>-50:volume<-70,`audio timing at ${time}: ${volume}`);}
// Cancellation should leave neither a final output nor a successful-looking partial result.
const abort=new AbortController(),cancelOutput=path.join(root,'cancelled.mp4');const work=renderProject({...p,clips:p.clips.map(c=>c.text!==undefined?{...c,duration:20}:c)},{...common,width:1920,height:1080,quality:'high',outputPath:cancelOutput},ctx,()=>{},abort.signal);setTimeout(()=>abort.abort(),150);await assert.rejects(work);assert.equal(await fs.stat(cancelOutput).then(()=>true,()=>false),false);
await ff(['-ss','1.8','-i',path.join(root,'render-cpu.mp4'),'-frames:v','1',path.join(root,'render-preview.png')]);
const report={date:new Date().toISOString(),encoders,results,checks:['Unicode paths and subtitles','Trim, speed, gaps, layered video, animated transforms','CPU and hardware encode','GIF and WAV outputs','Proxy generation','Audio alignment','Cancellation cleanup']};await fs.writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));console.log('Integration checks passed.');
