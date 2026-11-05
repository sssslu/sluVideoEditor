import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {newClip,newProject,clipEnvelope} from '../shared/project';
import {compileTransitions,transitionGain} from '../shared/transitions';
import {clipSourceTime,clipTimelineTime} from '../shared/speed';
import {TimelineAudioMixer} from '../electron/render-audio';
import {CurveAudioSource} from '../electron/render-speed-audio';
import {probeMedia,runProcess,type EngineContext} from '../electron/media';

const root=path.resolve('.test-artifacts/transitions/audio'),rate=48000;
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),audioStretch:path.resolve('resources/bin/slu-audio-stretch.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args]);
const hash=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
async function mix(project:ReturnType<typeof newProject>,block:number){const control=new AbortController(),events:unknown[]=[],mixer=new TimelineAudioMixer(project,ctx.ffmpeg,control.signal,event=>events.push(event),ctx.audioStretch),parts:Buffer[]=[];try{for(let at=0;at<4*rate;at+=block)parts.push(await mixer.mix(at,Math.min(block,4*rate-at)));return {pcm:Buffer.concat(parts),events,peak:mixer.peakActiveSources};}finally{await mixer.close();}}

test('linear/equal-power/none transition audio follows original fade clocks, exact sample weights and continuous decoders',{timeout:60000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const file=path.join(root,'dc.mkv');await ff(['-f','lavfi','-i','color=black:s=32x18:r=30:d=6','-f','lavfi','-i','aevalsrc=0.2|0.4:s=48000:d=6','-c:v','libx264','-preset','ultrafast','-c:a','pcm_f32le',file]);
  const media=await probeMedia(file,ctx,undefined,{derivatives:false});media.videoStart=0;media.videoEnd=6;const p=newProject();p.width=160;p.height=90;p.media=[media];const a=newClip('video-1',media);a.in=1;a.duration=2;a.volume=.5;a.fadeOut=2.7;a.sourceClipOffset=.3;a.sourceClipDuration=3;const b=newClip('video-1',media,2);b.in=2;b.duration=2;b.volume=.75;b.fadeIn=2;b.sourceClipOffset=.6;b.sourceClipDuration=3;p.clips=[a,b];const stored=JSON.stringify(p.clips),reports=[];
  for(const audio of ['linear','equal-power','none'] as const){p.transitions=[{id:'pair',fromClipId:a.id,toClipId:b.id,kind:'dissolve',durationFrames:30,easing:'ease-in-out',audio}];const plan=compileTransitions(p),one=await mix(p,4096),other=await mix(p,777);assert.equal(hash(one.pcm),hash(other.pcm));let maxError=0;
    for(let frame=0;frame<4*rate;frame++){const time=frame/rate;let expected=0;for(const clip of p.clips){const bounds=plan.byClip.get(clip.id)!;if(time<clip.start+bounds.audioFrom||time>=clip.start+bounds.audioTo)continue;const env=clipEnvelope(clip,time-clip.start),fade=Math.min(1,clip.fadeIn?Math.max(0,env.time/clip.fadeIn):1,clip.fadeOut?Math.max(0,(env.duration-env.time)/clip.fadeOut):1);expected+=Math.fround(.2)*clip.volume*fade*transitionGain(plan,clip.id,time);}maxError=Math.max(maxError,Math.abs(one.pcm.readFloatLE(frame*8)-expected));}
    assert.ok(maxError<5e-8,`${audio}: ${maxError}`);assert.equal(one.pcm.length,4*rate*8);assert.equal(one.events.filter((e:any)=>e.event==='audio-start').length,2);assert.equal(JSON.stringify(p.clips),stored);reports.push({audio,samples:4*rate,maximumSampleError:maxError,blockSizeDifferences:0,decoderStarts:2,peakDecoders:one.peak});
  }
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify(reports,null,2));t.diagnostic(JSON.stringify(reports));
});

test('native64-point curve extends original endpoint rates without reparameterizing and cancels both children',{timeout:60000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const p=newProject(),c=newClip('video-1');c.in=1;c.duration=2;c.speedCurve=Array.from({length:64},(_,i)=>({position:i/63,speed:1+.2*Math.sin(i/63*Math.PI*2)}));
  const range={from:-.5,to:2.5},marks=[-.3,.3,1.3,2.3],sourceMarks=marks.map(time=>clipSourceTime(c,time)),frames=5*rate,raw=Buffer.alloc(frames*8);
  for(let i=0;i<frames;i++){const time=i/rate;raw.writeFloatLE(.2*Math.sin(2*Math.PI*437*time),i*8);raw.writeFloatLE(sourceMarks.some(mark=>time>=mark&&time<mark+.03)?.6*Math.sin(2*Math.PI*3000*time):0,i*8+4);}
  const file=path.join(root,'curve.wav'),input=path.join(root,'curve.f32');await fs.writeFile(input,raw);await ff(['-f','f32le','-ar','48000','-ac','2','-i',input,'-c:a','pcm_f32le',file]);const media=await probeMedia(file,ctx,undefined,{derivatives:false});c.mediaId=media.id;p.media=[media];p.clips=[c];
  const render=async(block:number)=>{const control=new AbortController(),source=new CurveAudioSource(ctx.ffmpeg,ctx.audioStretch!,c,media,control.signal,undefined,range),parts:Buffer[]=[];try{for(let at=0;at<3*rate;at+=block)parts.push(await source.read(Math.min(block,3*rate-at)));return Buffer.concat(parts);}finally{await source.close();}};
  const pcm=await render(4096),other=await render(997);assert.equal(hash(pcm),hash(other));const landmarks=marks.map((mark,i)=>{const expected=clipTimelineTime(c,sourceMarks[i]+.015)-range.from;let energy=0,moment=0;for(let frame=Math.floor((expected-.12)*rate);frame<Math.ceil((expected+.12)*rate);frame++){const value=pcm.readFloatLE(frame*8+4)**2;energy+=value;moment+=value*frame/rate;}assert.ok(energy>.01);return {expected,actual:moment/energy,error:moment/energy-expected};});assert.ok(landmarks.every(mark=>Math.abs(mark.error)<1/60),JSON.stringify(landmarks));
  const control=new AbortController(),active=new Set<number>();const source=new CurveAudioSource(ctx.ffmpeg,ctx.audioStretch!,c,media,control.signal,event=>{if(event.pid){if(event.event==='audio-start')active.add(event.pid);if(event.event==='audio-end')active.delete(event.pid);}},range);const pending=source.read(3*rate);control.abort();await assert.rejects(pending,{name:'AbortError'});await source.close();assert.equal(active.size,0);
  const result={helperSHA256:hash(await fs.readFile(ctx.audioStretch!)),pointCount:64,range,samples:pcm.length/8,blockSizeDifferences:0,landmarks,cancellationSurvivors:active.size};await fs.writeFile(path.join(root,'curve-results.json'),JSON.stringify(result,null,2));t.diagnostic(JSON.stringify(result));
});
