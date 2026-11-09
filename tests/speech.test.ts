import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {parseWhisperWords,groupCaptionWords,selectOwnedWhisperWords,wavHasSamples} from '../electron/speech';
import {runProcess} from '../electron/media';
import {assertCaptionWords,captionGraphemes} from '../shared/captions';
import actualTokens from './fixtures/whisper-word-tokens.json';

test('real English and Korean whisper.cpp JSON fixtures retain measured token boundaries and punctuation',()=>{
  for(const fixture of actualTokens){
    const words=parseWhisperWords(fixture),cues=groupCaptionWords(words,28,4);
    assert.ok(words.length>=10,fixture.fixture);assert.ok(words.every(w=>w.timing==='measured'),fixture.fixture);
    assert.equal(cues.map(c=>c.text).join(' '),fixture.transcription.map(row=>row.text.trim()).join(' '));
    const annotations=cues.flatMap(c=>c.words!.map(w=>({...w,text:c.text.slice(w.from,w.to)})));
    assert.equal(annotations.length,words.length);
    words.forEach((word,index)=>{assert.equal(annotations[index].text,word.text);assert.equal(annotations[index].start,word.start);assert.equal(annotations[index].end,word.end);assert.equal(annotations[index].timing,'measured');});
    cues.forEach(c=>assertCaptionWords(c.text,c.words,c.start,c.end));
  }
});
test('token caption segmentation retains Korean text and punctuation with measured word timestamps',()=>{
  const words=parseWhisperWords({transcription:[{offsets:{from:1000,to:6000},text:' 안녕하세요. 오늘은 영상 편집을 합니다.',tokens:[{text:'[_BEG_]',offsets:{from:1000,to:1000}},{text:' 안녕',offsets:{from:1100,to:1500}},{text:'하세요',offsets:{from:1500,to:1900}},{text:'.',offsets:{from:1900,to:1900}},{text:' 오늘은',offsets:{from:2200,to:3000}},{text:' 영상',offsets:{from:3100,to:3900}},{text:' 편집을',offsets:{from:4000,to:4900}},{text:' 합니다.',offsets:{from:5000,to:6000}}]}]});
  const cues=groupCaptionWords(words,16,3);assert.equal(cues.map(c=>c.text).join(' '),'안녕하세요. 오늘은 영상 편집을 합니다.');assert.equal(cues[0].start,1.1);assert.equal(cues[0].end,1.9);assert.ok(cues.every(c=>Array.from(c.text).length<=16&&c.end-c.start<=3));
  assert.deepEqual(cues[0].words,[{from:0,to:6,start:1.1,end:1.9,timing:'measured'}]);
  assert.deepEqual(cues.flatMap(c=>c.words!.map(w=>c.text.slice(w.from,w.to))),['안녕하세요.','오늘은','영상','편집을','합니다.']);
  for(const cue of cues)assertCaptionWords(cue.text,cue.words,cue.start,cue.end);
});
test('long single words and tokenless results respect finite caption limits without dropping Unicode',()=>{
  const text='가나다라마바사아자차카타파하'.repeat(3);const words=parseWhisperWords({transcription:[{offsets:{from:0,to:15000},text}]});const cues=groupCaptionWords(words,10,2);assert.equal(cues.map(c=>c.text).join(''),text);assert.ok(cues.every(c=>Array.from(c.text).length<=10&&c.end-c.start<=2));
  assert.ok(cues.every(c=>c.words?.every(w=>w.timing==='estimated')));
  assert.throws(()=>groupCaptionWords([],0,3));assert.throws(()=>parseWhisperWords({}));
});

test('sentence-only, malformed-token and zero-length-token fallbacks never invent measured word times',()=>{
  for(const tokens of [undefined,[{text:' Hello',offsets:{from:0,to:0}}],[{text:' Hello',offsets:{from:0,to:500}},{text:' world',offsets:{from:NaN,to:1000}}]]){
    const parsed=parseWhisperWords({transcription:[{offsets:{from:0,to:2000},text:'Hello world.',tokens}]});
    assert.deepEqual(groupCaptionWords(parsed),[{start:0,end:2,text:'Hello world.'}]);
  }
});

test('overlong sentence fallbacks prefer existing word boundaries instead of cutting ordinary English words',()=>{
  for(const [text,duration,maxChars,maxDuration] of [
    ['ask what you can do for your country.',7,28,4],
    ['ordinary English words stay together even when captions are short',12,16,2],
    ['one extraordinarilylongunbrokenword two',8,12,3],
  ] as const){
    const cues=groupCaptionWords(parseWhisperWords({transcription:[{text,offsets:{from:0,to:duration*1000}}]}),maxChars,maxDuration);
    assert.ok(cues.every(cue=>captionGraphemes(cue.text).length<=maxChars));
    assert.ok(cues.every(cue=>cue.words?.every(word=>word.timing==='estimated')));
    if(text.includes('extraordinarily'))assert.equal(cues.map(cue=>cue.text).join('').replace(/\s/g,''),text.replace(/\s/g,''));
    else assert.equal(cues.map(cue=>cue.text).join(' '),text);
    for(const cue of cues)assertCaptionWords(cue.text,cue.words,cue.start,cue.end);
  }
});

test('UTF-16 word ranges retain combining marks, emoji clusters and closing punctuation',()=>{
  const text='👨‍👩‍👧‍👦 e\u0301!';
  const parsed=parseWhisperWords({transcription:[{offsets:{from:0,to:2000},text,tokens:[
    {text:'👨‍👩‍👧‍👦',offsets:{from:0,to:600}},{text:' ',offsets:{from:600,to:600}},
    {text:'e',offsets:{from:800,to:1000}},{text:'\u0301',offsets:{from:1000,to:1100}},{text:'!',offsets:{from:1100,to:1100}},
  ]}]});
  const [cue]=groupCaptionWords(parsed);assert.equal(cue.text,text);
  assert.deepEqual(cue.words,[{from:0,to:11,start:0,end:.6,timing:'measured'},{from:12,to:15,start:.8,end:1.1,timing:'measured'}]);
  assertCaptionWords(cue.text,cue.words,cue.start,cue.end);
  const cluster='👩🏽‍🚀',long=cluster.repeat(19),split=groupCaptionWords([{text:long,start:4,end:10,timing:'measured'}],8,2);
  assert.equal(split.map(c=>c.text).join(''),long);
  assert.ok(split.every(c=>captionGraphemes(c.text).length<=8&&c.words?.every(w=>w.timing==='estimated')));
  split.forEach(c=>assertCaptionWords(c.text,c.words,c.start,c.end));
  // The only indivisible symbol keeps its entire interval rather than losing time or breaking Unicode.
  const [single]=groupCaptionWords([{text:cluster,start:0,end:8,timing:'measured'}],8,2);
  assert.equal(single.text,cluster);assert.equal(single.end,8);assert.equal(single.words![0].timing,'measured');
});

test('overlapping ASR chunks own boundary words exactly once and keep clipped source-absolute metadata',()=>{
  const fixture=(offset:number)=>parseWhisperWords({transcription:[{offsets:{from:(599.4-offset)*1000,to:(600.8-offset)*1000},tokens:[
    {text:' first',offsets:{from:(599.4-offset)*1000,to:(599.8-offset)*1000}},
    {text:' boundary',offsets:{from:(599.8-offset)*1000,to:(600.2-offset)*1000}},
    {text:' last.',offsets:{from:(600.3-offset)*1000,to:(600.8-offset)*1000}},
  ]}]});
  const left=selectOwnedWhisperWords(fixture(0),0,0,600,20),right=selectOwnedWhisperWords(fixture(599),599,600,1200,20);
  assert.deepEqual(left.map(w=>w.text),['first']);assert.deepEqual(right.map(w=>w.text),['boundary','last.']);
  const cues=[...groupCaptionWords(left),...groupCaptionWords(right)];
  assert.equal(cues[1].words![0].start,620);assert.ok(Math.abs(cues[1].words![0].end-620.2)<1e-10);
  for(const c of cues)assertCaptionWords(c.text,c.words,c.start,c.end);
  assert.throws(()=>selectOwnedWhisperWords([],0,2,1));
});

test('cue cuts clamp overlapping measured word intervals without claiming a new measurement',()=>{
  const cues=groupCaptionWords([{text:'first.',start:1,end:3,timing:'measured'},{text:'second',start:2,end:4,timing:'measured'},{text:'third',start:3.5,end:5,timing:'measured'}]);
  assert.equal(cues[0].end,2);assert.equal(cues[0].words![0].end,2);
  assert.equal(cues[1].words![0].end,3.5);
  assert.ok(cues.every(c=>c.words?.every(w=>w.timing==='measured')));
  cues.forEach(c=>assertCaptionWords(c.text,c.words,c.start,c.end));
});

test('opening and closing quote tokens preserve spacing around the spoken words',()=>{
  const parsed=parseWhisperWords({transcription:[{offsets:{from:0,to:1500},text:'He said "hello."',tokens:[
    {text:'He',offsets:{from:0,to:200}},{text:' said',offsets:{from:250,to:500}},
    {text:' "',offsets:{from:600,to:600}},{text:'hello',offsets:{from:600,to:1200}},
    {text:'.',offsets:{from:1200,to:1200}},{text:'"',offsets:{from:1200,to:1200}},
  ]}]});
  const [cue]=groupCaptionWords(parsed);assert.equal(cue.text,'He said "hello."');
  assert.deepEqual(cue.words!.map(word=>cue.text.slice(word.from,word.to)),['He','said','"hello."']);
  assertCaptionWords(cue.text,cue.words,cue.start,cue.end);
});
test('a chunk starting after the audio track ends is detected as a sample-free WAV',{timeout:60000},async()=>{
  const root=path.resolve('.test-artifacts/speech-chunks'),ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),source=path.join(root,'short-audio.mkv');await fs.mkdir(root,{recursive:true});
  // Video continues for 4 s after a 1 s audio track, as in a long recording whose sound stops early.
  await runProcess(ffmpeg,['-hide_banner','-v','error','-nostdin','-y','-f','lavfi','-i','color=black:s=32x18:r=10:d=5','-f','lavfi','-i','sine=f=440:r=16000:d=1','-c:v','libx264','-preset','ultrafast','-c:a','pcm_s16le',source]);
  const extract=async(name:string,start:string)=>{const wav=path.join(root,name);await runProcess(ffmpeg,['-hide_banner','-nostdin','-v','error','-y','-ss',start,'-t','1','-protocol_whitelist','file,pipe','-i',source,'-map','0:a:0','-vn','-ar','16000','-ac','1','-c:a','pcm_s16le',wav]);return wav;};
  const empty=await extract('empty.wav','3'),audible=await extract('audible.wav','0.5');
  assert.ok((await fs.stat(empty)).size<128);assert.equal(await wavHasSamples(empty),false);assert.equal(await wavHasSamples(audible),true);
  const other=path.join(root,'not-wav.bin');await fs.writeFile(other,'not a wave file');assert.equal(await wavHasSamples(other),true);
});
