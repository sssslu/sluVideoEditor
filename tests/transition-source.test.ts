import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,utimesSync} from 'node:fs';
import path from 'node:path';
import {newClip,newProject} from '../shared/project';
import {probeMedia,prepareRenderSources,renderProject,runProcess,type EngineContext} from '../electron/media';
import {compileTransitions} from '../shared/transitions';
import type {ExportSettings} from '../shared/types';

const root=path.resolve('.test-artifacts/transitions/source'),ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false};
const settings=(name:string):ExportSettings=>({outputPath:path.join(root,`${name}.mp4`),width:160,height:90,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'high'});
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args]);

test('export trusts actual video frames over forged duration/range and checks revision before publishing',{timeout:60000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const source=path.join(root,'video-short-audio-long.mkv');await ff(['-f','lavfi','-i','color=red:s=160x90:r=30:d=2','-f','lavfi','-i','sine=frequency=437:sample_rate=48000:duration=4','-c:v','libx264','-preset','ultrafast','-c:a','pcm_f32le',source]);
  const asset=await probeMedia(source,ctx,undefined,{derivatives:false}),p=newProject();p.width=160;p.height=90;p.media=[{...asset,videoStart:0,videoEnd:4}];const a=newClip('video-1',asset);a.duration=1;const b=newClip('video-1',asset,1);b.in=1.5;b.duration=1;p.clips=[a,b];p.transitions=[{id:'forged',fromClipId:a.id,toClipId:b.id,kind:'dissolve',durationFrames:42}];assert.equal(compileTransitions(p).transitions.length,1);const stored=JSON.stringify(p);await assert.rejects(prepareRenderSources(p,settings('forged'),ctx),/원본|핸들|범위|전환/);assert.equal(JSON.stringify(p),stored);
  p.transitions=undefined;p.clips=[a];const originalRevision=asset.sourceRevision;const stat=await fs.stat(source);await fs.utimes(source,stat.atime,new Date(stat.mtimeMs+2000));await assert.rejects(renderProject(p,settings('replaced'),ctx),/변경.*다시 가져/);assert.equal(p.media[0].sourceRevision,originalRevision);
  const fresh=await probeMedia(source,ctx,undefined,{derivatives:false});p.media=[fresh];a.mediaId=fresh.id;const output=settings('changed-during-render'),sentinel=Buffer.from('existing destination must survive');await fs.writeFile(output.outputPath!,sentinel);let changed=false;await assert.rejects(renderProject(p,output,{...ctx,diagnostics:event=>{if(!changed&&event.event==='window-end'){changed=true;utimesSync(source,new Date(),new Date(Date.now()+4000));}}}),/내보내는 중 원본 파일이 변경/);assert.ok(changed);assert.ok((await fs.readFile(output.outputPath!)).equals(sentinel));assert.equal((await fs.readdir(root)).filter(file=>file.includes('.partial.')).length,0);
  const result={forgedRangeRejected:true,replacedSourceRejected:true,midExportChangeRejected:true,previousDestinationPreserved:true,serializedProjectUnchanged:true,partialOutputs:0};await fs.writeFile(path.join(root,'results.json'),JSON.stringify(result,null,2));t.diagnostic(JSON.stringify(result));
});
