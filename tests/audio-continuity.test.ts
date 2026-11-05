import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {continuousAudioGroups} from '../shared/audio-continuity';
import {newProject,newClip,splitClip} from '../shared/project';
import {defaultEQ} from '../shared/audio-eq';
import {clipSourceTime} from '../shared/speed';
import {TimelineAudioMixer} from '../electron/render-audio';
import {probeMedia,runProcess} from '../electron/media';
import type {Clip} from '../shared/types';
import {PreviewAudioPlan} from '../src/preview/audio-plan';
import {planMedia} from '../src/preview/math';
import {compileTransitions} from '../shared/transitions';
const root=path.resolve('.test-artifacts/audio-eq/continuity'),rate=48000,ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),audioStretch:path.resolve('resources/bin/slu-audio-stretch.exe')};
const eq=defaultEQ();eq.bands.forEach(b=>b.enabled=false);eq.bands[2]={type:'peaking',enabled:true,frequency:20,gain:18,q:10};
function fixture(){const c=newClip('audio-1');delete c.text;c.mediaId='audio';return {...c,duration:3,in:.4,audioEQ:eq};}
function pieces(c:Clip){const [a,rest]=splitClip(c,1.137)!;return [a,...splitClip(rest,2.177)!];}
test('Only consecutive untouched EQ splits rejoin; source/effect/track/gap/transition boundaries remain independent',()=>{
  const original=fixture(),clips=pieces(original),saved=JSON.stringify(clips),groups=continuousAudioGroups(clips,new Set());assert.equal(groups.length,1);assert.equal(groups[0].members.length,3);assert.equal(groups[0].clip.duration,3);assert.equal(JSON.stringify(clips),saved);
  for(const change of [{in:2},{start:1.2},{volume:.5},{fadeIn:.3},{trackId:'different'},{mediaId:'other'},{sourceClipDuration:4},{audioEQ:{...eq,output:-2}}]){const altered=clips.map((c,i)=>i===1?{...c,...change}:c);assert.equal(continuousAudioGroups(altered,new Set()).length,3,JSON.stringify(change));}
  assert.equal(continuousAudioGroups(clips,new Set([clips[1].id])).length,3);
  assert.equal(continuousAudioGroups(clips.map(c=>({...c,audioEQ:undefined})),new Set()).length,3);
});
test('Rejoining split nonlinear speed curves reconstructs the original source clock without retaining redundant cut points',()=>{
  const original={...fixture(),speedCurve:[{position:0,speed:.7},{position:.35,speed:1.4},{position:1,speed:.8}]},group=continuousAudioGroups(pieces(original),new Set());assert.equal(group.length,1);assert.equal(group[0].clip.speedCurve?.length,3);
  for(let t=0;t<=3;t+=.013)assert.ok(Math.abs(clipSourceTime(group[0].clip,t)-clipSourceTime(original,t))<1e-12);
});
test('Preview planning keeps visual identities, one audio voice, stable companion IDs and original mute/solo rules',()=>{
  const p=newProject(),media={id:'audio',path:'tone.mkv',name:'tone',kind:'video' as const,duration:4,width:160,height:90,fps:30,hasAudio:true};p.media=[media];p.clips=pieces({...fixture(),trackId:'video-1'});const transitions=compileTransitions(p),planner=new PreviewAudioPlan(p,transitions);let audioId:string|undefined;
  for(const time of [.2,1.5,2.7]){const planned=planner.apply(planMedia(p,time,32,1.2,transitions).media,time),audio=planned.filter(n=>n.audioOnly),visual=planned.filter(n=>!n.audioOnly);assert.equal(audio.length,1);assert.ok(visual.every(n=>n.suppressAudio));assert.equal(audio[0].track,p.tracks[0]);audioId??=audio[0].clip.id;assert.equal(audio[0].clip.id,audioId);assert.ok(!p.clips.some(c=>c.id===audioId));}
  const muted={...p,tracks:p.tracks.map(t=>t.type==='video'?{...t,muted:true}:t)},mp=compileTransitions(muted);assert.ok(new PreviewAudioPlan(muted,mp).apply(planMedia(muted,1).media,1).every(n=>!n.audioOnly&&!n.suppressAudio));
  const audioProject={...p,clips:p.clips.map(c=>({...c,trackId:'audio-1'}))},ap=compileTransitions(audioProject);const nodes=new PreviewAudioPlan(audioProject,ap).apply(planMedia(audioProject,1.5).media,1.5);assert.equal(nodes.length,1);assert.equal(nodes[0].clip.id,p.clips[0].id);assert.equal(nodes[0].audioOnly,true);
  const other={...p,tracks:p.tracks.map(t=>t.type==='audio'?{...t,solo:true}:t)},op=compileTransitions(other);assert.ok(new PreviewAudioPlan(other,op).apply(planMedia(other,1).media,1).every(n=>!n.audioOnly&&!n.suppressAudio));
});
test('Actual continuous EQ export is unchanged by two editorial splits, including partial output and nonlinear speed',{timeout:30000},async t=>{
  await fs.mkdir(root,{recursive:true});const input=path.join(root,'tones.wav');await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','aevalsrc=0.03*sin(2*PI*20*t)+0.04*sin(2*PI*437*t)|0.02*sin(2*PI*900*t):s=48000:d=4','-c:a','pcm_f32le',input]);const media=await probeMedia(input,ctx,undefined,{derivatives:false}),base=newProject();base.media=[media];const reports=[];
  const mix=async(clips:Clip[],from=0)=>{const events:unknown[]=[],mixer=new TimelineAudioMixer({...base,clips},ctx.ffmpeg,new AbortController().signal,e=>events.push(e),ctx.audioStretch),parts:Buffer[]=[];try{for(let at=from;at<3*rate;at+=997)parts.push(await mixer.mix(at,Math.min(997,3*rate-at)));return {pcm:Buffer.concat(parts),events};}finally{await mixer.close();}};
  for(const curve of [false,true]){const original:Clip={...fixture(),mediaId:media.id,volume:.7,fadeIn:.2,fadeOut:.6,speedCurve:curve?[{position:0,speed:.7},{position:.35,speed:1.4},{position:1,speed:.8}]:undefined};const full=await mix([original]),split=await mix(pieces(original)),partial=await mix(pieces(original),77777);assert.deepEqual(split.pcm,full.pcm);assert.deepEqual(partial.pcm,full.pcm.subarray(77777*8));const decoders=split.events.filter((e:any)=>e.event==='audio-start'&&e.role!=='stretch').length;assert.equal(decoders,1);reports.push({curve,frames:full.pcm.length/8,splits:2,sampleDifferences:0,partialDifferences:0,decoders});}
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify(reports,null,2));t.diagnostic(JSON.stringify(reports));
});
