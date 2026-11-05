import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {newClip,newProject,splitClip} from '../shared/project';
import {defaultEQ} from '../shared/audio-eq';
import {assertProject} from '../shared/validation';
import {TimelineAudioMixer} from '../electron/render-audio';
import {probeMedia,runProcess} from '../electron/media';
import type {Clip} from '../shared/types';

// The separately tested source mixer is an oracle for the installed ASAR's
// IPC/export path. This is packaging/integration evidence, not an independent
// proof of the DSP equations (FFmpeg/WebAudio parity tests cover those).
const root=path.resolve('.test-artifacts/packaged-audio'),rate=48000,frames=rate*6;
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),audioStretch:path.resolve('resources/bin/slu-audio-stretch.exe')};
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
await fs.mkdir(root,{recursive:true});
const input=path.join(root,'tones.mkv');
await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=160x90:rate=30:duration=8','-f','lavfi','-i','aevalsrc=0.03*sin(2*PI*20*t)+0.04*sin(2*PI*437*t)+0.02*sin(2*PI*4500*t)|0.03*sin(2*PI*900*t)+0.02*sin(2*PI*13000*t):s=48000:d=8','-c:v','libx264','-preset','ultrafast','-c:a','pcm_f32le',input]);
const media=await probeMedia(input,ctx,undefined,{derivatives:false}),base=newProject();base.width=320;base.height=180;base.media=[media];
const eq=defaultEQ();eq.output=-1.5;eq.bands=[
  {enabled:true,type:'highpass',frequency:35,gain:0,q:.7},
  {enabled:true,type:'lowshelf',frequency:120,gain:3,q:.7},
  {enabled:true,type:'peaking',frequency:437,gain:12,q:3},
  {enabled:true,type:'peaking',frequency:2500,gain:-4,q:1.4},
  {enabled:true,type:'highshelf',frequency:8000,gain:2,q:.7},
  {enabled:true,type:'lowpass',frequency:16000,gain:0,q:.7}
];
const clip:Clip={...newClip('video-1',media),id:'audio-export-original',in:.4,duration:6,volume:.8,fadeIn:.2,fadeOut:.4};
const filtered={...clip,audioEQ:eq},curve={...filtered,speedCurve:[{position:0,speed:.7},{position:.35,speed:1.3},{position:1,speed:.8}]};
function pieces(c:Clip){const [a,rest]=splitClip(c,2)!;return [a,...splitClip(rest,4)!];}
const changed=pieces(filtered).map((c,i)=>i===1?{...c,audioEQ:{...eq,bands:eq.bands.map((b,j)=>j===2?{...b,gain:-6}:b)}}:c);
const cases:[string,Clip[]][]=[['flat',[clip]],['eq-single',[filtered]],['eq-split',pieces(filtered)],['curve-single',[curve]],['curve-split',pieces(curve)],['changed-middle',changed]];
interface ReferenceCase {name:string;projectFile:string;projectSha256:string;pcmFile:string;pcmSha256:string;frames:number;peak:number;decoderCount:number}
const reports:ReferenceCase[]=[];
for(const [name,clips] of cases){
  const project={...base,id:`packaged-audio-${name}`,name,clips};assertProject(project);
  const events:any[]=[],mixer=new TimelineAudioMixer(project,ctx.ffmpeg,new AbortController().signal,e=>events.push(e),ctx.audioStretch),blocks:Buffer[]=[];
  try{for(let at=0;at<frames;at+=4096)blocks.push(await mixer.mix(at,Math.min(4096,frames-at)));}finally{await mixer.close();}
  const pcm=Buffer.concat(blocks);assert.equal(pcm.length,frames*8);let peak=0;for(let i=0;i<pcm.length;i+=4){const value=pcm.readFloatLE(i);assert.ok(Number.isFinite(value));peak=Math.max(peak,Math.abs(value));}assert.ok(peak>.01&&peak<.9);
  const projectFile=path.join(root,`${name}.sluproj`),pcmFile=path.join(root,`${name}-expected.f32`);await fs.writeFile(projectFile,JSON.stringify(project,null,2));await fs.writeFile(pcmFile,pcm);
  reports.push({name,projectFile,projectSha256:digest(await fs.readFile(projectFile)),pcmFile,pcmSha256:digest(pcm),frames,peak,decoderCount:events.filter(e=>e.event==='audio-start'&&e.role!=='stretch').length});
}
const splitComparisons=[];
for(const prefix of ['eq','curve']){
  const a=reports.find(r=>r.name===`${prefix}-single`)!,b=reports.find(r=>r.name===`${prefix}-split`)!;assert.equal(b.decoderCount,1);
  const before=await fs.readFile(a.pcmFile),after=await fs.readFile(b.pcmFile);let max=0,different=0;
  for(let i=0;i<before.length;i+=4){const delta=Math.abs(before.readFloatLE(i)-after.readFloatLE(i));max=Math.max(max,delta);if(delta)different++;}
  // Reconstructing normalized curve points can round a double by one ULP;
  // preserve a strict float32-error bound instead of claiming bit identity.
  assert.ok(max<=(prefix==='eq'?0:2e-7),`${prefix} split difference ${max}`);splitComparisons.push({prefix,maximumSampleDifference:max,differentSamples:different});
}
const sourceHashes:Record<string,string>={};for(const file of ['scripts/prepare-packaged-audio.ts','electron/render-audio.ts','electron/media.ts','shared/audio-eq.ts','shared/audio-continuity.ts','shared/speed.ts','resources/bin/ffmpeg.exe','resources/bin/slu-audio-stretch.exe'])sourceHashes[file]=digest(await fs.readFile(file));
await fs.writeFile(path.join(root,'oracle.json'),JSON.stringify({version:JSON.parse(await fs.readFile('package.json','utf8')).version,recordedAt:new Date().toISOString(),source:input,sourceSha256:digest(await fs.readFile(input)),sourceHashes,reports,splitComparisons},null,2));
console.log(JSON.stringify(reports.map(({name,frames,peak,decoderCount})=>({name,frames,peak,decoderCount})),null,2));
