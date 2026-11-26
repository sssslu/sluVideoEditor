import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {defaultCaptionStyle,editCaptionText} from '../shared/captions';
import {assertProject} from '../shared/validation';
import {assertTextRuns,clearTextRunProperties,joinTextRuns,normalizeTextRuns,remapTextRuns,setTextRunStyle,sliceTextRuns,textRunAt,textRunFonts} from '../shared/text-runs';
import {refineWordTimes,applyCaptionSync,captionBreaks,captionTargets,mergeCaptions,mergeProjectCaptions,speechAudioProject,splitCaption,splitProjectCaptions,syncCaptionTimes} from '../shared/caption-timing';
import type {Clip,Project,SpeechWord} from '../shared/types';

const caption=(id:string,text:string,start:number,duration:number,extra:Partial<Clip>={}):Clip=>({...newClip('text-1'),id,name:text,text,start,duration,fontSize:48,captionStyle:defaultCaptionStyle(),animation:'none',...extra});
const project=(clips:Clip[]):Project=>({...newProject(),tracks:[{id:'video-1',name:'영상 1',type:'video',muted:false,hidden:false,locked:false},{id:'text-1',name:'자막',type:'text',muted:false,hidden:false,locked:false}],clips});

test('text runs: styling a range splits, merges and validates',()=>{
  const text='안녕하세요 반가워요';
  let runs=setTextRunStyle(text,undefined,0,5,{color:'#ff0000'});
  assert.deepEqual(runs,[{from:0,to:5,color:'#ff0000'}]);
  runs=setTextRunStyle(text,runs,3,8,{size:80});
  assert.deepEqual(runs,[{from:0,to:3,color:'#ff0000'},{from:3,to:5,color:'#ff0000',size:80},{from:5,to:8,size:80}]);
  assert.deepEqual(textRunAt(runs,4),{color:'#ff0000',size:80});
  // Clearing a property everywhere joins what is left.
  assert.deepEqual(clearTextRunProperties(text,runs,['size']),[{from:0,to:5,color:'#ff0000'}]);
  // Clearing every property of a range removes it.
  assert.deepEqual(setTextRunStyle(text,runs,0,8,{color:undefined,size:undefined}),undefined);
  assertTextRuns(text,runs!);
  assert.throws(()=>assertTextRuns(text,[{from:2,to:1,color:'#fff000'}]));
  assert.throws(()=>assertTextRuns(text,[{from:0,to:2}]));
  assert.throws(()=>assertTextRuns(text,[{from:0,to:2,color:'red'}]));
});

test('text runs: never split a grapheme and survive edits',()=>{
  const text='👩🏽‍🚀 우주';// The astronaut is one grapheme of 7 UTF-16 units.
  assert.deepEqual(normalizeTextRuns(text,[{from:1,to:3,color:'#00ff00'}]),[{from:0,to:7,color:'#00ff00'}]);
  // Typing inside a styled word takes its style; typing before it does not.
  assert.deepEqual(remapTextRuns('안녕 세계 끝','안녕 세계계 끝',[{from:3,to:5,color:'#ff0000'}]),[{from:3,to:6,color:'#ff0000'}]);
  assert.deepEqual(remapTextRuns('안녕 세계 끝','새 안녕 세계 끝',[{from:3,to:5,color:'#ff0000'}]),[{from:5,to:7,color:'#ff0000'}]);
  assert.deepEqual(remapTextRuns('안녕 세계 끝','안녕 끝',[{from:3,to:5,color:'#ff0000'}]),undefined);
  // editCaptionText carries the runs along.
  const clip=caption('c','빨간 글자',0,2,{textRuns:[{from:0,to:2,color:'#ff0000'}]});
  assert.deepEqual(editCaptionText(clip,'아주 빨간 글자').textRuns,[{from:0,to:5,color:'#ff0000'}]);// Typed at the very start: takes the first character's style.
  assert.deepEqual(editCaptionText(clip,'빨간 색 글자').textRuns,[{from:0,to:2,color:'#ff0000'}]);
  assert.deepEqual(sliceTextRuns([{from:0,to:5,color:'#ff0000'}],3,9,'세계 반가워'),[{from:0,to:2,color:'#ff0000'}]);
  assert.deepEqual(joinTextRuns([{from:0,to:2,size:60}],[{from:0,to:1,size:60}],3,'가나 다'),[{from:0,to:2,size:60},{from:3,to:4,size:60}]);
});

test('text runs: saved projects validate them and list every font in use',()=>{
  const clip=caption('c','글꼴 섞기',0,2,{textRuns:[{from:0,to:2,font:'gmarket-sans',weight:700},{from:3,to:5,size:90,color:'#123456'}]});
  assertProject({...project([clip])});
  assert.throws(()=>assertProject(project([{...clip,textRuns:[{from:0,to:99,color:'#123456'}]}])),/부분 글자 스타일/);
  assert.deepEqual(textRunFonts(clip).map(f=>`${f.font}:${f.weight}`).sort(),['gmarket-sans:700','noto-sans-kr:700']);
});

test('caption breaks prefer sentence ends, clauses and endings over particles',()=>{
  const text='오늘은 날씨가 정말 좋아서 공원에 갔어요. 그리고 친구를 만났는데 정말 반가웠어요';
  const ranges=captionBreaks(text,14),pieces=ranges.map(([a,b])=>text.slice(a,b));
  assert.ok(pieces.every(p=>[...p].length<=14),JSON.stringify(pieces));
  assert.ok(pieces.some(p=>p.endsWith('갔어요.')),JSON.stringify(pieces));
  assert.equal(pieces.join(' '),text);
  // Short enough: one piece.
  assert.deepEqual(captionBreaks('짧은 자막',14),[[0,5]]);
  // One unbroken run longer than the limit is cut between graphemes.
  assert.ok(captionBreaks('가'.repeat(30),10).every(([a,b])=>b-a<=10));
});

test('splitting a caption times pieces from measured words and keeps styles',()=>{
  const text='첫번째 문장입니다. 두번째 문장입니다';
  const clip=caption('c',text,10,4,{textRuns:[{from:12,to:15,color:'#ff0000'}],captionWords:[
    {from:0,to:3,start:.1,end:.5,timing:'measured'},{from:4,to:10,start:.6,end:1.4,timing:'measured'},
    {from:11,to:14,start:2.5,end:3,timing:'measured'},{from:15,to:20,start:3.1,end:3.9,timing:'measured'}]});
  const pieces=splitCaption(clip,12,30);
  assert.equal(pieces.length,2);
  assert.deepEqual(pieces.map(p=>p.text),['첫번째 문장입니다.','두번째 문장입니다']);
  assert.equal(pieces[0].id,'c');assert.notEqual(pieces[1].id,'c');
  assert.equal(pieces[0].start,10);assert.ok(Math.abs(pieces[1].start-12.5)<1e-9,String(pieces[1].start));
  assert.ok(Math.abs(pieces[0].duration+pieces[1].duration-4)<1e-9);
  assert.deepEqual(pieces[1].textRuns,[{from:1,to:4,color:'#ff0000'}]);
  assert.deepEqual(pieces[1].captionWords?.map(w=>[w.from,w.to]),[[0,3],[4,9]]);
  assert.ok(Math.abs(pieces[1].captionWords![0].start)<1e-9);
  // Without word times the pieces follow the characters.
  const plain=splitCaption({...clip,captionWords:undefined},12,30);
  assert.ok(Math.abs(plain[1].start-(10+4*10/19))<1/30+1e-9,String(plain[1].start));
  const p=splitProjectCaptions(project([clip]),['c'],12);assert.equal(p.after,2);assertProject(p.project);
});

test('merging joins close captions with the same look only',()=>{
  const a=caption('a','안녕하세요',0,1),b=caption('b','반갑습니다',1.2,1,{textRuns:[{from:0,to:2,color:'#ff0000'}]}),c=caption('c','다른 색',2.3,1,{color:'#00ff00'}),d=caption('d','멀리 있음',5,1);
  const result=mergeCaptions([a,b,c,d],{maxChars:30,maxGap:.6,maxDuration:8});
  assert.deepEqual(result.removed,['b']);
  const merged=result.clips[0];
  assert.equal(merged.text,'안녕하세요 반갑습니다');assert.equal(merged.duration,2.2);
  assert.deepEqual(merged.textRuns,[{from:6,to:8,color:'#ff0000'}]);
  // A finished sentence does not take a long follower.
  assert.deepEqual(mergeCaptions([caption('x','끝났습니다.',0,1),caption('y','새로운 긴 문장이 시작됩니다',1.1,1)],{maxChars:40,maxGap:.6,maxDuration:8}).removed,[]);
  const p=mergeProjectCaptions(project([a,b,c,d]),['a','b','c','d'],30);assert.equal(p.after,3);assertProject(p.project);
});

test('sync moves captions onto the words they transcribe',()=>{
  // Captions placed far off; speech says them at 5 s and 9 s, with an uncaptioned word between.
  const one=caption('one','오늘 날씨가 좋네요',0,1.5),two=caption('two','내일은 비가 온대요',1.5,1.5);
  const words:SpeechWord[]=[{start:4.0,end:4.4,text:'음'},{start:5.0,end:5.4,text:'오늘'},{start:5.5,end:6.0,text:'날씨가'},{start:6.1,end:6.8,text:'좋네요.'},{start:7.5,end:8,text:'아무튼'},{start:9.0,end:9.5,text:'내일은'},{start:9.6,end:9.9,text:'비가'},{start:10,end:10.6,text:'온대요'}];
  const report=syncCaptionTimes([one,two],words,30);
  assert.equal(report.matched,2);
  const a=report.updates.get('one')!,b=report.updates.get('two')!;
  assert.ok(Math.abs(a.start-4.95)<.04,String(a.start));assert.ok(a.start+a.duration>=6.8-1e-9&&a.start+a.duration<=7.1,String(a.start+a.duration));
  assert.ok(Math.abs(b.start-8.95)<.04,String(b.start));assert.ok(b.start+b.duration>=10.6-1e-9);
  assert.deepEqual(a.captionWords?.map(w=>[w.from,w.to]),[[0,2],[3,6],[7,10]]);
  // Recognition mistakes still align by the characters that agree.
  const noisy=syncCaptionTimes([one],[{start:2,end:2.4,text:'오늘'},{start:2.5,end:3,text:'날시가'},{start:3.1,end:3.6,text:'좋네여'}],30);
  assert.equal(noisy.matched,1);assert.ok(Math.abs(noisy.updates.get('one')!.start-1.95)<.04);
  // applyCaptionSync skips captions whose text changed since the sync started.
  const p=project([one,two]),applied=applyCaptionSync(p,{one:one.text!,two:'바뀐 문장'},words);
  assert.ok(Math.abs(applied.project.clips.find(c=>c.id==='one')!.start-4.95)<.04);
  assert.equal(applied.project.clips.find(c=>c.id==='two')!.start,1.5);
  assertProject(applied.project);
});

test('caption targets and the audio a sync listens to',()=>{
  const media={id:'m',kind:'video' as const,name:'v',path:'C:/v.mp4',duration:30,width:640,height:360,fps:30,hasAudio:true};
  const video={...newClip('video-1',media),id:'v',mediaId:'m',start:2,duration:20,in:3};
  const p={...project([video,caption('t1','하나',3,1),caption('t2','둘',5,1)]),media:[media]} as Project;
  assert.deepEqual(captionTargets(p,['t2']).map(c=>c.id),['t2']);
  assert.deepEqual(captionTargets(p,['v']).map(c=>c.id),['t1','t2']);
  const audio=speechAudioProject(p,5,15);
  assert.equal(audio.clips.length,1);assert.equal(audio.clips[0].start,0);assert.equal(audio.clips[0].duration,10);assert.ok(Math.abs(audio.clips[0].in-6)<1e-9);
});

test('recognized word times are tightened to the audible speech',()=>{
  // 100 values per second: silence, speech 1.6–3.6 s, silence, speech 6.5–9.7 s.
  const env=new Float32Array(1200).fill(-90);for(let i=160;i<360;i++)env[i]=-20;for(let i=650;i<970;i++)env[i]=-18;
  const words=refineWordTimes([{start:0,end:.9,text:'오늘은'},{start:.9,end:3.6,text:'날씨가'},{start:3.8,end:9.9,text:'공원에 가서'},{start:10,end:11,text:'음'}],env);
  assert.ok(Math.abs(words[0].start-1.56)<.011,'a word in silence moves to the next speech');
  assert.ok(Math.abs(words[1].start-1.56)<.011&&Math.abs(words[1].end-3.6)<.011);
  assert.ok(Math.abs(words[2].start-6.46)<.011&&Math.abs(words[2].end-9.74)<.011,JSON.stringify(words[2]));
  assert.deepEqual(words[3],{start:10,end:11,text:'음'},'no speech nearby: unchanged');
  // Constant level (no contrast): nothing to learn from.
  assert.deepEqual(refineWordTimes([{start:0,end:1,text:'x'}],new Float32Array(500).fill(-30)),[{start:0,end:1,text:'x'}]);
});
