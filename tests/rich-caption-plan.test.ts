import test from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newClip,projectDuration} from '../shared/project';
import {defaultCaptionStyle} from '../shared/captions';
import {captionLayerGroups} from '../electron/render-captions';
import {planRenderWindows} from '../electron/render-plan';
import type {ExportSettings} from '../shared/types';
const settings:ExportSettings={width:320,height:180,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'standard'};

test('rich/legacy caption groups preserve stable track/start ordering and visibility',()=>{
  const p=newProject();p.tracks=[...p.tracks,{...p.tracks.find(t=>t.type==='text')!,id:'upper'}];
  const a=newClip('text-1'),b=newClip('text-1'),c=newClip('upper');a.text='A';b.text='B';c.text='C';a.start=1;b.start=.5;b.captionStyle=defaultCaptionStyle();p.clips=[c,a,b];
  assert.deepEqual(captionLayerGroups(p,0,3).map(group=>[group.rich,group.clips.map(clip=>clip.text)]),[[true,['B']],[false,['A','C']]]);
  p.tracks.find(t=>t.id==='upper')!.hidden=true;assert.deepEqual(captionLayerGroups(p,0,3).flatMap(group=>group.clips.map(clip=>clip.text)),['B','A']);
});

test('10,000 sequential alternating captions produce bounded stream groups without losing frames',()=>{
  const p=newProject();p.width=320;p.height=180;p.fps=30;p.clips=Array.from({length:10000},(_,i)=>({...newClip('text-1'),text:`Caption ${i}`,start:i/10,duration:.1,...(i%2?{captionStyle:defaultCaptionStyle()}:{})}));
  const windows=planRenderWindows(p,settings);assert.equal(windows.reduce((sum,w)=>sum+w.frames,0),Math.ceil(projectDuration(p)*30-1e-7));
  for(const [index,window] of windows.entries()){assert.ok(captionLayerGroups(p,window.start,window.start+window.duration).filter(group=>group.rich).length<=8);if(index)assert.equal(window.startFrame,windows[index-1].startFrame+windows[index-1].frames);}
});
