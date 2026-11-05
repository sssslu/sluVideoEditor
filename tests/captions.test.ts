import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {activeCaptionWord,assertCaptionWords,captionAnimationState,defaultCaptionStyle,defaultCaptionAnimation,editCaptionText,estimateCaptionWords} from '../shared/captions';
import type {Clip} from '../shared/types';
import {newClip,newProject,trimClip,splitClip} from '../shared/project';
import {assertProject} from '../shared/validation';
import {changeClipSpeed,cuesToClips,toCues} from '../src/editor';
import {saveRecovery,loadRecovery} from '../electron/project-store';

function fixture():Clip{return {...newClip('text-1'),text:'안녕 👨‍👩‍👧‍👦 hello',start:10,duration:3,captionStyle:defaultCaptionStyle(),captionAnimation:defaultCaptionAnimation(),captionWords:[{from:0,to:2,start:.1,end:.6,timing:'measured'},{from:3,to:14,start:.8,end:1.6,timing:'measured'},{from:15,to:20,start:1.7,end:2.7,timing:'manual'}]};}
test('caption spans require grapheme boundaries, ordered positive timings and bounded metadata',()=>{
  const clip=fixture(),text=clip.text!,words=clip.captionWords!;assertCaptionWords(text,words,0,3);
  for(const patch of [{from:4},{to:10},{end:.8},{start:NaN},{end:4},{timing:'fake'}])assert.throws(()=>assertCaptionWords(text,[words[0],{...words[1],...patch},words[2]],0,3));
  assert.throws(()=>assertCaptionWords(text,[words[1],words[0]],0,3));
  assert.throws(()=>assertCaptionWords('e\u0301',[{from:0,to:1,start:0,end:1,timing:'manual'}],0,1));
  assertCaptionWords(text,[words[0],words[2]],0,3); // Partial coverage is legitimate.
  assert.throws(()=>assertCaptionWords(text,Array.from({length:2049},()=>words[0]),0,3));
});
test('word highlight uses half-open intervals, real silence and explicit estimate opt-in',()=>{
  const clip=fixture();assert.equal(activeCaptionWord(clip,.1),0);assert.equal(activeCaptionWord(clip,.6),-1);assert.equal(activeCaptionWord(clip,.8),1);assert.equal(activeCaptionWord(clip,3),-1);
  const estimated={...clip,captionWords:clip.captionWords!.map(w=>({...w,timing:'estimated' as const}))};
  assert.equal(activeCaptionWord(estimated,.3),-1);assert.equal(activeCaptionWord({...estimated,captionStyle:{...estimated.captionStyle!,highlightEstimated:true}},.3),0);
  assert.equal(activeCaptionWord({...clip,captionStyle:{...clip.captionStyle!,highlight:false}},.3),-1);
  const boundary={...clip,captionWords:[{from:0,to:2,start:.1,end:.2,timing:'measured' as const}]};assert.equal(activeCaptionWord(boundary,.3-.2),0);assert.equal(activeCaptionWord(boundary,.4-.2),-1);assert.equal(activeCaptionWord(boundary,.1-1e-8),-1);
});
test('repeated trim and split preserve absolute word and animation phase including a crossing word',()=>{
  const original=fixture(),once=trimClip(original,.2,2.8),twice=trimClip(once,.3,2.3),parts=splitClip(original,11.1)!;
  assert.equal(parts[0].text,original.text);assert.equal(parts[1].text,original.text);
  for(const clip of [once,twice,...parts]){assertProject({...newProject(),clips:[clip]});for(let time=clip.start+.0001;time<clip.start+clip.duration;time+=.007){
    const a=activeCaptionWord(original,time-original.start),b=activeCaptionWord(clip,time-clip.start),old=a<0?null:original.captionWords![a],now=b<0?null:clip.captionWords![b];assert.deepEqual(now?[now.from,now.to]:null,old?[old.from,old.to]:null);
    const before=captionAnimationState(original,time-original.start),after=captionAnimationState(clip,time-clip.start);for(const key of ['opacity','scale','y'] as const)assert.ok(Math.abs(before[key]-after[key])<1e-10);
  }}
  assert.equal(parts[0].captionWords!.at(-1)!.to,14);assert.equal(parts[1].captionWords![0].to,14);
});
test('extending adds untimed exposure; timing edits and character edits have distinct semantics',()=>{
  const clip=fixture(),extended=trimClip(clip,-.2,3.5);assert.equal(activeCaptionWord(extended,0),-1);assert.equal(activeCaptionWord(extended,3.6),-1);assert.equal(editCaptionText(clip,clip.text!),clip);
  const edited=editCaptionText(clip,'수정한 자막');assert.equal(edited.captionWords,undefined);assert.equal(edited.captionStyle,clip.captionStyle);assert.equal(clip.captionWords!.length,3);
  assert.equal(estimateCaptionWords({...clip,captionWords:undefined}).every(w=>w.timing==='estimated'),true);
});
test('sub-frame cue normalization retains absolute word times and cue roundtrip metadata',()=>{
  const project=newProject(),cue={start:8.039,end:8.04,text:'짧아',words:[{from:0,to:2,start:8.039,end:8.04,timing:'measured' as const}]};
  const [clip]=cuesToClips([cue],'text-1',project,0,{start:8,end:8.04});assertProject({...project,clips:[clip]});assert.equal(clip.duration,1/30);
  const word=clip.captionWords![0];assert.ok(Math.abs(clip.start+word.start-cue.start)<1e-10);assert.ok(Math.abs(clip.start+word.end-cue.end)<1e-10);
  assert.deepEqual(toCues({...project,clips:[clip]})[0].words,cue.words);
  const offset=cuesToClips([{...cue,start:.039,end:.04,words:cue.words.map(w=>({...w,start:.039,end:.04}))}],'text-1',project,8,{start:8,end:8.04})[0];assert.deepEqual(offset.captionWords,clip.captionWords);
});
test('speed changes scale local words and animation durations without modifying shared snapshots',()=>{
  const clip=fixture(),next=changeClipSpeed(clip,2,30);assertProject({...newProject(),clips:[next]});assert.equal(next.captionWords![1].start,.4);assert.equal(next.captionAnimation!.entrySeconds,.09);assert.equal(clip.captionWords![1].start,.8);
});
test('format4 rejects malformed rich metadata and older versions cannot silently lose it',()=>{
  const clip=fixture(),project={...newProject(),clips:[clip],transitions:[]};assertProject(project);
  for(const version of [1,2,3])assert.throws(()=>assertProject({...project,version}));
  for(const captionStyle of [{...clip.captionStyle,font:'unknown'},{...clip.captionStyle,maxWidth:0},{...clip.captionStyle,highlightEstimated:'true'},{...clip.captionStyle,outlineColor:'url(x)'}])assert.throws(()=>assertProject({...project,clips:[{...clip,captionStyle}]}));
  assert.throws(()=>assertProject({...project,clips:[{...clip,captionAnimation:{...clip.captionAnimation,entrySeconds:Infinity}}]}));
});
test('autosave/recovery preserves literal text, rich style, words and effect envelope',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'slu-caption-data-'));
  try{const clip=trimClip(fixture(),.4,2.8),project={...newProject(),clips:[clip]};await saveRecovery(root,project);assert.deepEqual(await loadRecovery(root,project.id),JSON.parse(JSON.stringify(project)));const raw=await readFile(path.join(root,'recovery.sluproj'),'utf8');assert.equal(JSON.parse(raw).version,10);}finally{await rm(root,{recursive:true,force:true});}
});
