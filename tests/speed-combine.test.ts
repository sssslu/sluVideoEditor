import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newClip} from '../shared/project';
import {assertProject} from '../shared/validation';
import {clipMediaIds} from '../shared/processing';
import {planCombination,combinationProject,applyCombination,uncombineClip} from '../shared/combine';
import {speedPercent,MAX_SPEED} from '../shared/speed';
import {changeClipSpeed,commonSpeed,scaleSelectionSpeed,placeDroppedMedia} from '../src/editor';
import type {Clip,MediaAsset,Project} from '../shared/types';

const video:MediaAsset={id:'video',path:'C:/v.mp4',name:'v',kind:'video',width:1920,height:1080,duration:60,fps:30,hasAudio:true,videoStart:0,videoEnd:60};
const sound:MediaAsset={id:'sound',path:'C:/s.wav',name:'s',kind:'audio',width:0,height:0,duration:20,fps:0,hasAudio:true};
const still:MediaAsset={id:'still',path:'C:/i.png',name:'i',kind:'image',width:640,height:360,duration:0,fps:0,hasAudio:false};

function sample():Project{
  const p=newProject();p.media=[video,sound,still];
  const a={...newClip('video-1',video,2),id:'a',duration:4,keyframes:[{time:2,x:10,y:0,scale:1,opacity:1,rotation:0}],fadeOut:1};
  const b={...newClip('video-1',video,6),id:'b',in:10,duration:4};
  const music={...newClip('audio-1',sound,2),id:'music',duration:8};
  const title={...newClip('text-1',undefined,3),id:'title',text:'제목',duration:6};
  const after={...newClip('video-1',video,20),id:'after',duration:2};
  p.clips=[a,b,music,title,after];
  p.transitions=[{id:'t',fromClipId:'a',toClipId:'b',kind:'dissolve',durationFrames:12}];
  return p;
}

test('constant speed spans 10% to 9999% and shows as a percentage',()=>{
  const clip={...newClip('video-1',video),duration:50};
  assert.equal(changeClipSpeed(clip,MAX_SPEED,30).speed,99.99);
  assert.ok(Math.abs(changeClipSpeed(clip,MAX_SPEED,30).duration-50/99.99)<1e-9);
  assert.throws(()=>changeClipSpeed(clip,100,30),/10~9999%/);
  assert.throws(()=>changeClipSpeed(clip,.09,30),/10~9999%/);
  assert.equal(speedPercent(2),'200%');assert.equal(speedPercent(1/3),'33.33%');assert.equal(speedPercent(.5),'50%');
});

test('a selection speeds up as one block: rates, gaps, text and transitions scale together',()=>{
  const p=sample(),ids=['a','b','music','title'];
  assert.equal(commonSpeed(p.clips.filter(c=>ids.includes(c.id)),p.media),1);
  const next=scaleSelectionSpeed(p,ids,2,30),by=(id:string)=>next.clips.find(c=>c.id===id)!;
  assert.deepEqual([by('a').start,by('a').duration,by('a').speed],[2,2,2]);
  assert.deepEqual([by('b').start,by('b').duration,by('b').speed,by('b').in],[4,2,2,10]);
  assert.equal(by('a').start+by('a').duration,by('b').start,'adjacent clips stay adjacent');
  assert.deepEqual([by('music').start,by('music').duration,by('music').speed],[2,4,2]);
  assert.deepEqual([by('title').start,by('title').duration,by('title').speed],[2.5,3,1],'text has no rate; it only shrinks');
  assert.equal(by('a').keyframes[0].time,1);assert.equal(by('a').fadeOut,.5);
  assert.equal(next.transitions![0].durationFrames,6);
  assert.deepEqual(by('after'),p.clips.find(c=>c.id==='after'),'unselected clips stay put');
  assert.equal(commonSpeed(next.clips.filter(c=>ids.includes(c.id)),next.media),2);
  // Half speed restores the original timing.
  const back=scaleSelectionSpeed(next,ids,.5,30);
  for(const id of ids){const x=back.clips.find(c=>c.id===id)!,o=p.clips.find(c=>c.id===id)!;assert.ok(Math.abs(x.start-o.start)<1e-9&&Math.abs(x.duration-o.duration)<1e-9&&x.speed===o.speed,id);}
  assertProject(next);
});

test('selection speed reports mixed rates and refuses rates out of range',()=>{
  const p=sample();p.clips=p.clips.map(c=>c.id==='b'?{...c,speed:50,duration:.2}:c);
  assert.equal(commonSpeed(p.clips,p.media),undefined);
  assert.throws(()=>scaleSelectionSpeed(p,['a','b'],3,30),/10~9999%/);
  p.clips=p.clips.map(c=>c.id==='a'?{...c,speedCurve:[{position:0,speed:1},{position:1,speed:10}]}:c);
  assert.throws(()=>scaleSelectionSpeed(p,['a'],2,30),/커브/);
  assert.equal(scaleSelectionSpeed(p,['a'],1.5,30).clips.find(c=>c.id==='a')!.speedCurve![1].speed,15);
});

test('files dropped on a track are placed from the drop point, other kinds on a matching track',()=>{
  const p=newProject(),second={...video,id:'video2',path:'C:/w.mp4',duration:3};
  const {project,clips}=placeDroppedMedia(p,[video,sound,second],'video-1',5);
  assert.deepEqual(clips.map(c=>[c.trackId,c.start,c.mediaId]),[['video-1',5,'video'],['audio-1',5,'sound'],['video-1',65,'video2']]);
  assert.equal(project.clips.length,3);
  const onText=placeDroppedMedia(p,[still],'text-1',1);
  assert.deepEqual(onText.clips.map(c=>[c.trackId,c.start,c.duration]),[['video-1',1,5]]);
  const noAudio={...p,tracks:p.tracks.filter(t=>t.type!=='audio')},made=placeDroppedMedia(noAudio,[sound],'video-1',0);
  assert.equal(made.project.tracks.length,3);assert.equal(made.project.tracks[2].type,'audio');
});

test('combining renders the selection alone and uncombining restores it where the clip now sits',()=>{
  const p=sample(),ids=['a','b','title'],plan=planCombination(p,ids);
  assert.deepEqual([plan.start,plan.end,plan.visual,plan.audio],[2,10,true,true]);
  const input=combinationProject(p,ids);
  assert.deepEqual(input.clips.map(c=>[c.id,c.start]),[['a',0],['b',4],['title',1]]);
  assert.deepEqual(input.tracks.map(t=>t.id),['video-1','text-1']);
  assert.equal(input.transitions!.length,1);assert.deepEqual(input.media.map(m=>m.id),['video']);
  assertProject(input);
  const rendered:MediaAsset={id:'combined',path:'C:/combined.mov',name:'합친 클립 · 3개',kind:'video',width:1920,height:1080,duration:8,fps:30,hasAudio:true,hasAlpha:true,codec:'ffv1'};
  const snapshot=structuredClone(p.clips.filter(c=>ids.includes(c.id)));
  const {project,clip}=applyCombination(p,plan,snapshot,rendered);
  // Only an audio track lies between the selected text and video tracks, so the video track is reused.
  assert.equal(clip.trackId,'video-1');
  // An unselected picture between them would be covered: the result then goes on a new top track.
  const layered={...p,tracks:[p.tracks[0],{id:'video-2',name:'V2',type:'video' as const,muted:false,hidden:false,locked:false},...p.tracks.slice(1)],clips:[...p.clips,{...newClip('video-2',still,3),id:'logo',duration:2}]};
  const onTop=applyCombination(layered,planCombination(layered,ids),structuredClone(layered.clips.filter(c=>ids.includes(c.id))),rendered);
  assert.equal(onTop.project.tracks.findIndex(t=>t.id===onTop.clip.trackId),4);assert.equal(onTop.project.tracks[4].name,'합친 클립');
  assert.deepEqual([clip.start,clip.duration,clip.mediaId],[2,8,'combined']);
  assert.deepEqual(project.clips.map(c=>c.id).sort(),['after',clip.id,'music'].sort());
  assert.equal(project.transitions!.length,0);
  assertProject(project);
  assert.ok(clipMediaIds(clip).includes('video'),'originals keep their media in use');
  // Move the combined clip by 10 s, then uncombine.
  const moved={...project,clips:project.clips.map(c=>c.id===clip.id?{...c,start:12}:c)};
  const restored=uncombineClip(moved,clip.id),by=(id:string)=>restored.project.clips.find(c=>c.id===id)!;
  assert.deepEqual(restored.ids.sort(),ids.slice().sort());
  assert.deepEqual([by('a').start,by('b').start,by('title').start],[12,16,13]);
  assert.deepEqual({...by('b'),start:6},p.clips.find(c=>c.id==='b'));
  assert.equal(restored.project.transitions!.length,1);
  assert.ok(!restored.project.clips.some(c=>c.id===clip.id));
  assertProject(restored.project);
});

test('combining checks the selection and a duplicated combined clip restores with fresh ids',()=>{
  const p=sample();
  assert.throws(()=>planCombination(p,[]),/선택/);
  const locked={...p,tracks:p.tracks.map(t=>t.id==='video-1'?{...t,locked:true}:t)};
  assert.throws(()=>planCombination(locked,['a']),/잠긴/);
  const muted={...p,tracks:p.tracks.map(t=>t.id==='audio-1'?{...t,muted:true}:t)};
  assert.throws(()=>planCombination(muted,['music']),/보이거나 들리는/);
  const plan=planCombination(p,['a','b']),rendered:MediaAsset={id:'c2',path:'C:/c2.mov',name:'c',kind:'video',width:1920,height:1080,duration:8,fps:30,hasAudio:true};
  const combined=applyCombination(p,plan,structuredClone(p.clips.filter(c=>plan.ids.includes(c.id))),rendered);
  assert.equal(combined.clip.trackId,'video-1','the selected track is free over the span, so it is reused');
  assert.throws(()=>applyCombination({...p,clips:p.clips.map(c=>c.id==='a'?{...c,volume:.5}:c)},plan,structuredClone(p.clips.filter(c=>plan.ids.includes(c.id))),rendered),/바뀌었습니다/);
  // Uncombining the original and a duplicate gives the second set new ids.
  const copy:Clip={...structuredClone(combined.clip),id:'copy',start:30};
  let q={...combined.project,clips:[...combined.project.clips,copy]};
  q=uncombineClip(q,combined.clip.id).project;
  const second=uncombineClip(q,'copy');
  assert.equal(new Set(second.project.clips.map(c=>c.id)).size,second.project.clips.length);
  assert.ok(second.ids.every(id=>id!=='a'&&id!=='b'));
  assertProject(second.project);
});
