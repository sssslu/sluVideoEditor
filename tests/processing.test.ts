import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {newClip,newProject,trimClip} from '../shared/project';
import {clipSourceTime,clipSourceSpan} from '../shared/speed';
import {applyReversal,restoreReversal,reversalSource,clipMediaIds,applyStabilization,clipMediaAvailable,restoreStabilization,sameSourceInterval,sourceCuesToTimeline,stabilizationSource} from '../shared/processing';
import {assertProject} from '../shared/validation';
import {readProject} from '../electron/project-store';
import {assertCaptionWords} from '../shared/captions';
import type {MediaAsset} from '../shared/types';

const original:MediaAsset={id:'original',name:'source.mp4',path:'C:/source.mp4',kind:'video',duration:50,width:1920,height:1080,fps:30,hasAudio:true};
const curve=[{position:0,speed:.5},{position:.5,speed:3},{position:1,speed:1}];
const source={...newClip('video-1',original),start:5,in:3,duration:4,speedCurve:curve};
test('source captions map through the nonlinear inverse and clip to the selected source interval',()=>{
  const first=clipSourceTime(source,.5),second=clipSourceTime(source,2.2);
  const mapped=sourceCuesToTimeline(source,[{start:first,end:second,text:'자막'},{start:0,end:2,text:'outside'},{start:40,end:41,text:'outside'},{start:2,end:clipSourceTime(source,5),text:'entire'}]);
  assert.equal(mapped.length,2);assert.ok(Math.abs(mapped[0].start-5.5)<1e-10);assert.ok(Math.abs(mapped[0].end-7.2)<1e-10);
  assert.deepEqual(mapped[1],{start:5,end:9,text:'entire'});
});

test('each measured caption-word boundary follows the nonlinear source clock independently',()=>{
  const time=(local:number)=>clipSourceTime(source,local);
  const [mapped]=sourceCuesToTimeline(source,[{start:time(.2),end:time(3.8),text:'one 👩🏽‍🚀 three',words:[
    {from:0,to:3,start:time(.2),end:time(.8),timing:'measured'},
    {from:4,to:11,start:time(1.1),end:time(2.1),timing:'manual'},
    {from:12,to:17,start:time(3),end:time(3.8),timing:'estimated'},
  ]}]);
  assertCaptionWords(mapped.text,mapped.words,mapped.start,mapped.end);
  const expected=[[5.2,5.8],[6.1,7.1],[8,8.8]];
  mapped.words!.forEach((word,index)=>{assert.ok(Math.abs(word.start-expected[index][0])<1e-10);assert.ok(Math.abs(word.end-expected[index][1])<1e-10);});
  assert.deepEqual(mapped.words!.map(w=>[w.from,w.to,w.timing]),[[0,3,'measured'],[4,11,'manual'],[12,17,'estimated']]);
  // Linear interpolation across the cue would be wrong for this rate curve.
  const ratio=(time(1.1)-time(.2))/(time(3.8)-time(.2));
  assert.ok(Math.abs(mapped.start+(mapped.end-mapped.start)*ratio-mapped.words![1].start)>.1);
});

test('source interval cuts trim timed words and omit outside words without inventing fallback alignment',()=>{
  const last=clipSourceTime(source,source.duration);
  const input={start:2,end:last+1,text:'before edge middle end after',words:[
    {from:0,to:6,start:2,end:2.5,timing:'measured' as const},
    {from:7,to:11,start:2.5,end:3.5,timing:'measured' as const},
    {from:12,to:18,start:4,end:5,timing:'measured' as const},
    {from:19,to:22,start:last-.5,end:last+.5,timing:'estimated' as const},
    {from:23,to:28,start:last+.5,end:last+1,timing:'estimated' as const},
  ]};
  const snapshot=JSON.stringify(input),[mapped]=sourceCuesToTimeline(source,[input]);
  assert.equal(JSON.stringify(input),snapshot);assert.equal(mapped.start,5);assert.equal(mapped.end,9);
  assert.deepEqual(mapped.words!.map(w=>mapped.text.slice(w.from,w.to)),['edge','middle','end']);
  assert.equal(mapped.words![0].start,5);assert.equal(mapped.words!.at(-1)!.end,9);
  assertCaptionWords(mapped.text,mapped.words,mapped.start,mapped.end);
  const [fallback]=sourceCuesToTimeline(source,[{text:'ordinary SRT',start:3,end:4}]);assert.equal(fallback.words,undefined);
  const [untimed]=sourceCuesToTimeline(source,[{text:'outside timing',start:2,end:4,words:[{from:0,to:7,start:2,end:2.5,timing:'measured'}]}]);assert.equal(untimed.words,undefined);
  assert.throws(()=>sourceCuesToTimeline(source,[{...input,words:[{from:0,to:6,start:2,end:NaN,timing:'measured'}]}]));
});
test('stabilization preserves timeline edits, source originals and trim-aware restoration',()=>{
  const project=newProject();project.media=[original];project.clips=[source];
  const request=stabilizationSource(project,source);assert.equal(request.start,3);assert.equal(request.duration,clipSourceSpan(source));
  const derived={...original,id:'derived',path:'C:/derived.mov',name:'derived.mov',duration:request.duration};
  const corrected=applyStabilization(source,derived,original,request.start,{start:3,duration:request.duration,smoothing:30,crop:'auto'});
  assert.equal(corrected.start,source.start);assert.deepEqual(corrected.speedCurve,curve);assert.equal(corrected.in,0);
  project.media.push(derived);project.clips=[corrected];assertProject(project);
  const trimmed=trimClip(corrected,.4,3.2),restored=restoreStabilization(trimmed),expected=trimClip(source,.4,3.2);
  assert.equal(restored.mediaId,original.id);assert.equal(restored.stabilization,undefined);
  for(let i=0;i<=100;i++){const t=trimmed.duration*i/100;assert.ok(Math.abs(clipSourceTime(restored,t)-clipSourceTime(expected,t))<1e-9);}
  const reanalysis=stabilizationSource({...project,clips:[trimmed]},trimmed);
  assert.equal(reanalysis.media.id,original.id);assert.equal(reanalysis.start,restored.in);
});
test('analysis completion may follow timeline moves but cannot replace a newly edited source interval',()=>{
  assert.equal(sameSourceInterval(source,{...source,start:50,x:100}),true);
  assert.equal(sameSourceInterval(source,{...source,in:4}),false);
  assert.equal(sameSourceInterval(source,{...source,speedCurve:[{position:0,speed:1},{position:1,speed:1}]}),false);
  assert.equal(sameSourceInterval(source,{...source,mediaId:'other'}),false);
});
test('stabilization original references and options must be valid before saving',()=>{
  const p=newProject();p.media=[original];p.clips=[{...source,stabilization:{sourceMediaId:original.id,sourceIn:3,options:{smoothing:30}}}];assertProject(p);
  assert.throws(()=>assertProject({...p,clips:[{...p.clips[0],stabilization:{...p.clips[0].stabilization!,sourceMediaId:'missing'}}]}));
  assert.throws(()=>assertProject({...p,clips:[{...p.clips[0],stabilization:{...p.clips[0].stabilization!,options:{zoom:NaN}}}]}));
});
test('a copied processed clip cannot be pasted after its original reference was removed',()=>{
  const derived={...original,id:'derived',path:'C:/derived.mov'},copy=applyStabilization(source,derived,original,3,{});
  assert.equal(clipMediaAvailable(copy,[derived]),false);
  assert.equal(clipMediaAvailable(copy,[original,derived]),true);
  assert.equal(clipMediaAvailable(restoreStabilization(copy),[original]),true);
});
test('opening a legacy project upgrades its format in memory without rewriting the source file',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'slu-format-')),file=path.join(directory,'legacy.sluproj');
  const legacy={...newProject(),version:1};const content=JSON.stringify(legacy);await writeFile(file,content);
  assert.deepEqual(await readProject(file),{...legacy,version:10});assert.equal(await readFile(file,'utf8'),content);
  await writeFile(file,JSON.stringify({...legacy,version:11}));await assert.rejects(readProject(file));
});

test('reverse restores the opposite original trim boundary and retains timeline envelopes and rate curves',()=>{
  const project=newProject();project.media=[original];project.clips=[source];
  const request=reversalSource(project,source),derived={...original,id:'reverse',path:'C:/reverse.mov',duration:request.duration},reversed=applyReversal(source,derived);
  assert.equal(request.start,source.in);assert.equal(reversed.in,0);assert.equal(reversed.duration,source.duration);assert.equal(reversed.start,source.start);assert.deepEqual(reversed.speedCurve,curve);assert.deepEqual(restoreReversal(reversed),{...source,reversal:undefined,stabilization:undefined});
  const trimmed=trimClip(reversed,.4,2.8),restored=restoreReversal(trimmed),expectedStart=source.in+clipSourceSpan(source)-clipSourceSpan(trimClip(source,0,2.8));
  assert.ok(Math.abs(restored.in-expectedStart)<1e-9);assert.equal(restored.duration,2.4);assert.deepEqual(restored.speedCurve,trimmed.speedCurve);assert.equal(restored.sourceClipOffset,trimmed.sourceClipOffset);
  assert.equal(sameSourceInterval(reversed,{...reversed,start:90,opacity:.5}),true);assert.equal(sameSourceInterval(reversed,{...reversed,reversal:undefined}),false);
  project.media.push(derived);project.clips=[trimmed];assertProject(project);assert.throws(()=>assertProject({...project,version:6}));assert.throws(()=>reversalSource(project,reversed));
});

test('reverse composes with corrections before and after it, retaining every source dependency',()=>{
  const first={...original,id:'first',path:'C:/first.mov',duration:clipSourceSpan(source)},stabilized=applyStabilization(source,first,original,source.in,{}),reverse={...first,id:'reverse',path:'C:/reverse.mov'},reversed=applyReversal(stabilized,reverse),trimmed=trimClip(reversed,.4,3.2),later={...first,id:'later',path:'C:/later.mov',duration:clipSourceSpan(trimmed)},corrected=applyStabilization(trimmed,later,reverse,trimmed.in,{smoothing:30}),secondTrim=trimClip(corrected,.3,2),result=restoreReversal(secondTrim);
  assert.equal(result.mediaId,first.id);assert.deepEqual(result.stabilization,stabilized.stabilization);assert.equal(result.reversal,undefined);assert.deepEqual(result.speedCurve,secondTrim.speedCurve);
  const reverseStart=trimmed.in+secondTrim.in,span=clipSourceSpan(secondTrim);assert.ok(Math.abs(result.in-(reverse.duration-reverseStart-span))<1e-9);assert.ok(Math.abs(restoreStabilization(result).in-(source.in+result.in))<1e-9);
  const media=[original,first,reverse,later],project={...newProject(),media,clips:[secondTrim]};assertProject(project);
  assert.deepEqual(new Set(clipMediaIds(secondTrim)),new Set(media.map(m=>m.id)));for(const asset of media){const rest=media.filter(m=>m.id!==asset.id);assert.equal(clipMediaAvailable(secondTrim,rest),false);assert.throws(()=>assertProject({...project,media:rest}));}
  for(const bad of [{...secondTrim.reversal!,sourceDuration:NaN},{...secondTrim.reversal!,sourceIn:-1},{...secondTrim.reversal!,derivedMediaId:first.id},{...secondTrim.reversal!,priorStabilization:{sourceMediaId:original.id,sourceIn:0,options:{zoom:NaN}}}])assert.throws(()=>assertProject({...project,clips:[{...secondTrim,reversal:bad}]}));
  assert.throws(()=>restoreReversal({...reversed,in:reverse.duration+1}));
});

test('format7 reverse metadata survives file serialization and legacy format6 opens without rewriting',async()=>{
  const derived={...original,id:'reverse',path:'C:/reverse.mov',duration:clipSourceSpan(source)},project={...newProject(),media:[original,derived],clips:[applyReversal(source,derived)]},directory=await mkdtemp(path.join(os.tmpdir(),'slu-reverse-format-')),file=path.join(directory,'saved.sluproj');
  await writeFile(file,JSON.stringify(project));assert.deepEqual(await readProject(file),JSON.parse(JSON.stringify(project)));
  const legacy={...newProject(),version:6},content=JSON.stringify(legacy);await writeFile(file,content);assert.equal((await readProject(file)).version,10);assert.equal(await readFile(file,'utf8'),content);
});
