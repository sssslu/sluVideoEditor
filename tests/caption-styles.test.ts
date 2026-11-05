import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {applyCaptionAppearance,builtInCaptionAppearance,captureCaptionAppearance,deleteCaptionPreset,readCaptionPresets,saveCaptionPreset} from '../src/captions/presets';
import {unsupportedCaptionGlyphs} from '../src/captions/glyphs';
import {newClip,newProject,splitClip} from '../shared/project';
import {assertProject} from '../shared/validation';
import {assertCaptionStyle,textCaptionStyle} from '../shared/captions';
const store=()=>{const values=new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};};
test('named caption presets are bounded validated independent appearance snapshots',()=>{
  const storage=store(),clip={...newClip('text-1'),...builtInCaptionAppearance('line',48)},appearance=captureCaptionAppearance(clip),saved=saveCaptionPreset('  검증 스타일  ',appearance,storage);appearance.captionStyle.activeColor='#ff0000';
  const loaded=readCaptionPresets(storage);assert.equal(loaded.length,1);assert.equal(loaded[0].name,'검증 스타일');assert.equal(loaded[0].appearance.fontSize,48);assert.equal(loaded[0].appearance.captionStyle.activeColor,'#81e2d1');assert.ok(!('text' in loaded[0].appearance));assert.ok(!('captionWords' in loaded[0].appearance));assert.ok(!('start' in loaded[0].appearance));
  assert.throws(()=>saveCaptionPreset('검증 스타일',appearance,storage),/같은 이름/);assert.throws(()=>saveCaptionPreset('invalid',{...appearance,fontSize:NaN},storage),/올바르지/);assert.throws(()=>saveCaptionPreset('invalid',{...appearance,captionStyle:{...appearance.captionStyle,outlineWidth:31}},storage),/스타일/);
  for(let i=1;i<24;i++)saveCaptionPreset(`스타일 ${i}`,appearance,storage);assert.throws(()=>saveCaptionPreset('25번째',appearance,storage),/24개/);deleteCaptionPreset(saved.id,storage);assert.equal(readCaptionPresets(storage).length,23);
});
test('bundled glyph coverage accepts Korean, combining Latin and supported emoji sequences without system substitution',()=>{
  for(const text of ['한국어 ABC {\\} é e\u0301','👩‍💻 👨‍👩‍👧‍👦 👍🏽 ❤️ 🇰🇷 1️⃣','가나다\n한글 123'])assert.deepEqual(unsupportedCaptionGlyphs(text),[],text);
  assert.ok(unsupportedCaptionGlyphs('العربية').length);assert.ok(unsupportedCaptionGlyphs('עברית').length);assert.ok(unsupportedCaptionGlyphs('A\u200dB').length);
});
test('style application clears absent rich animation, captures legacy animation, and preserves content and unchanged effect phase',()=>{
  const source={...newClip('text-1'),...builtInCaptionAppearance('line',48),animation:'slide' as const,captionAnimation:undefined},appearance=captureCaptionAppearance(source),target={...newClip('text-1'),...builtInCaptionAppearance('plain',64),text:'유지할 문구',captionWords:[{from:0,to:3,start:0,end:.3,timing:'manual' as const}],x:100,start:7,sourceClipOffset:.2,sourceClipDuration:5};
  const applied=applyCaptionAppearance(target,JSON.parse(JSON.stringify(appearance)));assert.equal(applied.animation,'slide');assert.equal(applied.captionAnimation,undefined);assert.equal(applied.sourceClipOffset,undefined);assert.equal(applied.text,target.text);assert.equal(applied.captionWords,target.captionWords);assert.equal(applied.start,7);assert.equal(applied.x,100);
  const unchanged=applyCaptionAppearance(target,{...captureCaptionAppearance(target),color:'#ff0000'});assert.equal(unchanged.sourceClipOffset,.2);assert.equal(unchanged.sourceClipDuration,5);appearance.captionStyle.radius=150;assert.notEqual(applied.captionStyle?.radius,150);
  const unusedLegacyChange=applyCaptionAppearance({...target,animation:'fade'},{...captureCaptionAppearance(target),animation:'none',color:'#00ff00'});assert.equal(unusedLegacyChange.sourceClipOffset,.2);assert.equal(unusedLegacyChange.sourceClipDuration,5,'An unused legacy animation field must not restart rich caption fades');
});
test('malformed or oversized local preset storage is rejected before use',()=>{
  for(const raw of ['null','[null]','{}','[{"id":"x","name":"y","appearance":null}]',' '.repeat(256*1024+1)])assert.deepEqual(readCaptionPresets({getItem:()=>raw,setItem:()=>{}}),[]);
});
test('untrusted preset extras cannot rewrite clip IDs, content, words or timing and duplicate entries are removed',()=>{
  const clip={...newClip('text-1'),text:'보존',start:3},appearance={...builtInCaptionAppearance('line'),text:'악성',id:'changed',start:99,captionWords:[{from:0,to:1,start:0,end:1,timing:'manual'}]},applied=applyCaptionAppearance(clip,appearance);assert.equal(applied.id,clip.id);assert.equal(applied.text,'보존');assert.equal(applied.start,3);assert.equal(applied.captionWords,undefined);
  const serialized=JSON.stringify([{id:'a',name:'정상',appearance},{id:'a',name:'중복 ID',appearance},{id:'b',name:'정상',appearance}]),loaded=readCaptionPresets({getItem:()=>serialized,setItem:()=>{}});assert.equal(loaded.length,1);assert.ok(!('text' in loaded[0].appearance));assert.ok(!('start' in loaded[0].appearance));
});
test('font provenance matches distributed original bytes and original license files',async()=>{
  for(const name of ['NotoSansKR','NotoEmoji']){const manifest=JSON.parse(await readFile(path.resolve(`resources/licenses/${name}-manifest.json`),'utf8')),font=await readFile(path.resolve(manifest.file)),license=await readFile(path.resolve('resources/licenses',manifest.licenseFile));assert.equal(font.length,manifest.bytes);assert.equal(createHash('sha256').update(font).digest('hex'),manifest.sha256);assert.equal(createHash('sha256').update(license).digest('hex'),manifest.licenseSha256);assert.match(license.toString(),/SIL OPEN FONT LICENSE/);assert.equal(manifest.modified,false);}
});

test('the two caption font families survive presets and splitting with format10 validation',()=>{
  for(const font of ['noto-sans-kr','gmarket-sans'] as const) {
    const appearance=builtInCaptionAppearance('outline');
    appearance.captionStyle.font=font;
    const clip=applyCaptionAppearance(newClip('text-1'),appearance);
    assertProject({...newProject(),clips:[clip]});
    const storage=store();
    saveCaptionPreset(font,captureCaptionAppearance(clip),storage);
    assert.equal(readCaptionPresets(storage)[0].appearance.captionStyle.font,font);
    const parts=splitClip(clip,1);
    assert.ok(parts);
    for(const part of parts)assert.equal(part.captionStyle?.font,font);
    if(font==='gmarket-sans')assert.throws(()=>assertProject({...newProject(),version:9,clips:[clip]}),/형식 10/);
  }
  for(const kind of ['minimal','bold','box','neon','title'] as const) {
    const style=textCaptionStyle(kind);
    assertCaptionStyle(style);
    assert.ok(['noto-sans-kr','gmarket-sans'].includes(style.font));
    assert.equal(style.highlight,false);
  }
});

test('Gmarket fonts and their original embedded license match the shipped provenance',async()=>{
  const manifest=JSON.parse(await readFile('resources/licenses/GmarketSans-manifest.json','utf8'));
  const license=await readFile(path.join('resources/licenses',manifest.licenseFile));
  assert.equal(createHash('sha256').update(license).digest('hex'),manifest.licenseSha256);
  assert.match(license.toString(),/eBay Korea/);
  assert.match(license.toString(),/SIL Open Font License, Version 1.1/);
  assert.equal(manifest.modified,false);
  assert.equal(manifest.files.length,2);
  for(const record of manifest.files) {
    const bytes=await readFile(record.file);
    assert.equal(bytes.length,record.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256);
  }
});
