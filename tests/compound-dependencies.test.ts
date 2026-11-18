import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {assertProject} from '../shared/validation';
import {applyCombination,combinationProject,planCombination,uncombineClip} from '../shared/combine';
import {attachMotion,bindingTime,motionDelta,reconcileMotion,restoreMotionPaths} from '../shared/motion';
import {restoreColorLuts} from '../shared/color-edits';
import {parseCube} from '../shared/color';
import {walkClips,mapClipTree} from '../shared/clip-tree';
import type {Clip,MediaAsset,Project} from '../shared/types';
import type {MotionAnalysis,MotionSample} from '../shared/tracking';

const media:MediaAsset={id:'source',path:'C:/source.mp4',name:'source',kind:'video',duration:20,width:200,height:100,fps:30,hasAudio:false,sourceRevision:'a'.repeat(64)};
const derived=(id:string,duration:number):MediaAsset=>({...media,id,path:`C:/${id}.mov`,duration,hasAlpha:true});
const sample:MotionSample={time:3,box:{x:.2,y:.3,width:.2,height:.2},score:1,status:'tracked',anchor:false};
const analysis:MotionAnalysis={version:1,id:'motion',mediaId:media.id,path:'C:/motion.slutrack',sourceRevision:media.sourceRevision!,sourceWidth:200,sourceHeight:100,analysisWidth:200,analysisHeight:100,start:0,end:20,firstFrameTime:0,frames:600,anchors:[{time:0,box:sample.box}],backend:'cpu'};
const lut={...parseCube('LUT_3D_SIZE 2\n'+Array.from({length:8},(_,i)=>[i%2,Math.floor(i/2)%2,Math.floor(i/4)%2].join(' ')).join('\n')),id:'lut'};
function scene():Project{
  const p=newProject();p.media=[media];p.colorLuts=[lut];
  p.clips=[{...newClip('video-1',media,4),id:'source-clip',duration:4,in:2,colorGrade:{enabled:true,intensity:1,lutId:lut.id}},{...newClip('text-1',undefined,5),id:'caption',duration:2}];
  return attachMotion(p,'source-clip',['caption'],analysis,sample,5,false);
}
function combine(p:Project,ids:string[],id:string){const plan=planCombination(p,ids);return applyCombination(p,plan,p.clips.filter(c=>ids.includes(c.id)),derived(id,plan.end-plan.start));}

test('combining tracked clips and nesting compounds retains their analysis and LUT dependencies through paste and uncombine',()=>{
  const p=scene(),first=combine(p,['source-clip','caption'],'combined');
  const reconciled=reconcileMotion(p,first.project);assertProject(reconciled);assert.deepEqual(reconciled.motionPaths,[analysis]);
  const renderInput=combinationProject(reconciled,[first.clip.id]);assertProject(renderInput);assert.deepEqual(renderInput.motionPaths,[analysis]);
  const second=combine(reconciled,[first.clip.id],'nested'),nested=reconcileMotion(reconciled,second.project);assertProject(nested);
  assert.equal([...walkClips(nested.clips)].length,4);
  const deleted=reconcileMotion(nested,{...nested,clips:[],colorLuts:undefined});assert.equal(deleted.motionPaths,undefined);
  const restored=restoreMotionPaths(restoreColorLuts(deleted,nested.clips,nested.colorLuts!),nested.clips,nested.motionPaths!);
  const pasted={...restored,clips:structuredClone(nested.clips)};assertProject(pasted);
  const unpacked=uncombineClip(uncombineClip(pasted,second.clip.id).project,first.clip.id);assertProject(unpacked.project);
  assert.equal(unpacked.project.clips.find(c=>c.id==='caption')!.motionBinding!.analysisId,analysis.id);
  assert.equal(unpacked.project.clips.find(c=>c.id==='source-clip')!.colorGrade!.lutId,lut.id);
  assert.throws(()=>restoreMotionPaths(deleted,nested.clips,[]));assert.throws(()=>restoreColorLuts(deleted,nested.clips,[]));
});

test('an external tracking source is snapshotted at its latest transform and shifted with the compound render and restored clip',()=>{
  const before=scene(),p={...before,clips:before.clips.map(c=>c.id==='source-clip'?{...c,x:99}:c)},caption=p.clips[1];
  const input=combinationProject(p,['caption']),binding=input.clips[0].motionBinding!;assertProject(input);
  assert.equal(binding.sourceClipId,undefined);assert.equal(binding.source.x,99);
  assert.equal(bindingTime(input,binding,analysis,1),bindingTime(p,caption.motionBinding!,analysis,6));
  assert.deepEqual(motionDelta(input,binding,analysis,sample,1),motionDelta(p,caption.motionBinding!,analysis,sample,6));
  const combined=combine(p,['caption'],'overlay'),saved=reconcileMotion(p,combined.project);assertProject(saved);
  const stored=combined.clip.compound!.clips[0].motionBinding!;assert.equal(stored.sourceClipId,undefined);assert.equal(stored.source.x,99);
  const moved={...saved,clips:saved.clips.map(c=>c.id===combined.clip.id?{...c,start:20}:c)};
  const unpacked=uncombineClip(moved,combined.clip.id).project,restored=unpacked.clips.find(c=>c.id==='caption')!;assertProject(unpacked);
  assert.equal(restored.start,20);assert.equal(bindingTime(unpacked,restored.motionBinding!,analysis,21),bindingTime(p,caption.motionBinding!,analysis,6));
  assert.equal(caption.motionBinding!.sourceClipId,'source-clip');assert.equal(caption.motionBinding!.source.x,0);
});

test('clip-tree traversal is bounded and leaves unchanged history snapshots intact',()=>{
  const clips=scene().clips;assert.equal(mapClipTree(clips,c=>c),clips);
  const recursive:Clip={...clips[0]};recursive.compound={derivedMediaId:media.id,start:0,tracks:newProject().tracks,clips:[recursive]};
  assert.throws(()=>[...walkClips([recursive])],/깊게/);assert.throws(()=>mapClipTree([recursive],c=>c),/깊게/);
});

test('combining permits eight nested levels and rejects a ninth before rendering',()=>{
  let project=scene();
  for(let depth=1;depth<=8;depth++){
    const combined=combine(project,project.clips.map(clip=>clip.id),`level-${depth}`);
    project=reconcileMotion(project,combined.project);assertProject(project);
  }
  const before=JSON.stringify(project),deep=project.clips[0].id;
  assert.throws(()=>planCombination(project,[deep]),/깊게/);
  assert.throws(()=>combinationProject(project,[deep]),/깊게/);
  assert.equal(JSON.stringify(project),before);
  const unrelated={...newClip('text-1',undefined,10),id:'plain',duration:2};
  assert.deepEqual(planCombination({...project,clips:[...project.clips,unrelated]},['plain']).ids,['plain']);
});
