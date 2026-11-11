import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newClip,newProject,startingProject} from '../shared/project';
import {assertProject} from '../shared/validation';
import {settleOverlaps,pruneEmptiedTracks,finishClipMove} from '../src/timeline-model';
import {placeDroppedMedia} from '../src/editor';
import {layered,type VisualRenderNode} from '../src/preview/renderer';
import {probeMedia,renderProject,runProcess,type EngineContext} from '../electron/media';
import type {Clip,MediaAsset,Project,Track} from '../shared/types';

const video:MediaAsset={id:'video',path:'C:/v.mp4',name:'v',kind:'video',width:1920,height:1080,duration:60,fps:30,hasAudio:true};
const sound:MediaAsset={id:'sound',path:'C:/s.wav',name:'s',kind:'audio',width:0,height:0,duration:20,fps:0,hasAudio:true};
const track=(id:string,type:Track['type'],extra:Partial<Track>={}):Track=>({id,name:id,type,muted:false,hidden:false,locked:false,...extra});
const clip=(id:string,trackId:string,start:number,duration=4,media:MediaAsset=video):Clip=>({...newClip(trackId,media,start),id,duration});
const ids=(p:Project)=>p.tracks.map(t=>`${t.type}:${p.clips.filter(c=>c.trackId===t.id).map(c=>c.id).join('+')}`);

test('a new editor project starts with a single picture track',()=>{
  const p=startingProject();assert.deepEqual(p.tracks.map(t=>t.type),['video']);assertProject(p);
});

test('clips placed over others go to the next free track up, newest on top',()=>{
  let p:Project={...newProject(),media:[video,sound],tracks:[track('main','video')],clips:[clip('a','main',0)]};
  p=settleOverlaps({...p,clips:[...p.clips,clip('b','main',1)]},['b']);
  p=settleOverlaps({...p,clips:[...p.clips,clip('c','main',2)]},['c']);
  assert.deepEqual(ids(p),['video:a','video:b','video:c'],'three tracks, the last placed on top');
  p=settleOverlaps({...p,clips:[...p.clips,clip('e','main',30)]},['e']);
  assert.equal(p.clips.find(c=>c.id==='e')!.trackId,'main','no overlap, no move');
  assertProject(p);
  // A track above that is free over the clip is reused instead of adding another.
  let q:Project={...newProject(),media:[video],tracks:[track('main','video'),track('over','video')],clips:[clip('a','main',0),clip('b','over',10)]};
  q=settleOverlaps({...q,clips:[...q.clips,clip('x','main',1)]},['x']);
  assert.deepEqual(ids(q),['video:a','video:b+x']);
});

test('a new picture track goes below text above it; audio stacks downward; locked tracks are skipped',()=>{
  let p:Project={...newProject(),media:[video,sound],tracks:[track('main','video'),track('title','text'),track('music','audio'),track('locked','video',{locked:true})],clips:[clip('a','main',0),{...newClip('title',undefined,0),id:'t',text:'T',duration:4},clip('m','music',0,4,sound)]};
  p=settleOverlaps({...p,clips:[...p.clips,clip('b','main',1)]},['b']);
  assert.deepEqual(p.tracks.map(t=>t.type),['video','video','text','audio','video'],'the new picture track sits right above main, under the text');
  p=settleOverlaps({...p,clips:[...p.clips,clip('m2','music',2,4,sound)]},['m2']);
  assert.equal(p.tracks[p.tracks.findIndex(t=>t.id==='music')+1].type,'audio');
  assert.equal(p.clips.find(c=>c.id==='m2')!.trackId,p.tracks[p.tracks.findIndex(t=>t.id==='music')+1].id);
});

test('dropping files on an occupied spot uses a track of their own',()=>{
  const p:Project={...startingProject(),media:[video,sound],clips:[clip('a','video-1',0)]};
  const {project,clips}=placeDroppedMedia(p,[video,video],'video-1',2);
  assert.equal(project.tracks.length,2);assert.ok(clips.every(c=>c.trackId===project.tracks[1].id));
  assert.deepEqual(clips.map(c=>c.start),[2,62]);
});

test('tracks emptied by an edit go away, empty ones and the last picture track stay',()=>{
  const before:Project={...newProject(),tracks:[track('main','video'),track('over','video'),track('spare','video'),track('music','audio')],media:[video,sound],clips:[clip('a','main',0),clip('b','over',0),clip('m','music',0,4,sound)]};
  const after=pruneEmptiedTracks(before,{...before,clips:before.clips.filter(c=>c.id!=='b'&&c.id!=='m')});
  assert.deepEqual(after.tracks.map(t=>t.id),['main','spare']);
  const all=pruneEmptiedTracks(before,{...before,tracks:[track('main','video'),track('music','audio')],clips:[]});
  assert.deepEqual(all.tracks.map(t=>t.id),['main']);
});

test('dragging above or below every track makes a new top or bottom track',()=>{
  const before:Project={...startingProject(),media:[video],clips:[clip('a','video-1',0),clip('b','video-1',5)]};
  const top=finishClipMove(before,before,['b'],'top');
  assert.deepEqual(ids(top),['video:a','video:b']);
  const bottom=finishClipMove(before,before,['b'],'bottom');
  assert.deepEqual(ids(bottom),['video:b','video:a'],'the new track is the lowest layer');
  // A clip dragged onto an occupied spot gets a new track right above the one it was dropped on.
  const three:Project={...newProject(),media:[video],tracks:[track('t1','video'),track('t2','video'),track('t3','video')],clips:[clip('g','t1',0),clip('b','t2',0),clip('r','t3',0)]};
  const dragged=finishClipMove(three,{...three,clips:three.clips.map(c=>c.id==='g'?{...c,trackId:'t2'}:c)},['g'],null);
  assert.deepEqual(ids(dragged),['video:b','video:g','video:r']);
  // Moving a track's only clip to the top replaces that track.
  const alone=finishClipMove(top,top,['b'],'top');
  assert.equal(alone.tracks.length,2);assert.deepEqual(ids(alone),['video:a','video:b']);
});

test('preview draws a text between the picture tracks around it',()=>{
  const p:Project={...newProject(),tracks:[track('low','video'),track('title','text'),track('high','video'),track('top','text')]};
  const node=(id:string,trackId:string):VisualRenderNode=>({clip:{...clip(id,trackId,0)},frame:{key:id,source:{} as HTMLCanvasElement,width:1,height:1,version:1}});
  const texts=[{...newClip('title'),id:'t1'},{...newClip('top'),id:'t2'}];
  const order=layered(p,[node('v1','low'),node('v2','high')],texts).map(item=>'text' in item?item.text.id:(item.visual as {clip:Clip}).clip.id);
  assert.deepEqual(order,['v1','t1','v2','t2']);
});

const root=path.resolve('.test-artifacts/track-layers');
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{maxOutputBytes:64*1024*1024});
const frame=async(file:string)=>(await ff(['-i',file,'-vf','select=eq(n\\,10)','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'])).stdout;

test('export covers a text with the picture track above it',{timeout:240000},async()=>{
  await fs.mkdir(root,{recursive:true});
  const pattern=path.join(root,'pattern.mp4'),blue=path.join(root,'blue.mp4');
  await ff(['-f','lavfi','-i','testsrc2=s=320x180:r=30:d=1','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',pattern]);
  await ff(['-f','lavfi','-i','color=c=0x2050c0:s=320x180:r=30:d=1','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',blue]);
  const low=await probeMedia(pattern,ctx),high=await probeMedia(blue,ctx);
  const base=(tracks:Track[]):Project=>({...newProject(),width:320,height:180,fps:30,media:[low,high],tracks,clips:[{...newClip('low',low),id:'l',duration:1},{...newClip('high',high),id:'h',duration:1,scale:.5}]});
  const text:Clip={...newClip('title'),id:'t',text:'가려진 자막',duration:1,fontSize:40,y:0,textStyle:'box'};
  const render=async(p:Project,name:string)=>frame(await renderProject(p,{width:320,height:180,fps:30,format:'mov',codec:'h264',encoder:'cpu',quality:'high',outputPath:path.join(root,`${name}.mov`)},ctx));
  const under=[track('low','video'),track('title','text'),track('high','video')],over=[track('low','video'),track('high','video'),track('title','text')];
  const plain=await render(base(under),'plain'),covered=await render({...base(under),clips:[...base(under).clips,text]},'covered'),visible=await render({...base(over),clips:[...base(over).clips,text]},'visible');
  // Compare the centre, where the half-size blue picture sits over the caption.
  const centre=(raw:Buffer)=>{const out:number[]=[];for(let y=60;y<120;y++)for(let x=100;x<220;x++)out.push(...raw.subarray((y*320+x)*3,(y*320+x)*3+3));return out;};
  const differs=(a:number[],b:number[])=>a.reduce((n,v,i)=>n+(Math.abs(v-b[i])>8?1:0),0);
  assert.equal(differs(centre(covered),centre(plain)),0,'the caption under the blue track is hidden there');
  assert.ok(differs(centre(visible),centre(plain))>200,'a caption on the top track shows over the blue picture');
  assert.ok(differs([...covered],[...plain])>200,'outside the blue picture the caption still shows over the lower track');
});
