// Regressions from the 2026-11 full sweep: each test pins one bug that reached the user or would have.
import test from 'node:test';
import assert from 'node:assert/strict';
import {newClip,newProject} from '../shared/project';
import {assertProject} from '../shared/validation';
import {defaultCaptionStyle,unifyTextClips} from '../shared/captions';
import {applyCaptionSync,mergeCaptions,splitCaption} from '../shared/caption-timing';
import {patchColorGrades} from '../shared/color-edits';
import {resizeProject,scaleSelectionSpeed} from '../src/editor';
import {pushFollowers} from '../src/timeline-model';
import {unsupportedCaptionGlyphs} from '../src/captions/glyphs';
import {groupCaptionWords,tightenWords} from '../electron/speech';
import {parseSrt} from '../electron/services';
import type {Clip,Project} from '../shared/types';

const caption=(id:string,text:string,start:number,duration:number,extra:Partial<Clip>={}):Clip=>({...newClip('text-1'),id,name:text,text,start,duration,fontSize:48,captionStyle:defaultCaptionStyle(),...extra});
const withText=(clips:Clip[]):Project=>({...newProject(),tracks:[{id:'video-1',name:'영상 1',type:'video',muted:false,hidden:false,locked:false},{id:'text-1',name:'자막',type:'text',muted:false,hidden:false,locked:false}],clips});

test('speeding up a selection keeps caption word times inside the caption, so the project still saves',()=>{
  for(const percent of [75,110,130,150,175,200])for(let n=1;n<=40;n++){
    const duration=n/3+.4,words=[{from:0,to:2,start:0,end:duration/3,timing:'measured' as const},{from:3,to:5,start:duration/3,end:duration,timing:'measured' as const}];
    const p=withText([caption('a','가나 다라',n*7,duration,{captionWords:words})]),next=scaleSelectionSpeed(p,['a'],percent/100,30);
    assert.doesNotThrow(()=>assertProject(next),`${percent}% of a ${duration}s caption`);
  }
});
test('a clip made longer pushes the clips after it on its track instead of covering them',()=>{
  const a=caption('a','하나',0,5),b=caption('b','둘',5,5),c=caption('c','셋',12,3),other={...caption('o','다른 트랙',6,2),trackId:'text-2'};
  const pushed=pushFollowers([a,b,c,other],a,8);
  assert.deepEqual(pushed.map(v=>v.start),[0,8,15,6],'Followers move by the overlap; another track stays');
  assert.deepEqual(pushFollowers([a,c],a,8).map(v=>v.start),[0,12],'A gap that still fits is left alone');
  assert.throws(()=>pushFollowers([a,{...b,start:5,duration:86390}],a,20),/24시간/);
});
test('짧게 나누기 starts the first piece where the caption started',()=>{
  const clip=caption('s','먼저 왼쪽 그래프를 보겠습니다. 그리고 오른쪽 그래프를 보겠습니다.',5.5411,6.2),pieces=splitCaption(clip,14,30);
  assert.ok(pieces.length>1);assert.equal(pieces[0].start,clip.start,'An earlier start overlapped the caption before it for a frame');
  assert.ok(Math.abs(pieces.at(-1)!.start+pieces.at(-1)!.duration-(clip.start+clip.duration))<1e-9);
});
test('길게 합치기 merges captions that are drawn the same, whatever their unused old fields say',()=>{
  const style=defaultCaptionStyle(),a=caption('a','안녕하세요',0,1,{textStyle:'minimal',fontFamily:'Malgun Gothic',captionStyle:{...style,highlight:true}});
  const b=caption('b','반갑습니다',1,1,{textStyle:'bold',fontFamily:'Arial',captionStyle:{...style,activeColor:'#00ff00',highlight:false}});
  assert.equal(mergeCaptions([a,b],{maxChars:30,maxGap:.5,maxDuration:10}).clips.length,1);
  const bigger=caption('c','다른 크기',2,1,{fontSize:64});assert.equal(mergeCaptions([b,bigger],{maxChars:30,maxGap:.5,maxDuration:10}).clips.length,2,'A real difference still keeps them apart');
});
test('a sync that recognised no speech changes nothing',()=>{
  const p=withText([caption('a','하나',.013,.2),caption('b','둘',.25,.2)]);
  for(const words of [[],[{start:1,end:1,text:'무음'}],[{start:0,end:1,text:'  '}]]){const result=applyCaptionSync(p,{a:'하나',b:'둘'},words);assert.equal(result.project,p);assert.equal(result.matched,0);assert.equal(result.total,2);}
});
test('text kept inside a combined clip is converted with the rest of an old project',()=>{
  const inner={...newClip('text-1'),id:'inner',text:'안쪽',captionStyle:undefined,animation:'fade'} as Clip,plain={...newClip('video-1'),id:'plain',text:undefined,mediaId:'m'} as Clip;
  const combined={...plain,id:'combined',compound:{derivedMediaId:'m',start:0,clips:[inner,plain],tracks:[]}} as Clip,p={...withText([combined,plain])},unified=unifyTextClips(p);
  const kept=unified.clips[0].compound!.clips;assert.ok(kept[0].captionStyle&&!('animation' in kept[0]));assert.equal(kept[1],plain);assert.equal(unified.clips[1],plain);
  assert.equal(unifyTextClips(unified),unified,'Converting twice changes nothing');
});
test('changing the canvas size scales per-character sizes with the text',()=>{
  const p={...withText([caption('a','강조 단어',0,2,{fontSize:64,textRuns:[{from:0,to:2,size:96},{from:3,to:5,color:'#ffcc00'}]})]),width:1920,height:1080},tall=resizeProject(p,1080,1920);
  const clip=tall.clips[0];assert.ok(Math.abs(clip.textRuns![0].size!/clip.fontSize-96/64)<1e-9);assert.equal(clip.textRuns![1].size,undefined);
});
test('resetting one colour curve removes that channel and keeps the others',()=>{
  const media={id:'m',path:'C:/v.mp4',name:'v',kind:'video' as const,duration:5,width:1920,height:1080,fps:30,hasAudio:false},clip={...newClip('video-1',media),id:'v'};
  let p:Project={...newProject(),media:[media],clips:[clip]};const points=[{x:0,y:0},{x:.5,y:.7},{x:1,y:1}];
  p=patchColorGrades(p,new Set(['v']),{curves:{red:points,blue:points}});assert.deepEqual(Object.keys(p.clips[0].colorGrade!.curves!).sort(),['blue','red']);
  p=patchColorGrades(p,new Set(['v']),{curves:{red:undefined}});assert.deepEqual(Object.keys(p.clips[0].colorGrade!.curves!),['blue']);
  p=patchColorGrades(p,new Set(['v']),{curves:{blue:undefined}});assert.equal(p.clips[0].colorGrade!.curves,undefined);assert.doesNotThrow(()=>assertProject(p));
});
test('characters that draw nothing do not hide a caption or stop the export',()=>{
  assert.deepEqual(unsupportedCaptionGlyphs('붙여\u200b넣은\ufeff 자막\u200e\u00ad'),[]);
  assert.ok(unsupportedCaptionGlyphs('简体字').length,'A glyph that is really missing is still reported');
});
test('auto captions hand over without a blink and never flash by',()=>{
  const word=(text:string,start:number,end:number)=>({text,start,end,timing:'measured' as const});
  const cues=groupCaptionWords([word('첫 문장입니다.',0,1.9),word('둘째',2,2.05),word('문장입니다.',2.05,2.1),word('한참',6,6.4),word('뒤입니다.',6.4,7)],28,4);
  assert.ok(cues.length>=2);
  for(let i=0;i+1<cues.length;i++){const gap=cues[i+1].start-cues[i].end;assert.ok(gap===0||gap>=.3-1e-9,`gap ${gap} after cue ${i}`);assert.ok(cues[i].end>cues[i].start);}
  for(const cue of cues)assert.ok(cue.end-cue.start>=.4-1e-9||cues.some(next=>Math.abs(next.start-cue.end)<1e-9),'A short cue is stretched unless the next one starts first');
});
test('tightened word times stay in order and inside their own slot',()=>{
  const rate=100,envelope=new Float32Array(10*rate).fill(-70);for(let i=4*rate;i<5*rate;i++)envelope[i]=-10;for(let i=7*rate;i<8*rate;i++)envelope[i]=-10;
  const words=[{text:'앞',start:1,end:5},{text:'가운데',start:5,end:5.2},{text:'뒤',start:5.2,end:8}],tight=tightenWords(words,envelope,0);
  assert.ok(tight[0].start>=3.9,'The word no longer starts over the silence before it');
  for(let i=0;i<tight.length;i++){assert.ok(tight[i].end>tight[i].start);if(i)assert.ok(tight[i].start>=tight[i-1].end-1e-9);assert.ok(tight[i].start>=words[i].start-1e-9);}
});
test('subtitle import keeps text that only looks like markup',()=>{
  const [cue]=parseSrt('1\n00:00:01,000 --> 00:00:03,000\n<i>vector<int></i> 타입이고 x < 3 이면서 y > 1 입니다\n');
  assert.equal(cue.text,'vector<int> 타입이고 x < 3 이면서 y > 1 입니다');
  assert.equal(parseSrt('1\n00:00:01,000 --> 00:00:03,000\n<font color="#ff0000">빨강</font> <b>굵게</b> <00:00:01.500>뒤\n')[0].text,'빨강 굵게 뒤');
});
