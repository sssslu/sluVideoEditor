import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {defaultCaptionStyle} from '../shared/captions';
import {replaceCaptionText} from '../src/captions/replace';

test('literal caption replacement changes all unlocked matches and clears only their word alignment',()=>{
  const track={...newProject().tracks[0],id:'captions',type:'text' as const},locked={...track,id:'locked',locked:true};
  const clip={...newClip(track.id),text:'A.* A.*',captionStyle:defaultCaptionStyle(),captionWords:[{from:0,to:1,start:0,end:1,timing:'measured' as const}]};
  const other={...clip,id:'other',text:'a.*'},unchanged={...clip,id:'locked-caption',trackId:locked.id},project={...newProject(),tracks:[track,locked],clips:[clip,other,unchanged]},before=structuredClone(project);
  const result=replaceCaptionText(project,'A.*','$&');
  assert.equal(result.changedClips,1);assert.equal(result.occurrences,2);assert.equal(result.lockedMatches,2);
  assert.equal(result.project.clips[0].text,'$& $&');assert.equal(result.project.clips[0].captionWords,undefined);
  assert.equal(result.project.clips[0].captionStyle,clip.captionStyle);assert.equal(result.project.clips[0].start,clip.start);assert.equal(result.project.clips[0].duration,clip.duration);
  assert.equal(result.project.clips[1],other);assert.equal(result.project.clips[2],unchanged);assert.deepEqual(project,before);
});

test('no match, identical text and empty search keep the same project; deletion is literal',()=>{
  const project={...newProject(),clips:[{...newClip('video-1'),text:'앞 삭제 뒤'}]};
  for(const [find,replacement] of [['없음','새'],['앞','앞'],['','새']])assert.equal(replaceCaptionText(project,find,replacement).project,project);
  assert.equal(replaceCaptionText(project,'삭제 ','').project.clips[0].text,'앞 뒤');
});

test('an oversized replacement fails atomically before publishing any edited project',()=>{
  const clip={...newClip('video-1'),text:'a'},project={...newProject(),clips:[clip,{...clip,id:'long',text:'a'.repeat(20000)}]},before=structuredClone(project);
  assert.throws(()=>replaceCaptionText(project,'a','bb'),/20,000자/);assert.deepEqual(project,before);
  assert.throws(()=>replaceCaptionText(project,'a','\0'),/널 문자/);assert.deepEqual(project,before);
});
