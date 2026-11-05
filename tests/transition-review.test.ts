import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject,trimClip} from '../shared/project';
import {compileTransitions,transitionBounds} from '../shared/transitions';
import {reconcileTransitions} from '../shared/transition-edits';
import {clipSourceTime} from '../shared/speed';
import type {Clip,MediaAsset,Project,SpeedPoint} from '../shared/types';

const media:MediaAsset={id:'m',name:'m',path:'C:/review.mp4',kind:'video',duration:40,videoStart:0,videoEnd:40,width:320,height:180,fps:30,hasAudio:true};
function chain(count:number):Project {
 const p=newProject();p.media=[{...media}];p.clips=Array.from({length:count},(_,i)=>({...newClip('video-1',media,i*2),id:`c${i}`,in:5,duration:2}));
 p.transitions=p.clips.slice(1).map((c,i)=>({id:`t${i}`,fromClipId:`c${i}`,toClipId:c.id,kind:'dissolve',durationFrames:15}));return p;
}

test('indexed handle and collision bounds match direct frame-window checks over varied source clocks',()=>{
 let state=71693;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
 for(let trial=0;trial<500;trial++){
  const p=chain(2);p.transitions=undefined;p.fps=[24,25,30,50,60][trial%5];
  const a=p.clips[0],b=p.clips[1];a.duration=4;b.start=4;b.duration=4;
  for(const c of [a,b]){
   c.in=random()*8;c.speed=.25+random()*1.75;
   if(random()<.5)c.speedCurve=[{position:0,speed:.25+random()*1.75},{position:.37,speed:.25+random()*1.75},{position:1,speed:.25+random()*1.75}];
  }
  p.media[0].videoStart=random()*3;p.media[0].videoEnd=7+random()*12;
  const third:Clip[]=Array.from({length:trial%7},(_,i)=>({...newClip('video-1',media,random()*10),id:`other${i}`,duration:.1+random()*4}));
  p.clips.push(...third);
  let expected=0;
  for(let frames=1;frames<=8*p.fps;frames++){
   const pre=Math.floor(frames/2)/p.fps,post=Math.ceil(frames/2)/p.fps,start=4-pre,end=4+post;
   const valid=start>=0&&end<=8&&
    clipSourceTime(a,4-pre)>=p.media[0].videoStart!&&clipSourceTime(a,4+post)<=p.media[0].videoEnd!&&
    clipSourceTime(b,-pre)>=p.media[0].videoStart!&&clipSourceTime(b,post)<=p.media[0].videoEnd!&&
    third.every(c=>c.start>=end||c.start+c.duration<=start);
   if(valid)expected=frames;
  }
  assert.equal(transitionBounds(p,a.id,b.id).maxFrames,expected,`trial ${trial}`);
 }
});

test('a changed speed curve cannot masquerade as an unchanged split by matching five sample positions',()=>{
 const p=chain(2),original={...p.clips[0],duration:4};p.clips=[original,{...p.clips[1],start:4}];
 const left=trimClip(original,0,2),right={...trimClip(original,2,4),id:'new-right'};
 const curve:SpeedPoint[]=[];
 for(let quarter=0;quarter<4;quarter++)for(const [position,speed] of [[0,1],[.0625,1.5],[.125,1],[.1875,.5]] as const)curve.push({position:quarter*.25+position,speed});
 curve.push({position:1,speed:1});right.speedCurve=curve;
 for(const fraction of [0,.25,.5,.75,1])assert.ok(Math.abs(clipSourceTime(right,2*fraction)-clipSourceTime(original,2+2*fraction))<1e-8);
 assert.ok(Math.abs(clipSourceTime(right,.125)-clipSourceTime(original,2.125))>.03);
 const result=reconcileTransitions(p,{...p,clips:[left,right,p.clips[1]]});
 assert.deepEqual(result.detached,['t0']);assert.equal(result.project.transitions,undefined);
});

test('disconnecting many existing cuts does not repeatedly scan the entire clip array for new split pieces',()=>{
 const count=1000,p=chain(count),moved=p.clips.map((c,i)=>i%2?{...c,start:c.start+1/30}:c);let numericReads=0;
 const clips=new Proxy(moved,{get(target,property,receiver){if(typeof property==='string'&&/^\d+$/.test(property))numericReads++;return Reflect.get(target,property,receiver);}});
 const result=reconcileTransitions(p,{...p,clips});assert.equal(result.detached.length,count-1);compileTransitions(result.project);
 assert.ok(numericReads<count*100,`${numericReads} indexed clip reads for ${count} clips; a nudge creates no new split pieces`);
});
