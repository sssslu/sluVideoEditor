import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject,trimClip} from '../shared/project';
import {clipSourceSpan,clipSourceTime} from '../shared/speed';
import {applyEnhancement,restoreEnhancement,enhancementSource,applyCutout,restoreCutout,applyStabilization,applyReversal,clipMediaIds,clipMediaAvailable,sameSourceInterval} from '../shared/processing';
import {assertProject} from '../shared/validation';
import type {Clip,MediaAsset,JobEvent} from '../shared/types';
import {ownEnhancementJob} from '../src/enhancement-preview';

const original:MediaAsset={id:'original',path:'C:/original.mp4',name:'original',kind:'video',duration:50,width:640,height:360,fps:30,hasAudio:true};
const source:Clip={...newClip('video-1',original),start:5,in:3,duration:4,speedCurve:[{position:0,speed:.5},{position:.5,speed:3},{position:1,speed:1}],x:54};
const derived=(id:string,duration=50,alpha=false):MediaAsset=>({...original,id,path:`C:/${id}.mp4`,duration,hasAlpha:alpha});
const enhanced=derived('enhanced',clipSourceSpan(source));
const project=(clip:Clip,assets:MediaAsset[]=[])=>({...newProject(),media:[original,enhanced,...assets],clips:[clip]});

test('enhancement retains effects and nonlinear timing through trim, save and original restoration',()=>{
  const request=enhancementSource(project(source),source);
  assert.equal(request.start,3);assert.equal(request.duration,clipSourceSpan(source));
  const applied=applyEnhancement(source,enhanced,2);
  assert.equal(applied.x,54);assert.equal(applied.start,5);assert.equal(applied.in,0);assert.deepEqual(applied.speedCurve,source.speedCurve);
  const roundtrip=JSON.parse(JSON.stringify(project(applied)));assertProject(roundtrip);
  const restored=restoreEnhancement(trimClip(roundtrip.clips[0],.4,3.2)),expected=trimClip(source,.4,3.2);
  for(let i=0;i<=40;i++)assert.ok(Math.abs(clipSourceTime(restored,i/40*restored.duration)-clipSourceTime(expected,i/40*expected.duration))<1e-9);
  assert.equal(restored.enhancement,undefined);assert.equal(restored.mediaId,original.id);
  assert.equal(sameSourceInterval(applied,{...applied,start:20,x:0}),true);
  assert.equal(sameSourceInterval(applied,{...applied,enhancement:{...applied.enhancement!,scale:4}}),false);
});

test('enhancement restores prior reverse/stabilization and unwinds all later operations',()=>{
  const s=derived('stabilized'),r=derived('reversed'),laterS=derived('later-s'),laterR=derived('later-r'),alpha=derived('cutout',50,true),finalS=derived('final-s',50,true),finalR=derived('final-r',50,true);
  const before=applyReversal(applyStabilization(source,s,original,source.in,{}),r);
  let clip=applyEnhancement(before,enhanced,4);
  clip=applyReversal(applyStabilization(clip,laterS,enhanced,0,{}),laterR);
  clip=applyCutout(clip,alpha,{quality:'portrait'});
  clip=applyStabilization(applyReversal(clip,finalR),finalS,finalR,0,{});
  const assets=[s,r,laterS,laterR,alpha,finalS,finalR];assertProject(project(clip,assets));
  assert.deepEqual(restoreEnhancement(clip),{...before,enhancement:undefined,cutout:undefined});
  assert.ok(restoreCutout(clip).enhancement);assert.equal(restoreCutout(clip).cutout,undefined);
  assert.deepEqual(new Set(clipMediaIds(clip)),new Set([original.id,enhanced.id,...assets.map(m=>m.id)]));
  assert.equal(clipMediaAvailable(clip,[enhanced,...assets]),false);
});

test('enhancement rejects unsupported source, duplicate layers, corrupt linkage and legacy format',()=>{
  const applied=applyEnhancement(source,enhanced,2);
  assert.throws(()=>enhancementSource(project(applied),applied));
  assert.throws(()=>enhancementSource({...project(source),media:[{...original,hasAlpha:true}]},source));
  assert.throws(()=>enhancementSource(project({...source,in:49}),{...source,in:49}));
  for(const patch of [{scale:3},{sourceMediaId:'missing'},{derivedMediaId:'original'},{sourceIn:49},{sourceDuration:NaN},{priorStabilization:{sourceMediaId:enhanced.id,sourceIn:0,options:{}}}]){
    assert.throws(()=>assertProject(project({...applied,enhancement:{...applied.enhancement!,...patch} as Clip['enhancement']})));
  }
  assert.throws(()=>assertProject({...project(applied),version:9}));
  assert.throws(()=>restoreEnhancement({...applied,in:100}));
  assert.throws(()=>assertProject({...project(applied),media:[original,{...enhanced,hasAlpha:true}]}));
});

test('a trimmed later reversal restores the opposite enhanced interval before restoring its original',()=>{
  const reversed=derived('later-reverse',clipSourceSpan(source)),alpha=derived('later-alpha',clipSourceSpan(source),true);
  const applied=applyEnhancement(source,enhanced,2),reversedClip=applyReversal(applied,reversed);
  const trimmed=trimClip(applyCutout(reversedClip,alpha,{quality:'fullbody'}),.4,3.2);
  const restored=restoreEnhancement(trimmed),offset=clipSourceSpan(source)-trimmed.in-clipSourceSpan(trimmed);
  assert.equal(restored.mediaId,source.mediaId);assert.ok(Math.abs(restored.in-source.in-offset)<1e-9);
  assert.deepEqual(restored.speedCurve,trimmed.speedCurve);assert.equal(restored.cutout,undefined);assert.equal(restored.reversal,undefined);
  assertProject(project(trimmed,[reversed,alpha]));assertProject(project(restored,[reversed,alpha]));
});

function jobFixture(){
  const listeners=new Set<(event:JobEvent)=>void>(),cancelled:string[]=[],discarded:string[]=[],events:JobEvent[]=[],errors:unknown[]=[];
  let resolve!:(value:{jobId:string})=>void,reject!:(error:unknown)=>void;
  const request=new Promise<{jobId:string}>((yes,no)=>{resolve=yes;reject=no;});
  const api={onJob:(callback:(event:JobEvent)=>void)=>{listeners.add(callback);return()=>{listeners.delete(callback);};},cancelJob:async(id:string)=>{cancelled.push(id);},discardEnhancementPreview:async(id:string)=>{discarded.push(id);}};
  const emit=(status:JobEvent['status'],id='mine',preview=true)=>{for(const listener of [...listeners])listener({id,type:preview?'enhance':'enhancement-install',preview,status,progress:1,message:status,...(status==='complete'&&preview?{media:enhanced}:{})});};
  return {listeners,cancelled,discarded,events,errors,resolve,reject,emit,api,request};
}
test('preview completion before IPC response is owned and discarded exactly once on close',async()=>{
  const f=jobFixture(),owner=ownEnhancementJob(f.api,()=>f.request,true,e=>f.events.push(e),e=>f.errors.push(e));
  f.emit('complete','unrelated');f.emit('complete');f.resolve({jobId:'mine'});await owner.started;
  assert.equal(f.events.length,1);assert.equal(f.listeners.size,0);assert.equal(f.discarded.length,0);
  owner.dispose();owner.dispose();assert.deepEqual(f.discarded,[enhanced.id]);assert.deepEqual(f.cancelled,[]);
});
test('closing while IPC is pending cancels only the owned job and disposes late completion',async()=>{
  const f=jobFixture(),owner=ownEnhancementJob(f.api,()=>f.request,true,e=>f.events.push(e),e=>f.errors.push(e));
  owner.dispose();f.resolve({jobId:'mine'});await owner.started;
  assert.deepEqual(f.cancelled,['mine']);f.emit('complete','unrelated');assert.equal(f.listeners.size,1);
  f.emit('complete');assert.deepEqual(f.discarded,[enhanced.id]);assert.deepEqual(f.events,[]);assert.equal(f.listeners.size,0);
});
test('completion and close before IPC response discards without cancelling a completed job',async()=>{
  const f=jobFixture(),owner=ownEnhancementJob(f.api,()=>f.request,true,e=>f.events.push(e),e=>f.errors.push(e));
  f.emit('complete');owner.dispose();f.resolve({jobId:'mine'});await owner.started;
  assert.deepEqual(f.discarded,[enhanced.id]);assert.deepEqual(f.cancelled,[]);assert.equal(f.listeners.size,0);
});
test('failed requests release listeners and installation intent does not discard ordinary media',async()=>{
  const f=jobFixture(),owner=ownEnhancementJob(f.api,()=>f.request,false,e=>f.events.push(e),e=>f.errors.push(e));
  f.emit('complete');f.emit('running','mine',false);f.resolve({jobId:'mine'});await owner.started;
  owner.dispose();assert.deepEqual(f.cancelled,['mine']);f.emit('cancelled','mine',false);assert.equal(f.listeners.size,0);assert.deepEqual(f.discarded,[]);
  const bad=jobFixture(),failed=ownEnhancementJob(bad.api,()=>bad.request,true,e=>bad.events.push(e),e=>bad.errors.push(e));
  bad.reject(new Error('IPC failed'));await failed.started;assert.equal(bad.errors.length,1);assert.equal(bad.listeners.size,0);
});
