import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureCaptionFonts,captionFontsReady,captionFontAvailable,captionFontError,captionFontStack,requireCaptionFonts} from '../src/captions/font';
import {captionLayout} from '../src/captions/layout';
import {newClip,newProject} from '../shared/project';
import {defaultCaptionStyle} from '../shared/captions';
import {CAPTION_FONT_MISSING,isMissingCaptionFont,missingCaptionFont} from '../shared/caption-font-error';
import {captionRasterResponseError} from '../electron/caption-raster-types';

test('caption sandbox failures preserve the missing-font code without classifying unrelated failures as font errors',()=>{
  const original=missingCaptionFont('리틱체 Bold (700)가 설치되어 있지 않습니다.');
  const response=JSON.parse(JSON.stringify({id:7,error:original.message,errorCode:CAPTION_FONT_MISSING}));
  const restored=captionRasterResponseError(response);
  assert.ok(restored instanceof Error);assert.equal(restored.message,original.message);assert.equal(restored.name,'CaptionFontError');assert.equal(isMissingCaptionFont(restored),true);
  assert.equal(captionRasterResponseError({id:7}),undefined);
  for(const failure of [new Error(original.message),new Error('GPU encoder failed'),Object.assign(new Error('Unknown failure'),{code:'unknown'}),{code:CAPTION_FONT_MISSING},undefined])assert.equal(isMissingCaptionFont(failure),false);
  assert.equal(isMissingCaptionFont(captionRasterResponseError({id:7,error:original.message})),false);
  assert.equal(isMissingCaptionFont(captionRasterResponseError({...response,errorCode:'unknown'})),false);
});

test('a missing local Bold does not reject bundled or Regular fonts and cannot silently render a substitute',async()=>{
  const originals={FontFace:Object.getOwnPropertyDescriptor(globalThis,'FontFace'),document:Object.getOwnPropertyDescriptor(globalThis,'document')};
  const requests:{family:string;source:string;weight:string}[]=[],registered:string[]=[];
  class Face {
    status='unloaded';family:string;source:string;weight:string;
    constructor(family:string,source:string,descriptors:{weight:string}){this.family=family;this.source=source;this.weight=descriptors.weight;requests.push({family,source,weight:this.weight});}
    async load(){if(this.family==='SLU REATIC'&&this.weight==='700'){this.status='error';throw new Error('Local Bold is not installed');}this.status='loaded';return this;}
  }
  Object.defineProperty(globalThis,'FontFace',{configurable:true,value:Face});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{fonts:{add:(face:Face)=>registered.push(`${face.family}|${face.weight}`),load:async()=>[],check:()=>true},createElement:()=>{throw new Error('Missing font must be rejected before canvas allocation');}}});
  try{
    await Promise.all([ensureCaptionFonts(),ensureCaptionFonts()]);
    assert.equal(captionFontsReady(),true);assert.equal(requests.length,6,'Concurrent callers must share a single font-loading attempt');
    assert.equal(registered.length,5);assert.ok(!registered.includes('SLU REATIC|700'));
    assert.equal(captionFontAvailable('noto-sans-kr',700),true);assert.equal(captionFontAvailable('gmarket-sans',500),true);
    assert.equal(captionFontAvailable('reatic',400),true);assert.equal(captionFontAvailable('reatic',700),false);
    assert.doesNotThrow(()=>requireCaptionFonts('noto-sans-kr',700));assert.doesNotThrow(()=>requireCaptionFonts('gmarket-sans',700));assert.doesNotThrow(()=>requireCaptionFonts('reatic',400));
    assert.match(captionFontError('reatic',700)||'',/리틱체 Bold \(700\).*설치/);
    const local=requests.filter(face=>face.family==='SLU REATIC');
    assert.deepEqual(local.map(face=>face.weight),['400','700']);
    for(const face of local){assert.ok(face.source.startsWith('local('));assert.ok(!face.source.includes('url('));}
    assert.match(local[0].source,/local\("REATIC-Regular"\)/);assert.match(local[1].source,/local\("REATIC-Bold"\)/);
    assert.match(captionFontStack('reatic'),/^"SLU REATIC","SLU Noto Sans KR","SLU Noto Color Emoji"$/);
    const clip={...newClip('text-1'),captionStyle:{...defaultCaptionStyle(),font:'reatic' as const,weight:700 as const}},before=structuredClone(clip);
    assert.throws(()=>captionLayout(clip,newProject()),error=>error instanceof Error&&error.name==='CaptionFontError'&&/Bold/.test(error.message));
    assert.deepEqual(clip,before,'A missing local font must preserve saved family and weight');
  }finally{
    for(const key of ['FontFace','document'] as const){const descriptor=originals[key];if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  }
});

for(const installed of [[],[700],[400,700]])test(`local face discovery preserves exact installed weights [${installed.join(',')}]`,async()=>{
  // A unique ESM URL gives each discovery case its own production loader state.
  const fonts=await import(new URL(`../src/captions/font.ts?installed=${installed.join('-')||'none'}`,import.meta.url).href) as typeof import('../src/captions/font');
  const originals={FontFace:Object.getOwnPropertyDescriptor(globalThis,'FontFace'),document:Object.getOwnPropertyDescriptor(globalThis,'document')};
  const registered:string[]=[];
  class Face {
    status='unloaded';family:string;weight:string;
    constructor(family:string,_source:string,descriptors:{weight:string}){this.family=family;this.weight=descriptors.weight;}
    async load(){if(this.family==='SLU REATIC'&&!installed.includes(+this.weight)){this.status='error';throw new Error('Local face is not installed');}this.status='loaded';return this;}
  }
  Object.defineProperty(globalThis,'FontFace',{configurable:true,value:Face});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{fonts:{add:(face:Face)=>registered.push(`${face.family}|${face.weight}`),load:async()=>[],check:()=>true}}});
  try{
    await fonts.ensureCaptionFonts();assert.equal(fonts.captionFontsReady(),true);
    assert.equal(registered.filter(family=>family.startsWith('SLU REATIC|')).length,installed.length);
    assert.equal(registered.length,4+installed.length,'Missing local fonts must not remove any bundled face');
    for(const font of ['noto-sans-kr','gmarket-sans'] as const)assert.doesNotThrow(()=>fonts.requireCaptionFonts(font,700));
    for(const weight of [400,700] as const){
      assert.equal(fonts.captionFontAvailable('reatic',weight),installed.includes(weight));
      if(installed.includes(weight)){assert.equal(fonts.captionFontError('reatic',weight),undefined);assert.doesNotThrow(()=>fonts.requireCaptionFonts('reatic',weight));}
      else assert.throws(()=>fonts.requireCaptionFonts('reatic',weight),error=>error instanceof Error&&error.name==='CaptionFontError'&&error.message.includes(String(weight)));
    }
  }finally{
    for(const key of ['FontFace','document'] as const){const descriptor=originals[key];if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  }
});
