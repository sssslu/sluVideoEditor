import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newClip} from '../shared/project';
import type {MediaAsset,Track} from '../shared/types';
import {assertProject} from '../shared/validation';
import {attachMotion,bindingTime,reconcileMotion} from '../shared/motion';
import type {MotionAnalysis,MotionSample} from '../shared/tracking';
import {parseCube} from '../shared/color';
import {captureClipClipboard,pasteClipClipboard} from '../src/clip-clipboard';
import {pruneEmptiedTracks} from '../src/timeline-model';

const media:MediaAsset={id:'source',path:'C:\\source.mp4',name:'source',kind:'video',duration:12,width:200,height:100,fps:30,hasAudio:true,videoStart:0,videoEnd:12,sourceRevision:'a'.repeat(64)};
const track=(id:string,type:Track['type']='video'):Track=>({id,type,name:id,muted:false,hidden:false,locked:false});
function scene(){const project=newProject();project.media=[media];return project;}

test('cutting the sole audio, text or secondary video clip restores its pruned track and order on paste',()=>{
  for(const type of ['audio','text','video'] as const){
    const project=scene(),target=track('cut-track',type);target.height=91;target.muted=true;
    project.tracks.splice(1,0,target);
    const clip={...newClip(target.id,type==='text'?undefined:media),id:'cut',start:2,duration:3};project.clips=[clip];
    const clipboard=captureClipClipboard(project,[clip.id],true)!,cut=pruneEmptiedTracks(project,{...project,clips:[]});
    assert.ok(!cut.tracks.some(value=>value.id===target.id));
    const pasted=pasteClipClipboard(cut,clipboard,7)!;
    assert.deepEqual(pasted.project.tracks,project.tracks);assertProject(pasted.project);
    assert.equal(pasted.project.clips[0].start,7);assert.equal(pasted.project.clips[0].trackId,target.id);
    assert.notEqual(pasted.selected[0],clip.id);assert.equal(cut.clips.length,0);
  }
});

test('paste preserves current locks, cut excludes locked clips, and foreign missing tracks stay excluded',()=>{
  const project=scene();project.tracks.find(value=>value.id==='audio-1')!.locked=true;
  project.clips=[{...newClip('video-1',media),id:'video'},{...newClip('audio-1',media),id:'audio'},{...newClip('text-1'),id:'text'}];
  const cut=captureClipClipboard(project,['video','audio','text'],true)!;assert.deepEqual(cut.clips.map(clip=>clip.id),['video','text']);
  const clipboard=captureClipClipboard(project,['video','audio','text'])!;
  const locked={...project,tracks:project.tracks.map(value=>value.id==='video-1'?{...value,locked:true}:value)};
  assert.deepEqual(pasteClipClipboard(locked,clipboard,20)!.project.clips.slice(3).map(clip=>clip.trackId),['text-1']);
  const foreign={...scene(),tracks:[track('video-1')]};
  assert.deepEqual(pasteClipClipboard(foreign,clipboard,0)!.project.clips.map(clip=>clip.trackId),['video-1']);
});

test('restoring several tracks uses original neighbors while leaving new and reordered surviving tracks alone',()=>{
  const project=scene();project.tracks=[track('base'),track('middle'),track('upper'),track('caption','text'),track('audio','audio')];
  project.clips=[{...newClip('middle',media),id:'middle-clip'},{...newClip('upper',media),id:'upper-clip'},{...newClip('audio',media),id:'audio-clip'}];
  const clipboard=captureClipClipboard(project,project.clips.map(clip=>clip.id),true)!;
  const cut={...project,clips:[],tracks:[project.tracks[0],track('new'),project.tracks[3]]};
  const pasted=pasteClipClipboard(cut,clipboard,0)!;
  assert.deepEqual(pasted.project.tracks.map(value=>value.id),['base','new','middle','upper','caption','audio']);
  assert.deepEqual(cut.tracks.map(value=>value.id),['base','new','caption']);assertProject(pasted.project);
});

test('track, clip and timeline limits fail atomically, including overlap-created tracks',()=>{
  const project=scene();project.clips=[{...newClip('text-1'),id:'caption',duration:3}];
  const clipboard=captureClipClipboard(project,['caption'])!;
  const full={...project,clips:[],tracks:Array.from({length:100},(_,i)=>track(`full-${i}`))},before=structuredClone(full);
  assert.throws(()=>pasteClipClipboard(full,clipboard,0),/100개/);assert.deepEqual(full,before);
  const occupied={...project,tracks:[project.tracks.find(value=>value.id==='text-1')!,...Array.from({length:99},(_,i)=>track(`other-${i}`))]};
  assert.throws(()=>pasteClipClipboard(occupied,clipboard,0),/100개/);assert.equal(occupied.clips.length,1);
  const many={...project,clips:Array.from({length:10000},(_,i)=>({...project.clips[0],id:`clip-${i}`}))};
  assert.throws(()=>pasteClipClipboard(many,clipboard,0),/클립 수/);assert.throws(()=>pasteClipClipboard(project,clipboard,86399),/타임라인/);
});

const sample:MotionSample={time:0,box:{x:.2,y:.3,width:.2,height:.2},score:.8,status:'tracked',anchor:false};
const analysis:MotionAnalysis={version:1,id:'motion',mediaId:media.id,path:'C:\\motion.slutrack',sourceRevision:media.sourceRevision!,sourceWidth:200,sourceHeight:100,analysisWidth:200,analysisHeight:100,start:0,end:12,firstFrameTime:0,frames:360,anchors:[{time:0,box:sample.box}],backend:'cpu'};
function trackedScene(){const project=scene();project.clips=[{...newClip('video-1',media),id:'source-clip'},{...newClip('text-1'),id:'follower',duration:12}];return attachMotion(project,'source-clip',['follower'],analysis,sample,0,false);}

test('cut and paste remaps a tracked source and follower after their original clips and path were pruned',()=>{
  const project=trackedScene(),clipboard=captureClipClipboard(project,['source-clip','follower'],true)!;
  const cut=reconcileMotion(project,pruneEmptiedTracks(project,{...project,clips:[]}));assert.equal(cut.motionPaths,undefined);
  const pasted=pasteClipClipboard(cut,clipboard,20)!,source=pasted.project.clips.find(clip=>clip.mediaId===media.id)!,follower=pasted.project.clips.find(clip=>clip.text!==undefined)!;
  assert.equal(follower.motionBinding!.sourceClipId,source.id);assert.equal(bindingTime(pasted.project,follower.motionBinding!,analysis,22),2);
  assert.equal(pasted.project.motionPaths?.length,1);assertProject(pasted.project);
  assert.equal(clipboard.clips[1].motionBinding!.sourceClipId,'source-clip');
});

test('clipboard freezes internal copied motion geometry but unselected external sources stay live',()=>{
  const project=trackedScene(),both=captureClipClipboard(project,['source-clip','follower'])!,followerOnly=captureClipClipboard(project,['follower'])!;
  const changed={...project,clips:project.clips.map(clip=>clip.id==='source-clip'?{...clip,x:150}:clip)};
  const paired=pasteClipClipboard(changed,both,20)!,copiedSource=paired.project.clips.find(clip=>paired.selected.includes(clip.id)&&clip.mediaId===media.id)!;
  assert.equal(copiedSource.x,0);
  assert.equal(paired.project.clips.find(clip=>paired.selected.includes(clip.id)&&clip.motionBinding)!.motionBinding!.source.x,0);
  const external=pasteClipClipboard(changed,followerOnly,20)!;
  assert.equal(external.project.clips.at(-1)!.motionBinding!.sourceClipId,'source-clip');assert.equal(external.project.clips.at(-1)!.motionBinding!.source.x,150);
});

test('paste rejects excess motion analyses and aggregate source references before changing the live project',()=>{
  const original=trackedScene(),clipboard=captureClipClipboard(original,['follower'])!;
  const paths=Array.from({length:1000},(_,i)=>({...analysis,id:`analysis-${i}`}));
  const full={...original,motionPaths:paths,clips:[original.clips[0],...paths.map((path,i)=>({...original.clips[1],id:`follower-${i}`,motionBinding:{...original.clips[1].motionBinding!,analysisId:path.id}}))]};
  assertProject(full);assert.throws(()=>pasteClipClipboard(full,clipboard,20),/1,000개/);assert.equal(full.motionPaths.length,1000);assert.equal(full.clips.length,1001);
  const binding={...original.clips[1].motionBinding!,sourceClipId:undefined,segments:Array.from({length:9999},()=>({source:original.clips[1].motionBinding!.source}))};
  const many={...original,clips:[original.clips[0],...Array.from({length:5},(_,i)=>({...original.clips[1],id:`many-${i}`,motionBinding:binding}))]};
  assertProject(many);const large=captureClipClipboard(many,['many-0'])!;
  assert.throws(()=>pasteClipClipboard(many,large,20),/50,000개/);assert.equal(many.clips.length,6);
});

test('copy and paste retain compound-internal LUTs, motion analyses and untouched internal IDs',()=>{
  const inner=trackedScene(),lut={...parseCube('LUT_3D_SIZE 2\n'+Array.from({length:8},(_,i)=>`${i%2} ${Math.floor(i/2)%2} ${Math.floor(i/4)%2}`).join('\n')),id:'inner-lut'};
  inner.clips[0].colorGrade={enabled:true,intensity:1,lutId:lut.id};inner.colorLuts=[lut];
  const derived={...media,id:'derived',path:'C:\\derived.mp4'};
  const project={...inner,media:[media,derived],clips:[{...newClip('video-1',derived),id:'compound',compound:{derivedMediaId:derived.id,start:0,clips:inner.clips,tracks:inner.tracks}}]};assertProject(project);
  const clipboard=captureClipClipboard(project,['compound'])!;
  assert.equal(clipboard.colorLuts.length,1);assert.equal(clipboard.motionPaths.length,1);
  const pasted=pasteClipClipboard({...project,clips:[],colorLuts:undefined,motionPaths:undefined},clipboard,20)!;
  assertProject(pasted.project);assert.deepEqual(pasted.project.clips[0].compound,project.clips[0].compound);
  assert.equal(pasted.project.colorLuts?.[0].id,lut.id);assert.equal(pasted.project.motionPaths?.[0].id,analysis.id);
});

test('transition copies keep selected pairs and convert their duration when project fps changes',()=>{
  const project=scene();project.clips=[{...newClip('video-1',media),id:'a',in:1,duration:2},{...newClip('video-1',media),id:'b',start:2,in:3,duration:2}];
  project.transitions=[{id:'cut',fromClipId:'a',toClipId:'b',kind:'dissolve',durationFrames:12,easing:'linear',direction:'left',audio:'linear'}];
  const clipboard=captureClipClipboard(project,['a','b'])!,pasted=pasteClipClipboard({...project,fps:60,clips:[],transitions:[]},clipboard,5)!;
  assert.equal(pasted.project.transitions?.[0].durationFrames,24);assert.deepEqual(pasted.project.transitions?.map(value=>[value.fromClipId,value.toClipId]),[pasted.selected]);assertProject(pasted.project);
  assert.equal(captureClipClipboard(project,['a'])!.transitions.length,0);
});
