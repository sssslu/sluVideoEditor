import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {newClip,newProject,trimClip,splitClip} from '../shared/project';
import {clipSourceSpan,clipSourceTime} from '../shared/speed';
import {applyCutout,restoreCutout,cutoutSource,applyStabilization,applyReversal,clipMediaIds,sameSourceInterval} from '../shared/processing';
import {assertProject} from '../shared/validation';
import {readProject,serializeProject} from '../electron/project-store';
import {previewMediaPath,previewClockOffset,fromPreviewTime,toPreviewTime} from '../shared/media-clock';
import type {Clip,CutoutQuality,MediaAsset,Project} from '../shared/types';

const original:MediaAsset={id:'original',path:'C:/original.mp4',name:'원본',kind:'video',duration:50,width:1920,height:1080,fps:30,hasAudio:true};
function fixture(){const p=newProject();p.media=[original];p.clips=[{...newClip('video-1',original),start:2,in:5,duration:4,speedCurve:[{position:0,speed:.5},{position:1,speed:2}],x:37,opacity:.8}];return p;}
function derived(p:Project,clip:Clip,kind:string){const media={...original,id:kind+'-'+p.media.length,path:`C:/${kind}-${p.media.length}.mov`,duration:clipSourceSpan(clip),hasAlpha:kind==='cutout'||p.media.find(m=>m.id===clip.mediaId)?.hasAlpha};p.media.push(media);return media;}
function processSequence(p:Project,clip:Clip,sequence:string){for(const operation of sequence){const media=derived(p,clip,operation);clip=operation==='s'?applyStabilization(clip,media,p.media.find(m=>m.id===clip.mediaId)!,clip.in,{smoothing:30}):applyReversal(clip,media);}return clip;}
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('cutout restores source, timing and prior operations through every supported stabilization/reversal order',()=>{
 for(const before of ['', 's','r','sr','rs','srs'])for(const after of ['', 's','r','sr','rs','srs']){
  const p=fixture(),source=processSequence(p,p.clips[0],before),snapshot=structuredClone(source),request=cutoutSource(p,source),media=derived(p,source,'cutout');
  near(request.start,source.in);const cutout=applyCutout(source,media,{quality:'fullbody'});let processed=processSequence(p,cutout,after);
  p.clips=[processed];assertProject(p);
  processed=trimClip(processed,.5,3.5);p.clips=[processed];assertProject(p);
  const restored=restoreCutout(processed),trimmed=trimClip(snapshot,.5,3.5),offset=after.includes('r')?clipSourceSpan(source)-clipSourceSpan(trimClip(source,0,3.5)):clipSourceTime(source,.5)-source.in;
  assert.equal(restored.mediaId,source.mediaId);near(restored.in,source.in+offset);near(restored.duration,3);
  assert.deepEqual(restored.stabilization,source.stabilization);assert.deepEqual(restored.reversal,source.reversal);assert.equal(restored.cutout,undefined);
  assert.deepEqual(restored.speedCurve,trimmed.speedCurve);assert.equal(restored.x,source.x);assert.equal(restored.opacity,source.opacity);
  assert.deepEqual(source,snapshot);p.clips=[restored];assertProject(p);
 }
});
test('split cutout clips restore contiguous original intervals and keep every underlying media reference',()=>{
 const p=fixture(),source=processSequence(p,p.clips[0],'srs'),result=applyCutout(source,derived(p,source,'cutout'),{}),pieces=splitClip(result,result.start+1.5)!;
 p.clips=pieces;assertProject(p);const restored=pieces.map(restoreCutout);
 near(restored[0].in,source.in);near(restored[0].in+clipSourceSpan(restored[0]),restored[1].in);near(restored[1].in+clipSourceSpan(restored[1]),source.in+clipSourceSpan(source));
 for(const id of clipMediaIds(result)){assert.ok(p.media.some(m=>m.id===id));assert.throws(()=>assertProject({...p,media:p.media.filter(m=>m.id!==id)}));}
 assert.equal(sameSourceInterval(result,{...result,start:20,x:50}),true);assert.equal(sameSourceInterval(result,{...result,cutout:{...result.cutout!,sourceIn:10}}),false);
});
test('cutout schema rejects incompatible versions, broken nested links and cycles, and survives actual save/reopen',async()=>{
 const p=fixture(),source=processSequence(p,p.clips[0],'srs'),clip=applyCutout(source,derived(p,source,'cutout'),{});p.clips=[clip];assertProject(p);
 const folder=await mkdtemp(path.join(os.tmpdir(),'slu-cutout-')),file=path.join(folder,'project.sluproj'),content=serializeProject(p);await writeFile(file,content);assert.deepEqual(await readProject(file),JSON.parse(content));assert.equal(await readFile(file,'utf8'),content);
 assert.throws(()=>assertProject({...p,version:8}));
 for(const patch of [{sourceDuration:NaN},{quality:'anything'},{derivedMediaId:original.id},{sourceMediaId:clip.mediaId},{priorStabilization:{sourceMediaId:clip.mediaId,sourceIn:0,options:{}}},{priorReversal:{...clip.cutout!.priorReversal!,derivedMediaId:original.id}}])assert.throws(()=>assertProject({...p,clips:[{...clip,cutout:{...clip.cutout,...patch}}]}));
 assert.throws(()=>restoreCutout({...clip,in:100}));assert.throws(()=>cutoutSource(p,clip));
});
test('FFV1 uses its valid browser proxy and normalized clock even with optional proxies disabled',()=>{
 const source={...original,codec:'ffv1',hasAlpha:true,proxyPath:'C:/cutout-alpha-proxy.webm',timing:{version:1 as const,origin:4,previewOffset:4}};
 assert.equal(previewMediaPath(source,false),source.proxyPath);assert.equal(previewClockOffset(source,false),0);near(fromPreviewTime(source,toPreviewTime(source,.25,false),false),.25);
 assert.equal(previewMediaPath({...source,proxyPath:'C:/old.mp4'},false),source.path);assert.equal(previewClockOffset({...source,proxyPath:undefined},false),4);
 assert.equal(previewMediaPath({...source,codec:'h264'},false),source.path);assert.equal(previewMediaPath({...source,codec:'h264'},true),source.proxyPath);
});

test('all supported cutout model settings survive file roundtrip, splitting and restoration',async()=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'slu-cutout-quality-'));
 for(const quality of ['portrait','fullbody','precision'] as CutoutQuality[]){
  const p=fixture(),source=p.clips[0],media=derived(p,source,'cutout');
  const processed=applyCutout(source,media,{quality});
  p.clips=splitClip(processed,processed.start+1.5)!;
  const file=path.join(folder,`${quality}.sluproj`);
  await writeFile(file,serializeProject(p));
  const reopened=await readProject(file);
  assert.equal(reopened.clips.length,2);
  assert.ok(reopened.clips.every(clip=>clip.cutout?.quality===quality));
  const restored=reopened.clips.map(restoreCutout);
  near(restored[0].in,source.in);
  near(restored[0].in+clipSourceSpan(restored[0]),restored[1].in);
  assert.ok(restored.every(clip=>clip.mediaId===source.mediaId&&!clip.cutout));
  assertProject({...reopened,clips:restored});
 }
});
