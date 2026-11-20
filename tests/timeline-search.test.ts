import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {findTimelineClips,includeTimelineSearchTarget,revealTimelineClip,selectTimelineSearchResult} from '../src/timeline-search';

test('timeline finder searches all tracks, preserves duplicate names and includes hidden/locked text',()=>{
  const track={...newProject().tracks[0],id:'a',name:'같은 트랙'},other={...track,id:'b',locked:true,hidden:true};
  const first={...newClip('a'),id:'first',name:'Same Name',text:undefined,start:300},duplicate={...first,id:'duplicate',trackId:'b'},caption={...newClip('b'),id:'caption',name:'자막',text:'화면 밖의 한글 문장',start:500};
  const clips=[duplicate,caption,first],before=structuredClone(clips);
  assert.deepEqual(findTimelineClips(clips,[track,other],'  SAME name ').map(row=>[row.clip.id,row.trackIndex]),[['first',0],['duplicate',1]]);
  const result=findTimelineClips(clips,[track,other],'한글');assert.equal(result[0].clip.id,'caption');assert.equal(result[0].track.locked,true);assert.equal(result[0].track.hidden,true);
  assert.deepEqual(findTimelineClips(clips,[track,other],'한글'.normalize('NFD')).map(row=>row.clip.id),['caption']);
  assert.equal(findTimelineClips(clips,[track,other],'같은 트랙').length,3);
  assert.deepEqual(findTimelineClips(clips,[track,other],'트랙 2').map(row=>row.clip.id),['duplicate','caption']);
  assert.deepEqual(findTimelineClips(clips,[{...track,name:'이름은 트랙 2'},other],'트랙 2').map(row=>row.clip.id),['duplicate','caption'],'Explicit visual track numbers must not also match a different track name');
  assert.deepEqual(findTimelineClips(clips,[track,other],'00:08:20:00').map(row=>row.clip.id),['caption']);
  assert.deepEqual(findTimelineClips(clips,[track,other],'500초').map(row=>row.clip.id),['caption']);
  assert.deepEqual(findTimelineClips(clips,[track,other],'  '),[]);assert.deepEqual(findTimelineClips(clips,[track,other],'없는 이름'),[]);assert.deepEqual(clips,before);
});

test('finder reveals a distant track and keeps its target even if overview clips were collapsed',()=>{
  const clip={...newClip('video-1'),id:'chosen',start:3600,duration:.01};
  const view=revealTimelineClip(clip.start,100,{top:1200,height:64},{width:1000,height:240},172,30);
  assert.ok(clip.start*100>=view.left);assert.ok(clip.start*100<=view.left+1000-172);
  assert.ok(1200>=view.top+30);assert.ok(1264<=view.top+240);
  assert.deepEqual(revealTimelineClip(0,1,{top:30,height:64},{width:1000,height:240},172,30),{left:0,top:0});
  const other={...clip,id:'other'},visible=[other];
  assert.deepEqual(includeTimelineSearchTarget(visible,[other,clip],'chosen',359999,360001,100).map(value=>value.id),['other','chosen']);
  assert.equal(includeTimelineSearchTarget(visible,[other,clip],'other',359999,360001,100),visible);
  assert.equal(includeTimelineSearchTarget(visible,[other,clip],'chosen',0,1000,100),visible);
});

test('a 10,000-clip project still finds the last match without requiring a mounted timeline item',()=>{
  const track=newProject().tracks[0],seed=newClip(track.id),clips=Array.from({length:10000},(_,i)=>({...seed,id:`clip-${i}`,name:`장면 ${i}`,start:i*8,text:undefined}));
  assert.deepEqual(findTimelineClips(clips,[track],'장면 9999').map(row=>row.clip.id),['clip-9999']);
});

test('adding a found clip retains valid prior selections once, even for duplicate names on different tracks',()=>{
  const clip={...newClip('a'),id:'first',name:'중복'},other={...clip,id:'second',trackId:'b',start:300};
  assert.deepEqual(selectTimelineSearchResult([clip,other],['first','first','missing'],'second',true),['first','second']);
  assert.deepEqual(selectTimelineSearchResult([clip,other],['first','second'],'second',true),['first','second']);
  assert.deepEqual(selectTimelineSearchResult([clip,other],['first'],'second',false),['second']);
});
