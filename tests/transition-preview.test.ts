import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {compileTransitions,transitionGain,visualNodesAt} from '../shared/transitions';
import {clipSourceTime} from '../shared/speed';
import {clipState,planMedia,sourceTime} from '../src/preview/math';
import type {MediaAsset,Transition} from '../shared/types';
import {hitTest,transitionHitRegions,type HitRegion} from '../src/preview/renderer';

const media:MediaAsset={id:'source',path:'C:/source.mp4',name:'source',kind:'video',duration:20,width:640,height:360,fps:30,hasAudio:true,videoStart:0,videoEnd:20};
function fixture(){const project=newProject();project.media=[media];project.clips=[0,1,2].map(i=>({...newClip('video-1',media,i*2),id:`clip-${i}`,duration:2,in:2+i*3,speedCurve:[{position:0,speed:.5},{position:1,speed:1.5}],fadeIn:.2,fadeOut:.2}));project.transitions=[0,1].map(i=>({id:`transition-${i}`,fromClipId:`clip-${i}`,toClipId:`clip-${i+1}`,kind:'dissolve',durationFrames:30}));return project;}

test('transition decoder plan extends exposure without replacing original clips or duplicating shared middle clip',()=>{
 const project=fixture(),before=JSON.stringify(project),plan=compileTransitions(project),middle=project.clips[1];
 assert.equal(plan.byClip.get(middle.id)!.visualFrom,-.5);assert.equal(plan.byClip.get(middle.id)!.visualTo,2.5);
 for(const time of [1.5,1.75,2,2.49,3.5,4,4.49]){const active=planMedia(project,time,32,1.2,plan).media;assert.equal(active.filter(n=>n.clip.id===middle.id).length,1);assert.equal(active.find(n=>n.clip.id===middle.id)!.clip,middle);}
 assert.equal(JSON.stringify(project),before);assert.equal(visualNodesAt(plan,2).filter(n=>n.type==='transition').length,1);
});

test('transition pre-roll and post-roll seek exact nonlinear source time while ordinary seeks remain clamped',()=>{
 const project=fixture(),plan=compileTransitions(project),[a,b]=project.clips,exposureA=plan.byClip.get(a.id)!,exposureB=plan.byClip.get(b.id)!;
 assert.equal(sourceTime(b,1.75,media),b.in);
 assert.equal(sourceTime(b,1.75,media,exposureB),clipSourceTime(b,-.25));
 assert.equal(sourceTime(a,2.25,media,exposureA),clipSourceTime(a,2.25));
 assert.equal(sourceTime(b,0,media,exposureB),clipSourceTime(b,-.5));
 assert.equal(clipState(a,2.25).opacity,clipState(a,2).opacity);
 assert.equal(clipState(b,1.75).opacity,clipState(b,2).opacity);
});

test('audio-none transition still preloads both visual participants but does not extend audio exposure',()=>{
 const project=fixture();project.transitions=project.transitions!.map(t=>({...t,audio:'none' as const}));const plan=compileTransitions(project),middle=project.clips[1],exposure=plan.byClip.get(middle.id)!;
 assert.equal(exposure.audioFrom,0);assert.equal(exposure.audioTo,2);assert.equal(exposure.visualFrom,-.5);assert.equal(exposure.visualTo,2.5);
 assert.equal(transitionGain(plan,middle.id,1.75),0);assert.equal(transitionGain(plan,middle.id,2.25),1);
 assert.equal(planMedia(project,1.75,32,1.2,plan).media.find(item=>item.clip.id===middle.id)?.active,true);
 project.tracks.find(t=>t.id==='video-1')!.hidden=true;
 assert.equal(planMedia(project,1.75,32,1.2,plan).media.find(item=>item.clip.id===middle.id)?.active,false);
});

test('transition exposure retains raw split-envelope phase while motion keyframes hold endpoints',()=>{
 const project=fixture(),clip={...project.clips[1],fadeIn:2,fadeOut:0,sourceClipOffset:1,sourceClipDuration:4,keyframes:[{time:0,x:20,y:0,scale:1,rotation:0,opacity:1},{time:2,x:50,y:0,scale:1,rotation:0,opacity:1}]};
 assert.equal(clipState(clip,clip.start-.5).opacity,.25);assert.equal(clipState(clip,clip.start).opacity,.5);assert.equal(clipState(clip,clip.start-.5).x,20);assert.equal(clipState(clip,clip.start+2.5).x,50);
});

test('pair visual node appears at its original track position and vanishes at exact transition endpoints',()=>{
 const project=fixture(),lower={...newClip('lower',media),id:'underlay',duration:6};project.tracks.unshift({id:'lower',name:'below',type:'video',muted:false,hidden:false,locked:false});project.clips.push(lower);const plan=compileTransitions(project);
 assert.equal(visualNodesAt(plan,1.499).at(-1)?.type,'clip');
 const start=visualNodesAt(plan,1.5);assert.equal(start[0].type,'clip');assert.equal(start[0].type==='clip'&&start[0].clip.id,lower.id);assert.equal(start[1].type,'transition');assert.equal(start[1].type==='transition'&&start[1].progress,0);
 assert.equal(visualNodesAt(plan,2.5).at(-1)?.type,'clip');
 const original=JSON.stringify(project.clips);for(const kind of ['dissolve','wipe','slide','zoom'] as Transition['kind'][]){project.transitions![0].kind=kind;visualNodesAt(compileTransitions(project),2);}assert.equal(JSON.stringify(project.clips),original);
});

test('transition hit regions select the visible participant and follow slide and zoom canvas transforms',()=>{
 const project=fixture(),from:HitRegion={clip:project.clips[0],geometry:{size:[100,100],offset:[0,0],center:[50,50],scale:[1,1],rotation:0,uv:[0,0,1,1]}},to:HitRegion={...from,clip:project.clips[1]};
 for(const kind of ['wipe','slide'] as const){const regions=transitionHitRegions({width:100,height:100},{...project.transitions![0],kind,direction:'left'},.5,[from],[to]);assert.equal(hitTest(regions,25,50)?.clip.id,from.clip.id);assert.equal(hitTest(regions,75,50)?.clip.id,to.clip.id);}
 assert.deepEqual(transitionHitRegions(project,project.transitions![0],0,[from],[to]),[from]);assert.deepEqual(transitionHitRegions(project,project.transitions![0],1,[from],[to]),[to]);
 const zoom=transitionHitRegions({width:100,height:100},{...project.transitions![0],kind:'zoom'},.5,[from],[{...to,geometry:{...to.geometry,center:[80,50],size:[20,20]}}]);assert.deepEqual(zoom[1].geometry.center,[76.25,50]);assert.deepEqual(zoom[1].geometry.scale,[.875,.875]);assert.equal(hitTest(zoom,84,50)?.clip.id,to.clip.id);assert.equal(hitTest(zoom,90,50)?.clip.id,from.clip.id);
});
