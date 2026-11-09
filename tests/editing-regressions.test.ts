import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newClip,splitClip,interpolate,keyframeBase,localizeEnvelope} from '../shared/project';
import {assertProject} from '../shared/validation';
import {applyEnhancement} from '../shared/processing';
import {estimateCaptionWords,assertCaptionWords} from '../shared/captions';
import {insertFreeze} from '../src/freeze';
import {fadeAt} from '../src/preview/math';
import {transitionHitRegions} from '../src/preview/renderer';
import type {Clip,MediaAsset,Transition} from '../shared/types';

const media:MediaAsset={id:'video',path:'C:/clip.mp4',name:'clip',kind:'video',width:1920,height:1080,duration:30,fps:30,hasAudio:true};

test('splitting a keyframed clip twice keeps trimmed easing intervals inside [0,1]',()=>{
  const project=newProject(),track=project.tracks.find(t=>t.type==='text')!;
  const clip:Clip={...newClip(track.id),id:'text',text:'hi',duration:2,keyframes:[{time:0,x:0,y:0,scale:1,opacity:1,rotation:0},{time:2,x:100,y:0,scale:1,opacity:1,rotation:0}]};
  const [first,rest]=splitClip(clip,.4)!,[second,third]=splitClip(rest,0.43333333333333335)!;
  project.clips=[first,second,third];assert.doesNotThrow(()=>assertProject(project));
  for(const key of third.keyframes)assert.ok((key.easingEnd??1)<=1&&(key.easingStart??0)>=0);
});

test('estimated caption words end exactly at the clip end',()=>{
  const clip:Clip={...newClip('text-1'),text:'one two three',duration:1.6};
  const words=estimateCaptionWords(clip);assert.equal(words.at(-1)!.end,1.6);assert.doesNotThrow(()=>assertCaptionWords(clip.text!,words,0,clip.duration));
});

test('a freeze frame of an AI-enhanced clip drops the enhancement link and still validates',()=>{
  const project=newProject(),derived:MediaAsset={...media,id:'enhanced',path:'C:/clip-x2.mp4'},image:MediaAsset={...media,id:'still',path:'C:/frame.png',kind:'image',hasAudio:false,fps:0,duration:5};
  project.fps=30;project.media=[media,derived];project.clips=[applyEnhancement({...newClip('video-1',media),id:'clip',duration:4},derived,2)];
  const result=insertFreeze(project,'clip',2,1,image);assert.equal(result.clip.enhancement,undefined);assert.doesNotThrow(()=>assertProject(result.project));
});

test('editing one fade of a split piece keeps the cut free of fades',()=>{
  const clip:Clip={...newClip('video-1',media),duration:10,fadeIn:1,fadeOut:1};
  const [left,right]=splitClip(clip,5)!;
  const editedLeft={...left,...localizeEnvelope(left),fadeIn:1.1},editedRight={...right,...localizeEnvelope(right),fadeOut:.8};
  assert.equal(fadeAt(editedLeft,4.99),1);assert.equal(fadeAt(editedRight,0),1);
  assert.ok(fadeAt(editedLeft,0)<.01);assert.ok(fadeAt(editedRight,4.99)<.02);
  // Partially visible fades keep their remaining length.
  const [, late]=splitClip({...clip,fadeIn:2},1)!;assert.equal(localizeEnvelope(late).fadeIn,1);
});

test('replacing a keyframe keeps its easing',()=>{
  const clip:Clip={...newClip('video-1',media),duration:3,keyframes:[{time:0,x:0,y:0,scale:1,opacity:1,rotation:0},{time:1,x:100,y:0,scale:1,opacity:1,rotation:0,easing:'hold'},{time:2,x:500,y:0,scale:1,opacity:1,rotation:0}]};
  const edited={...clip,keyframes:clip.keyframes.map(k=>k.time===1?{...keyframeBase(clip,1,1/60),x:150}:k)};
  assert.equal(edited.keyframes[1].easing,'hold');assert.equal(interpolate(edited,1.5).x,150);
});

test('hit regions inside a transition are marked so drags do not snap to the transient box',()=>{
  const region={clip:{...newClip('video-1',media)},geometry:{size:[100,100] as [number,number],offset:[0,0] as [number,number],center:[50,50] as [number,number],scale:[1,1] as [number,number],rotation:0,uv:[0,0,1,1] as [number,number,number,number]}};
  const transition={id:'t',fromClipId:'a',toClipId:'b',kind:'zoom',durationFrames:15} as Transition;
  assert.ok(transitionHitRegions({width:100,height:100},transition,.5,[region],[region]).every(r=>r.transition));
  assert.equal(transitionHitRegions({width:100,height:100},transition,0,[region],[region])[0].transition,undefined);
});
