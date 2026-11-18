import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {attachMotion} from '../shared/motion';
import {parseCube} from '../shared/color';
import type {MediaAsset,Project} from '../shared/types';
import type {MotionAnalysis,MotionSample} from '../shared/tracking';
import {combinationSignature} from '../src/combine-snapshot';

const media:MediaAsset={id:'source',path:'C:/source.mp4',name:'source',kind:'video',duration:20,width:200,height:100,fps:30,hasAudio:false,sourceRevision:'a'.repeat(64),videoStart:0,videoEnd:20};
const sample:MotionSample={time:3,box:{x:.2,y:.3,width:.2,height:.2},score:1,status:'tracked',anchor:false};
const analysis:MotionAnalysis={version:1,id:'motion',mediaId:media.id,path:'C:/motion.slutrack',sourceRevision:media.sourceRevision!,sourceWidth:200,sourceHeight:100,analysisWidth:200,analysisHeight:100,start:0,end:20,firstFrameTime:0,frames:600,anchors:[{time:0,box:sample.box}],backend:'cpu'};
const lut={...parseCube('LUT_3D_SIZE 2\n'+Array.from({length:8},(_,i)=>[i%2,Math.floor(i/2)%2,Math.floor(i/4)%2].join(' ')).join('\n')),id:'lut'};
function scene():Project{
  const project=newProject();project.media=[media];project.colorLuts=[lut];
  project.clips=[{...newClip('video-1',media,4),id:'source-clip',duration:4,in:2,colorGrade:{enabled:true,intensity:1,lutId:lut.id}},{...newClip('text-1',undefined,5),id:'caption',duration:2}];
  return attachMotion(project,'source-clip',['caption'],analysis,sample,5,false);
}

test('combine snapshot detects a live unselected tracking source changing while the selected caption stays identical',()=>{
  const project=scene(),before=combinationSignature(project,['caption']);
  for(const patch of [{x:99},{start:3},{in:4},{rotation:90}]){
    const changed={...project,clips:project.clips.map(clip=>clip.id==='source-clip'?{...clip,...patch}:clip)};
    assert.equal(changed.clips[1],project.clips[1]);assert.notEqual(combinationSignature(changed,['caption']),before);
  }
  // The identical detached fallback renders the same frames after source removal.
  const removed={...project,clips:project.clips.filter(clip=>clip.id!=='source-clip')};assert.equal(combinationSignature(removed,['caption']),before);
});

test('combine snapshot detects source identity, geometry, stream and clock changes',()=>{
  const project=scene(),before=combinationSignature(project,['caption']);
  for(const patch of [{path:'C:/replacement.mp4'},{sourceRevision:'b'.repeat(64)},{duration:19},{width:400},{height:200},{fps:60},{videoStreamOrdinal:1},{hasAlpha:true},{timing:{version:1 as const,origin:1,previewOffset:.25}}]){
    const changed={...project,media:[{...media,...patch}]};assert.notEqual(combinationSignature(changed,['caption']),before,JSON.stringify(patch));
  }
});

test('effective track composition and canvas settings invalidate an in-flight combine result',()=>{
  const project=scene(),ids=['source-clip','caption'],before=combinationSignature(project,ids);
  for(const patch of [{width:1280},{height:720},{fps:60},{background:'#ffffff'}])assert.notEqual(combinationSignature({...project,...patch},ids),before);
  for(const patch of [{hidden:true},{muted:true}])assert.notEqual(combinationSignature({...project,tracks:project.tracks.map(track=>track.id==='video-1'?{...track,...patch}:track)},ids),before);
  assert.notEqual(combinationSignature({...project,tracks:[...project.tracks].reverse()},ids),before);
  assert.throws(()=>combinationSignature({...project,tracks:project.tracks.map(track=>track.id==='text-1'?{...track,hidden:true}:track)},['caption']),/보이거나/);
});

test('unrelated clips, library additions, project labels and preview caches do not invalidate a combine result',()=>{
  const project=scene(),before=combinationSignature(project,['caption']);
  const cache={...media,name:'renamed library item',thumbnail:'C:/new-thumb.jpg',waveform:[.1,.3],proxyPath:'C:/proxy.mp4'};
  const unrelated={...newClip('video-1',media,10),id:'unrelated',duration:2};
  const changed={...project,name:'new project title',updatedAt:'later',media:[{...media,id:'unused',path:'C:/unused.mp4'},cache],clips:[...project.clips,unrelated],tracks:project.tracks.map(track=>({...track,name:'renamed track',height:120})),colorLuts:[...project.colorLuts!,{...lut,id:'unused-lut'}]};
  assert.equal(combinationSignature(changed,['caption']),before);
});

test('only referenced LUT data and motion analyses contribute to the snapshot',()=>{
  const project=scene(),video=combinationSignature(project,['source-clip']),caption=combinationSignature(project,['caption']);
  assert.notEqual(combinationSignature({...project,colorLuts:[{...lut,data:lut.data.replace(/^./,lut.data[0]==='A'?'B':'A')}]},['source-clip']),video);
  assert.equal(combinationSignature({...project,colorLuts:[]},['caption']),caption);
  assert.notEqual(combinationSignature({...project,motionPaths:[{...analysis,path:'C:/changed.slutrack'}]},['caption']),caption);
  assert.equal(combinationSignature({...project,motionPaths:[{...analysis,id:'unused'},analysis]},['caption']),caption);
});

test('equivalent metadata insertion order does not create a false dependency change',()=>{
  const project=scene(),before=combinationSignature(project,['source-clip','caption']);
  const reorder=<T extends object>(value:T)=>Object.fromEntries(Object.entries(value).reverse()) as T;
  const changed={...project,clips:project.clips.map(reorder),media:project.media.map(reorder),motionPaths:project.motionPaths!.map(reorder),colorLuts:project.colorLuts!.map(reorder)};
  assert.equal(combinationSignature(changed,['source-clip','caption']),before);
});
