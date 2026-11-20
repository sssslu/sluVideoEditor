import test,{before,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,utimesSync} from 'node:fs';
import path from 'node:path';
import childProcess,{type ChildProcess} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {measureSelectionLoudness} from '../electron/loudness';
import {probeMedia,renderProject,runProcess,type EngineContext} from '../electron/media';
import {newClip,newProject} from '../shared/project';
import {defaultEQ} from '../shared/audio-eq';
import {applyLoudnessResult,loudnessSignature} from '../shared/loudness';
import type {MediaAsset,Project} from '../shared/types';

const root=path.resolve('.test-artifacts/loudness',`${Date.now()}-${process.pid}`),ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),audioStretch:path.resolve('resources/bin/slu-audio-stretch.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-nostdin','-y',...args],{timeoutMs:30000});
const assets={} as Record<string,MediaAsset>;
before(async()=>{
  await fs.mkdir(root,{recursive:true});
  for(const [name,expression,duration] of [['tone','if(lt(t,6),0.4,0.035)*sin(2*PI*437*t)',12],['peak','(0.005+if(lt(mod(t,1),0.004),0.78,0))*sin(2*PI*997*t)',4],['silent','0',2]] as const){
    const file=path.join(root,`${name}.wav`);await ff(['-v','error','-f','lavfi','-i',`aevalsrc=${expression.replaceAll(',',String.raw`\,`)}:s=48000:d=${duration}`,'-ac','2','-c:a','pcm_f32le',file]);assets[name]=await probeMedia(file,ctx,undefined,{derivatives:false});
  }
});
function project(asset=assets.tone,start=0,duration=2):Project{const p=newProject();p.width=160;p.height=90;p.media=[asset];p.clips=[{...newClip('audio-1',asset,start),duration}];return p;}
function ownChildren(t:TestContext){
  const original=childProcess.spawn,children:{child:ChildProcess;args:string[];closed:boolean}[]=[];let active=0,maximum=0;
  childProcess.spawn=function(this:unknown,...args:Parameters<typeof childProcess.spawn>){const child=Reflect.apply(original,this,args),entry={child,args:Array.isArray(args[1])?[...args[1]]:[],closed:false};children.push(entry);maximum=Math.max(maximum,++active);child.once('close',()=>{entry.closed=true;active--;});return child;} as typeof childProcess.spawn;syncBuiltinESMExports();
  t.after(()=>{childProcess.spawn=original;syncBuiltinESMExports();});
  return {children,get maximum(){return maximum;},assertClosed(){assert.ok(children.length>0);assert.equal(active,0);for(const entry of children)assert.equal(entry.closed,true,`child ${entry.child.pid} must close before settling`);}};
}
async function readLoudness(file:string){const {stderr}=await ff(['-v','info','-i',file,'-af','loudnorm=I=-16:TP=-1:LRA=11:print_format=json','-f','null','-']);const data=JSON.parse(stderr.match(/\{\s*"input_i"[\s\S]*?\}/g)!.at(-1)!);return {integrated:Number(data.input_i),truePeak:Number(data.input_tp)};}
async function exportAudio(p:Project,name:string){const file=path.join(root,`${name}.wav`);await renderProject(p,{outputPath:file,width:160,height:90,fps:30,format:'wav',codec:'h264',encoder:'cpu',quality:'draft'},ctx);return readLoudness(file);}

test('loudness measures only the selected source range with speed/EQ/fades and matches a real WAV export',{timeout:60000},async t=>{
  const p=project(assets.tone,40),clip=p.clips[0];clip.in=6;clip.speed=1.5;clip.volume=.6;clip.fadeIn=.3;clip.fadeOut=.4;clip.sourceClipOffset=.1;clip.sourceClipDuration=2.2;clip.audioEQ=defaultEQ();clip.audioEQ.bands.forEach(b=>b.enabled=false);clip.audioEQ.bands[2]={type:'peaking',enabled:true,frequency:437,gain:6,q:1};
  const owned=ownChildren(t),events:Record<string,unknown>[]=[],before=JSON.stringify(p),ids=[clip.id],result=await measureSelectionLoudness(p,ids,{...ctx,diagnostics:event=>events.push(event)},()=>{},new AbortController().signal);
  owned.assertClosed();assert.ok(owned.maximum<=2);assert.equal(JSON.stringify(p),before);
  const decoder=owned.children.find(entry=>entry.args.includes('pcm_f32le'))!;assert.ok(decoder);assert.equal(decoder.args[decoder.args.indexOf('-ss')+1],'6');assert.equal(decoder.args[decoder.args.indexOf('-t')+1],'3');
  const start=events.find(event=>event.event==='loudness-start')!,end=events.find(event=>event.event==='loudness-end')!;assert.equal(start.firstFrame,40*48000);assert.equal(start.lastFrame,42*48000);assert.equal(end.inputFrames,2*48000);
  const isolated={...p,clips:[{...clip,start:0}]},reference=await exportAudio(isolated,'edited-before'),item=result.items[0];assert.ok(Math.abs(item.integrated!-reference.integrated)<.04);assert.ok(Math.abs(item.truePeak!-reference.truePeak)<.04);
  const matched=applyLoudnessResult(p,ids,loudnessSignature(p,ids),result),output=await exportAudio({...matched,clips:matched.clips.map(c=>({...c,start:0}))},'edited-after');
  assert.equal(item.limited,undefined);assert.ok(Math.abs(output.integrated+16)<.1,JSON.stringify(output));assert.ok(output.truePeak<=-1);owned.assertClosed();
  await fs.writeFile(path.join(root,'range-export.json'),JSON.stringify({result,reference,output,events},null,2));
});

test('curve speed uses native stretch and peak-limited clips retain headroom after real export',{timeout:60000},async t=>{
  const p=project(assets.peak,0,3),clip=p.clips[0];clip.in=.1;clip.speedCurve=[{position:0,speed:.75},{position:.5,speed:1.25},{position:1,speed:.75}];clip.fadeIn=.1;clip.fadeOut=.2;
  const owned=ownChildren(t),ids=[clip.id],result=await measureSelectionLoudness(p,ids,ctx,()=>{},new AbortController().signal);owned.assertClosed();assert.ok(owned.children.some(entry=>entry.child.spawnfile===ctx.audioStretch));assert.ok(owned.maximum<=3);
  const reference=await exportAudio(p,'curve-before'),item=result.items[0];assert.ok(Math.abs(item.integrated!-reference.integrated)<.05);assert.ok(Math.abs(item.truePeak!-reference.truePeak)<.05);assert.equal(item.limited,'peak');
  const output=await exportAudio(applyLoudnessResult(p,ids,loudnessSignature(p,ids),result),'curve-after');assert.ok(output.truePeak<=-1,JSON.stringify(output));assert.ok(output.integrated< -16.1);owned.assertClosed();
  await fs.writeFile(path.join(root,'curve-export.json'),JSON.stringify({result,reference,output},null,2));
});

test('silent, short, locked and muted clips remain unchanged; skipped clips launch no decoders',{timeout:30000},async t=>{
  const p=project(assets.silent);p.media.push(assets.tone);p.tracks.push({id:'locked',name:'Locked',type:'audio',muted:false,hidden:false,locked:true});
  p.clips.push({...newClip('audio-1',assets.tone,3),duration:.2},{...newClip('locked',assets.tone,4),duration:1},{...newClip('audio-1',assets.tone,5),duration:1,volume:0});
  const owned=ownChildren(t),ids=p.clips.map(c=>c.id),result=await measureSelectionLoudness(p,ids,ctx,()=>{},new AbortController().signal);assert.deepEqual(result.items.map(item=>item.skip),['silent','short','locked','muted']);assert.equal(owned.children.length,2);owned.assertClosed();assert.equal(applyLoudnessResult(p,ids,loudnessSignature(p,ids),result),p);
});

test('cancelling curve analysis waits for analyzer, decoder and stretcher close, then a fresh retry succeeds',{timeout:30000},async t=>{
  const p=project(assets.tone,0,8);p.clips[0].speedCurve=[{position:0,speed:.5},{position:1,speed:1}];const owned=ownChildren(t),control=new AbortController();let queued=false;
  await assert.rejects(measureSelectionLoudness(p,[p.clips[0].id],{...ctx,diagnostics:event=>{if(event.event==='audio-start'&&!queued){queued=true;setImmediate(()=>control.abort());}}},()=>{},control.signal),{name:'AbortError'});assert.ok(queued);owned.assertClosed();
  const before=owned.children.length;control.abort();await assert.rejects(measureSelectionLoudness(p,[p.clips[0].id],ctx,()=>{},control.signal),{name:'AbortError'});assert.equal(owned.children.length,before);
  p.clips[0].duration=1;const result=await measureSelectionLoudness(p,[p.clips[0].id],ctx,()=>{},new AbortController().signal);assert.equal(typeof result.items[0].volume,'number');owned.assertClosed();
});

test('decoder failure and a file changed after measurement reject the whole batch with no live children',{timeout:30000},async t=>{
  const broken=path.join(root,'broken.wav');await fs.writeFile(broken,'invalid audio');const p=project({...assets.tone,path:broken,sourceRevision:undefined}),owned=ownChildren(t);
  await assert.rejects(measureSelectionLoudness(p,[p.clips[0].id],ctx,()=>{},new AbortController().signal),/오디오|음량/);owned.assertClosed();
  const copy=path.join(root,'mutable.wav');await fs.copyFile(assets.tone.path,copy);const asset=await probeMedia(copy,ctx,undefined,{derivatives:false}),next=project(asset);let changed=false;
  await assert.rejects(measureSelectionLoudness(next,[next.clips[0].id],ctx,fraction=>{if(fraction===1&&!changed){changed=true;const future=new Date(Date.now()+60000);utimesSync(copy,future,future);}},new AbortController().signal),/원본 파일이 변경/);assert.ok(changed);owned.assertClosed();
});
