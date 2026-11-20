import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import type {MediaAsset} from '../shared/types';
import {applyLoudnessResult,loudnessSelection,loudnessSignature,loudnessSummary,matchedVolume} from '../shared/loudness';

const fixture=()=>{
  const project=newProject(),media:MediaAsset={id:'audio',name:'voice.wav',path:'C:\\voice.wav',kind:'audio',duration:20,width:0,height:0,fps:0,hasAudio:true,sourceRevision:'source'};
  project.media=[media];project.clips=[{...newClip('audio-1',media),id:'first',duration:3},{...newClip('audio-1',media,4),id:'second',duration:3}];return project;
};

test('loudness matching targets integrated volume while respecting true peaks and existing 800% range',()=>{
  const normal=matchedVolume(.5,-22,-14);assert.ok(Math.abs(normal.volume!-.5*10**(6/20))<1e-12);assert.equal(normal.limited,undefined);
  const peak=matchedVolume(1,-25,-3);assert.equal(peak.limited,'peak');assert.ok(-3+20*Math.log10(peak.volume!)<=-1);assert.ok(peak.volume!<1.26);
  const capped=matchedVolume(1,-50,-40);assert.ok(Math.abs(capped.volume!-8)<1e-12);assert.equal(capped.limited,'volume');
  const hot=matchedVolume(2,-10,3);assert.equal(hot.limited,undefined);assert.ok(Math.abs(hot.volume!-2*10**(-6/20))<1e-12);
  for(const values of [[0,-20,-3],[9,-20,-3],[1,NaN,-3],[1,-Infinity,-3],[1,-20,Infinity]])assert.throws(()=>matchedVolume(...values as [number,number,number]));
});

test('loudness selection respects locked tracks, audio solo, mute, text and missing audio without unmuting',()=>{
  const p=fixture();assert.deepEqual(loudnessSelection(p,['first']).map(x=>x.skip),[undefined]);
  p.tracks.find(t=>t.id==='audio-1')!.locked=true;assert.equal(loudnessSelection(p,['first'])[0].skip,'locked');
  p.tracks.find(t=>t.id==='audio-1')!.locked=false;p.tracks.find(t=>t.id==='video-1')!.solo=true;assert.equal(loudnessSelection(p,['first'])[0].skip,'muted');
  p.tracks.find(t=>t.id==='video-1')!.solo=false;p.clips[0].volume=0;assert.equal(loudnessSelection(p,['first'])[0].skip,'muted');
  p.clips[0].volume=1;p.media[0].hasAudio=false;assert.equal(loudnessSelection(p,['first'])[0].skip,'no-audio');
  for(const ids of [[],['missing'],['first','first']])assert.throws(()=>loudnessSelection(p,ids));
});

test('loudness batch replaces all measured gains immutably and does not record an unchanged result',()=>{
  const p=fixture(),ids=['first','second'],signature=loudnessSignature(p,ids),before=JSON.stringify(p),result={items:[{clipId:'first',volume:.7},{clipId:'second',volume:2}]};
  const next=applyLoudnessResult(p,ids,signature,result);assert.equal(JSON.stringify(p),before);assert.deepEqual(next.clips.map(c=>c.volume),[.7,2]);assert.equal(next.media,p.media);assert.equal(next.tracks,p.tracks);
  const unchanged=applyLoudnessResult(p,ids,signature,{items:p.clips.map(c=>({clipId:c.id,volume:c.volume}))});assert.equal(unchanged,p);
});

test('pending loudness rejects changed audio/source/track inputs while allowing names, color and derivative readiness',()=>{
  const p=fixture(),ids=['first'],signature=loudnessSignature(p,ids),result={items:[{clipId:'first',volume:.7}]};
  const cosmetic=structuredClone(p);cosmetic.clips[0].name='Renamed';cosmetic.clips[0].brightness=.2;cosmetic.media[0].proxyPath='C:\\proxy.mp4';cosmetic.media[0].waveform=[.2];assert.doesNotThrow(()=>applyLoudnessResult(cosmetic,ids,signature,result));
  for(const mutate of [(q:typeof p)=>q.clips[0].in++, (q:typeof p)=>q.clips[0].volume=.9,(q:typeof p)=>q.clips[0].fadeIn=.2,(q:typeof p)=>q.clips[0].speed=2,(q:typeof p)=>q.media[0].sourceRevision='replaced',(q:typeof p)=>q.tracks.find(t=>t.id==='audio-1')!.locked=true,(q:typeof p)=>q.tracks.find(t=>t.id==='video-1')!.solo=true]){
    const changed=structuredClone(p);mutate(changed);assert.throws(()=>applyLoudnessResult(changed,ids,signature,result),/분석 중/);
  }
});

test('loudness rejects malformed/duplicate/unauthorized results and reports every excluded or limited class',()=>{
  const p=fixture(),ids=['first'],signature=loudnessSignature(p,ids);
  for(const items of [[],[{clipId:'wrong',volume:1}],[{clipId:'first',volume:9}],[{clipId:'first',volume:NaN}],[{clipId:'first',volume:1,skip:'silent' as const}],[{clipId:'first',volume:1},{clipId:'first',volume:2}]])assert.throws(()=>applyLoudnessResult(p,ids,signature,{items}),/올바르지/);
  p.tracks.find(t=>t.id==='audio-1')!.locked=true;assert.throws(()=>applyLoudnessResult(p,ids,loudnessSignature(p,ids),{items:[{clipId:'first',volume:1}]}),/올바르지/);
  const message=loudnessSummary({items:[{clipId:'a',volume:2,limited:'peak'},{clipId:'b',volume:8,limited:'volume'},{clipId:'c',skip:'locked'},{clipId:'d',skip:'short'},{clipId:'e',skip:'silent'}]});
  for(const text of ['2개 클립','피크 제한 1개','800% 제한 1개','잠김 1개','0.4초 미만 1개','무음·측정 불가 1개'])assert.ok(message.includes(text),message);
});
