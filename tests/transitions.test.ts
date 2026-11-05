import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {assertProject} from '../shared/validation';
import {compileTransitions,transitionAudioWeight,transitionBounds,transitionGain,transitionPixel,transitionProgress,visualNodesAt} from '../shared/transitions';
import type {MediaAsset,Transition} from '../shared/types';

const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
function fixture(){
  const project=newProject(),media:MediaAsset={id:'source',path:'C:/source.mp4',name:'source',kind:'video',duration:20,width:320,height:180,fps:30,hasAudio:true,videoStart:0,videoEnd:20};
  const a={...newClip('video-1',media),id:'a',in:2,duration:4},b={...newClip('video-1',media,4),id:'b',in:5,duration:4};
  project.media=[media];project.clips=[a,b];return {project,media,a,b};
}
const transition=(frames=31):Transition=>({id:'ab',fromClipId:'a',toClipId:'b',kind:'dissolve',durationFrames:frames,audio:'linear'});

test('centered transition exposure preserves original clips, odd-frame placement and project duration',()=>{
  const {project,a,b}=fixture();a.fadeOut=3.5;a.keyframes=[{time:0,x:0,y:0,scale:1,opacity:1,rotation:0},{time:4,x:80,y:20,scale:1.3,opacity:.6,rotation:5}];
  const original=JSON.stringify(project.clips);project.transitions=[transition()];assertProject(project);
  const plan=compileTransitions(project),t=plan.transitions[0];near(t.start,3.5);near(t.end,4+16/30);near(transitionProgress(t,t.start),0);near(transitionProgress(t,t.end),1);
  near(plan.byClip.get('a')!.visualTo,4+16/30);near(plan.byClip.get('b')!.visualFrom,-.5);assert.equal(JSON.stringify(project.clips),original);
  const nodes=visualNodesAt(plan,4);assert.equal(nodes.length,1);assert.equal(nodes[0].type,'transition');assert.equal(visualNodesAt(plan,1)[0].type,'clip');assert.equal(visualNodesAt(plan,7)[0].type,'clip');
  delete project.transitions;assert.equal(JSON.stringify(project.clips),original);assert.deepEqual(compileTransitions(project).byClip.get(b.id)!.transitions,[]);
});
test('video handles require actual stream bounds and never borrow trailing audio duration',()=>{
  const {project,media,a,b}=fixture();media.videoEnd=6;assert.equal(transitionBounds(project,a.id,b.id).maxFrames,0);
  media.videoEnd=6+1/30;assert.equal(transitionBounds(project,a.id,b.id).maxFrames,2);
  project.transitions=[transition(3)];assert.throws(()=>assertProject(project),/전환 길이/);
  project.transitions=[transition(2)];assertProject(project);
  delete project.transitions;delete media.videoStart;delete media.videoEnd;assert.deepEqual(transitionBounds(project,a.id,b.id).pendingMediaIds,[media.id]);
  media.videoStart=5.5;media.videoEnd=20;assert.equal(transitionBounds(project,a.id,b.id).maxFrames,0);
});
test('nonlinear source handles, 64-point curves and image handles stay on original clocks',()=>{
  const {project,media,a,b}=fixture();a.speedCurve=[{position:0,speed:.5},{position:1,speed:2}];b.speedCurve=Array.from({length:64},(_,i)=>({position:i/63,speed:i%2?2:.5}));
  a.in=1;media.videoEnd=6+2/30;b.in=4;const original=JSON.stringify(project.clips);
  assert.equal(transitionBounds(project,a.id,b.id).maxFrames,2);project.transitions=[transition(2)];assertProject(project);assert.equal(JSON.stringify(project.clips),original);assert.equal(b.speedCurve.length,64);
  project.transitions=undefined;media.kind='image';delete media.videoStart;delete media.videoEnd;assert.equal(transitionBounds(project,a.id,b.id).maxFrames,240);
});
test('shared middle clips have one exposure and reject overlapping transitions or third clips',()=>{
  const {project,media,a,b}=fixture();const c={...newClip('video-1',media,8),id:'c',in:5,duration:4};project.clips.push(c);
  project.transitions=[transition(120),{...transition(120),id:'bc',fromClipId:'b',toClipId:'c'}];const plan=compileTransitions(project);
  assert.equal(plan.byClip.size,3);near(plan.byClip.get('b')!.visualFrom,-2);near(plan.byClip.get('b')!.visualTo,6);assert.equal(plan.byClip.get('b')!.transitions.length,2);
  project.transitions[1].durationFrames=121;compileTransitions(project);project.transitions[1].durationFrames=122;assert.throws(()=>compileTransitions(project),/겹칠/);
  project.transitions=[transition(30)];project.clips.push({...newClip('video-1',media,3.8),id:'overlap',duration:.4});assert.throws(()=>compileTransitions(project),/겹쳐/);
  project.clips.pop();project.transitions=[transition(),{...transition(),id:'duplicate'}];assert.throws(()=>compileTransitions(project),/중복/);
  project.transitions=[{...transition(),fromClipId:'missing'}];assert.throws(()=>compileTransitions(project),/참조/);
  project.transitions=[transition()];project.version=2;assert.throws(()=>assertProject(project),/형식 3/);
});
test('linear, equal-power and no-audio modes preserve expected gain and original cut activation',()=>{
  const {project}=fixture();project.transitions=[transition(30)];let plan=compileTransitions(project),item=plan.transitions[0];
  near(transitionGain(plan,'a',4),.5);near(transitionGain(plan,'b',4),.5);near(transitionGain(plan,'a',2),1);
  project.transitions[0].audio='equal-power';plan=compileTransitions(project);item=plan.transitions[0];near(transitionAudioWeight(item,'from',4),Math.SQRT1_2);near(transitionAudioWeight(item,'to',4),Math.SQRT1_2);
  project.transitions[0].audio='none';plan=compileTransitions(project);item=plan.transitions[0];near(plan.byClip.get('a')!.audioTo,4);near(plan.byClip.get('b')!.audioFrom,0);near(transitionAudioWeight(item,'from',4),0);near(transitionAudioWeight(item,'to',4),1);
  project.tracks[0].hidden=true;assert.deepEqual(visualNodesAt(plan,4),[]);project.tracks[0].hidden=false;project.tracks[0].locked=true;assertProject(project);
});
test('premultiplied transition pixels preserve endpoints, alpha and half-open slide seams',()=>{
  const a=()=>[1,0,0,1],b=()=>[0,0,1,1];
  for(const kind of ['dissolve','wipe','slide','zoom'] as const)for(const direction of ['left','right','up','down'] as const){
    assert.deepEqual(transitionPixel(kind,0,direction,.5,.5,a,b),a());assert.deepEqual(transitionPixel(kind,1,direction,.5,.5,a,b),b());
    const color=transitionPixel(kind,.5,direction,.5,.5,a,b);near(color[3],1);assert.ok(color.every(v=>v>=0&&v<=1));
  }
  assert.deepEqual(transitionPixel('dissolve',.5,'left',.5,.5,a,b),[.5,0,.5,1]);
  const transparent=transitionPixel('dissolve',.5,'left',.5,.5,()=>[.5,0,0,.5],()=>[0,0,.25,.25]);assert.deepEqual(transparent,[.25,0,.125,.375]);
  assert.deepEqual([transparent[0],1-transparent[3],transparent[2],1],[.25,.625,.125,1]);
});
