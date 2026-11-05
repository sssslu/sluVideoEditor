import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {newProject,newClip,trimClip} from '../shared/project';
import {compileTransitions,transitionBounds} from '../shared/transitions';
import {reconcileTransitions} from '../shared/transition-edits';
import {clipSourceTime} from '../shared/speed';
import type {MediaAsset,Project,SpeedPoint} from '../shared/types';

const media:MediaAsset={id:'m',name:'m',path:'C:/review.mp4',kind:'video',duration:40,videoStart:0,videoEnd:40,width:320,height:180,fps:30,hasAudio:true};
function chain(count:number):Project {
 const p=newProject();p.media=[media];p.clips=Array.from({length:count},(_,i)=>({...newClip('video-1',media,i*2),id:`c${i}`,in:5,duration:2}));
 p.transitions=p.clips.slice(1).map((c,i)=>({id:`t${i}`,fromClipId:`c${i}`,toClipId:c.id,kind:'dissolve',durationFrames:15}));return p;
}
const timings=[];
for(const count of [1000,10000]){
 const p=chain(count);let start=performance.now();compileTransitions(p);const compileMs=performance.now()-start;
 start=performance.now();transitionBounds(p,'c10','c11','t10');const boundsMs=performance.now()-start;
 start=performance.now();reconcileTransitions(p,{...p,clips:p.clips.map((c,i)=>i%2?{...c,start:c.start+1/30}:c)});const disconnectedEditMs=performance.now()-start;
 timings.push({clips:count,transitions:count-1,compileMs,boundsMs,disconnectedEditMs});
}

// Source-time equality at five sampled positions does not establish equality
// for a 64-point speed curve; each quarter can contain a zero-integral bump.
const p=chain(2),original={...p.clips[0],duration:4};p.clips=[original,{...p.clips[1],start:4}];
const left=trimClip(original,0,2),right={...trimClip(original,2,4),id:'new-right'};
const curve:SpeedPoint[]=[];
for(let quarter=0;quarter<4;quarter++)for(const [position,speed] of [[0,1],[.0625,1.5],[.125,1],[.1875,.5]] as const)curve.push({position:quarter*.25+position,speed});
curve.push({position:1,speed:1});right.speedCurve=curve;
const sampled=[0,.25,.5,.75,1].map(fraction=>clipSourceTime(right,right.duration*fraction)-clipSourceTime(original,2+right.duration*fraction));
const interiorDifference=clipSourceTime(right,right.duration*.0625)-clipSourceTime(original,2+right.duration*.0625);
const result=reconcileTransitions(p,{...p,clips:[left,right,p.clips[1]]});
assert.ok(Math.abs(interiorDifference)>.01);assert.ok(sampled.every(value=>Math.abs(value)<1e-8));
const alias={sampled,interiorDifference,retargeted:result.project.transitions?.[0]?.fromClipId===right.id,detached:result.detached};
const directory=path.resolve('.test-artifacts/transition-review');await fs.mkdir(directory,{recursive:true});
await fs.writeFile(path.join(directory,'results.json'),JSON.stringify({date:new Date().toISOString(),timings,alias},null,2));
console.log(JSON.stringify({timings,alias},null,2));
