import {app} from 'electron';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {electronTestLifecycle} from './electron-test-lifecycle';
import {newProject,newClip} from '../shared/project';
import {defaultCaptionStyle} from '../shared/captions';
import {createCaptionRasterWithPaths} from '../electron/caption-raster';
import {renderProject,runProcess,detectEncoders,type EngineContext} from '../electron/media';
import type {ExportSettings} from '../shared/types';

if(process.env.SLU_USER_DATA)app.setPath('userData',process.env.SLU_USER_DATA);
const lifecycle=electronTestLifecycle(),root=path.resolve('.test-artifacts/rich-captions/benchmark'),details:unknown[]=[];app.on('window-all-closed',()=>{});
void(async()=>{try{
  await app.whenReady();await fs.mkdir(root,{recursive:true});
  const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),captionRasterFactory:async(project,settings,signal,diagnostics)=>{const session=await createCaptionRasterWithPaths(project,settings,signal,diagnostics,{directory:path.resolve('dist'),preload:path.resolve('dist-electron/caption-preload.cjs')});lifecycle.registerCleanup(()=>session.close());return session;}};
  assert.ok((await detectEncoders(ctx,lifecycle.signal)).includes('h264_nvenc'));
  for(const kind of ['blank-baseline','rich-captions']){
    const p=newProject();p.width=1920;p.height=1080;p.fps=30;p.background='#112233';const clip=newClip('text-1');clip.text='';clip.start=0;clip.duration=2;clip.animation='none';clip.fadeIn=0;clip.fadeOut=0;
    if(kind==='rich-captions')Object.assign(clip,{text:'고화질 자막 · 한글 👩‍💻 Caption',fontSize:84,y:280,captionStyle:{...defaultCaptionStyle(),background:'line'},captionWords:[{from:0,to:4,start:0,end:.5,timing:'measured'},{from:5,to:7,start:.5,end:1,timing:'measured'},{from:10,to:12,start:1,end:1.5,timing:'measured'}],captionAnimation:{entry:'fade',exit:'fade',entrySeconds:.15,exitSeconds:.15,easing:'ease-out'}});
    p.clips=[clip];const settings:ExportSettings={width:3840,height:2160,fps:30,format:'mp4',codec:'h264',encoder:'nvenc',quality:'high',outputPath:path.join(root,`${kind}.mp4`)};
    const events:Record<string,unknown>[]=[];let peakMainRss=0,peakRendererWorkingSetKb=0;const sample=()=>{peakMainRss=Math.max(peakMainRss,process.memoryUsage().rss);for(const metric of app.getAppMetrics())if(metric.type==='Tab')peakRendererWorkingSetKb=Math.max(peakRendererWorkingSetKb,metric.memory.workingSetSize);};const timer=setInterval(sample,100);sample();
    const start=performance.now();try{await lifecycle.track(renderProject(p,settings,{...ctx,diagnostics:event=>events.push(event)},undefined,lifecycle.signal));}finally{sample();clearInterval(timer);}const seconds=(performance.now()-start)/1000;
    const probe=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-count_frames','-show_streams','-show_format','-of','json',settings.outputPath!])).stdout.toString()),video=probe.streams.find((stream:{codec_type:string})=>stream.codec_type==='video');assert.equal(video.width,3840);assert.equal(video.height,2160);assert.equal(video.avg_frame_rate,'30/1');assert.equal(Number(video.nb_read_frames),60);assert.equal(Number(probe.format.duration),2);
    await runProcess(ctx.ffmpeg,['-v','error','-sseof','-0.05','-i',settings.outputPath!,'-frames:v','1','-f','null','-']);
    const caption=events.find(event=>event.event==='caption-renderer-close');if(kind==='rich-captions'){assert.ok(Number(caption?.reusedFrames)>30);assert.ok(Number(caption?.peakCacheBytes)<=64*1024*1024);}
    details.push({kind,seconds,width:3840,height:2160,fps:30,frames:60,duration:2,encoder:'h264_nvenc',composition:'CPU Canvas rich text + FFmpeg RGB compositing; GPU NVENC encoding',peakMainRss,peakRendererWorkingSetKb,memoryScope:'Main process and caption renderer only; FFmpeg/GPU allocations excluded',events});
  }
  const files=['electron/media.ts','electron/caption-raster.ts','electron/caption-renderer.ts','electron/render-captions.ts','electron/render-plan.ts','dist/caption-export.html','dist-electron/caption-preload.cjs',...((await fs.readdir('dist/assets')).filter(file=>/^(text-|captions-|Noto)/.test(file)).map(file=>`dist/assets/${file}`))];
  const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify({passed:true,version:JSON.parse(await fs.readFile('package.json','utf8')).version,executable:process.execPath,recordedAt:new Date().toISOString(),timingContext:'Isolated local run; two-second synthetic 4K30 caption fixture, not a general editor benchmark.',checks:['Both baseline and rich caption 4K30 exports contain60 frames /2 seconds and decode their final frame','Static caption states reuse a bounded raster cache'],details,hashes},null,2));await lifecycle.close(0);
}catch(error){await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({error:String(error),stack:error instanceof Error?error.stack:undefined,details},null,2));await lifecycle.close(1,error);}})();
