import type { Project, MediaAsset,Clip } from './types';
import {assertSpeedCurve} from './speed';
import {assertTransitions} from './transitions';
import {assertCaptionWords,assertCaptionStyle,assertCaptionAnimation,MAX_PROJECT_CAPTION_WORDS} from './captions';
import {assertColorGrade,assertColorLut,MAX_PROJECT_LUT_VALUES} from './color';
import {assertAudioEQ} from './audio-eq';
import {assertProjectMotion} from './motion-validation';
import {assertProjectFiles} from './project-files';
const finite = (v:unknown,min:number,max:number) => typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const str = (v:unknown,max=8192) => typeof v==='string'&&v.length<=max&&!v.includes('\0');
const id = (v:unknown) => str(v,128)&&(v as string).trim().length>0;
const bool = (v:unknown) => typeof v==='boolean';
const color = (v:unknown) => typeof v==='string'&&/^#[\da-f]{6}$/i.test(v);
const object = (v:unknown) => typeof v==='object'&&v!==null&&!Array.isArray(v);
function assertStabilization(s:NonNullable<Clip['stabilization']>,ids:Set<string>){
  const o=s?.options;
  if(!object(s)||!id(s.sourceMediaId)||!ids.has(s.sourceMediaId)||!finite(s.sourceIn,0,864000)||!object(o)||(o.crop!==undefined&&!['auto','black'].includes(o.crop))||(o.smoothing!==undefined&&(!finite(o.smoothing,0,120)||!Number.isInteger(o.smoothing)))||(o.accuracy!==undefined&&(!finite(o.accuracy,5,15)||!Number.isInteger(o.accuracy)))||(o.shakiness!==undefined&&(!finite(o.shakiness,1,10)||!Number.isInteger(o.shakiness)))||(o.zoom!==undefined&&!finite(o.zoom,0,20)))throw new Error('잘못된 흔들림 보정 설정입니다.');
}
function assertReversal(r:NonNullable<Clip['reversal']>,ids:Set<string>,mediaId:string|undefined,stabilization:Clip['stabilization']){
  if(!object(r)||!id(r.sourceMediaId)||!ids.has(r.sourceMediaId)||!id(r.derivedMediaId)||!ids.has(r.derivedMediaId)||r.sourceMediaId===r.derivedMediaId||!finite(r.sourceIn,0,864000)||!finite(r.sourceDuration,.001,86400)||r.sourceIn+r.sourceDuration>864000||(stabilization?stabilization.sourceMediaId:mediaId)!==r.derivedMediaId)throw new Error('잘못된 역재생 원본 연결입니다.');
  if(r.priorStabilization!==undefined)assertStabilization(r.priorStabilization,ids);
}
export function assertMedia(value:unknown):asserts value is MediaAsset {
  const m=value as MediaAsset;
  if(!object(m)||!id(m.id)||!str(m.path)||!m.path||!str(m.name,1000)||!['video','audio','image'].includes(m.kind)||!finite(m.duration,0,864000)||!finite(m.width,0,32768)||!finite(m.height,0,32768)||!finite(m.fps,0,1000)||!bool(m.hasAudio)||(m.thumbnail!==undefined&&!str(m.thumbnail))||(m.proxyPath!==undefined&&!str(m.proxyPath))||(m.codec!==undefined&&!str(m.codec,100))||(m.waveform!==undefined&&(!Array.isArray(m.waveform)||m.waveform.length>10000||m.waveform.some(v=>!finite(v,0,1)))))throw new Error('잘못된 미디어 정보입니다.');
  if(m.sourceRevision!==undefined&&(typeof m.sourceRevision!=='string'||!/^[a-f0-9]{64}$/.test(m.sourceRevision)))throw new Error('잘못된 원본 파일 버전입니다.');
  if(m.hasAlpha!==undefined&&!bool(m.hasAlpha))throw new Error('잘못된 투명도 정보입니다.');
  if(m.timing!==undefined&&(!object(m.timing)||m.timing.version!==1||!finite(m.timing.origin,-864000,864000)||!finite(m.timing.previewOffset,0,864000)))throw new Error('잘못된 미디어 시간 정보입니다.');
  if((m.videoStart!==undefined||m.videoEnd!==undefined)&&(m.kind!=='video'||!finite(m.videoStart,0,864000)||!finite(m.videoEnd,0,864000)||m.videoEnd!<=m.videoStart!))throw new Error('잘못된 영상 프레임 범위입니다.');
}
/** Keep these bounds aligned with the renderer inspector and the FFmpeg engine. */
export function assertProject(value:unknown):asserts value is Project {
  const p=value as Project;
  if(!object(p)||![1,2,3,4,5,6,7,8,9,10].includes(p.version)||!id(p.id)||!str(p.name,500)||!finite(p.width,16,7680)||!Number.isInteger(p.width)||!finite(p.height,16,7680)||!Number.isInteger(p.height)||!finite(p.fps,1,120)||!color(p.background)||!str(p.updatedAt,100)||!Array.isArray(p.media)||!Array.isArray(p.tracks)||!Array.isArray(p.clips)||p.media.length>2000||p.clips.length>10000||p.tracks.length>100)throw new Error('지원하지 않거나 손상된 프로젝트 파일입니다.');
  const ids=new Set<string>();
  for(const m of p.media){assertMedia(m);if(ids.has(m.id))throw new Error('미디어 ID가 중복되어 있습니다.');ids.add(m.id);}
  const tracks=new Set<string>();for(const t of p.tracks){if(!object(t)||!id(t.id)||tracks.has(t.id)||!str(t.name,500)||!['video','audio','text'].includes(t.type)||!bool(t.muted)||!bool(t.hidden)||!bool(t.locked)||(t.solo!==undefined&&!bool(t.solo))||(t.height!==undefined&&!finite(t.height,40,200)))throw new Error('잘못된 트랙 정보입니다.');tracks.add(t.id);}
  if(p.markers!==undefined){if(!Array.isArray(p.markers)||p.markers.length>10000)throw new Error('잘못된 마커 정보입니다.');const markerIds=new Set<string>();for(const m of p.markers){if(!object(m)||!id(m.id)||markerIds.has(m.id)||!finite(m.time,0,86400)||!str(m.label,500)||!color(m.color))throw new Error('잘못된 마커입니다.');markerIds.add(m.id);}}
  const lutIds=new Set<string>();let lutValues=0;
  if(p.colorLuts!==undefined){if(p.version<5||!Array.isArray(p.colorLuts)||p.colorLuts.length>32)throw new Error('LUT 라이브러리는 프로젝트 형식 5와 최대 32개 항목을 지원합니다.');for(const lut of p.colorLuts){assertColorLut(lut);if(lutIds.has(lut.id))throw new Error('LUT ID가 중복되었습니다.');lutIds.add(lut.id);lutValues+=3*lut.size**3;if(lutValues>MAX_PROJECT_LUT_VALUES)throw new Error('프로젝트의 LUT 데이터가 너무 많습니다.');}}
  const clips=new Set<string>();let captionWords=0;
  for(const c of p.clips){
    if(!object(c)||!id(c.id)||clips.has(c.id)||!str(c.name,1000)||!tracks.has(c.trackId)||(c.mediaId!==undefined&&(!id(c.mediaId)||!ids.has(c.mediaId)))||(c.text===undefined&&!c.mediaId)||!finite(c.start,0,86400)||!finite(c.duration,.01,86400)||c.start+c.duration>86400.001||!finite(c.in,0,864000)||!finite(c.speed,.1,16)||!finite(c.volume,0,8)||!finite(c.opacity,0,1)||!finite(c.scale,.01,8)||!finite(c.x,-16384,16384)||!finite(c.y,-16384,16384)||!finite(c.rotation,-3600,3600)||!finite(c.fadeIn,0,86400)||!finite(c.fadeOut,0,86400)||!finite(c.brightness,-1,1)||!finite(c.contrast,0,3)||!finite(c.saturation,0,3)||!finite(c.blur,0,30)||!finite(c.fontSize,4,1000)||!str(c.fontFamily,100)||!color(c.color)||!color(c.textBackground)||!['contain','cover'].includes(c.fit)||!bool(c.flipH)||!bool(c.flipV)||!['none','cinematic','warm','cool','mono','vivid'].includes(c.preset)||!['minimal','bold','box','neon','title'].includes(c.textStyle)||!['left','center','right'].includes(c.align)||!['none','fade','pop','slide'].includes(c.animation)||(c.text!==undefined&&!str(c.text,20000))||!Array.isArray(c.keyframes)||c.keyframes.length>1000)throw new Error('잘못된 클립 설정입니다.');
    if((c.sourceClipOffset!==undefined||c.sourceClipDuration!==undefined)&&(!finite(c.sourceClipOffset,0,86400)||!finite(c.sourceClipDuration,.01,86400)||c.sourceClipOffset!+c.duration>c.sourceClipDuration!+.002))throw new Error('잘못된 클립 효과 구간입니다.');
    if(c.speedCurve!==undefined){if(p.version<2)throw new Error('속도 곡선은 프로젝트 형식 2 이상이 필요합니다.');assertSpeedCurve(c.speedCurve);}
    if(c.audioEQ!==undefined){if(p.version<6||c.text!==undefined||p.media.find(m=>m.id===c.mediaId)?.kind==='image')throw new Error('EQ는 오디오·영상 클립과 프로젝트 형식 6이 필요합니다.');assertAudioEQ(c.audioEQ);}
    if(c.colorGrade?.hsl!==undefined&&p.version<10)throw new Error('HSL 보정은 프로젝트 형식 10 이상이 필요합니다.');
    if(c.colorGrade!==undefined){if(p.version<5||c.text!==undefined||p.media.find(m=>m.id===c.mediaId)?.kind==='audio')throw new Error('색 보정은 영상·이미지 클립과 프로젝트 형식 5가 필요합니다.');assertColorGrade(c.colorGrade,lutIds);}
    if(c.captionWords!==undefined||c.captionStyle!==undefined||c.captionAnimation!==undefined){
      if(p.version<4||c.text===undefined)throw new Error('단어 자막은 텍스트 클립과 프로젝트 형식 4가 필요합니다.');
      if(c.captionWords!==undefined){assertCaptionWords(c.text,c.captionWords,0,c.duration);captionWords+=c.captionWords.length;if(captionWords>MAX_PROJECT_CAPTION_WORDS)throw new Error('프로젝트의 자막 단어가 너무 많습니다.');}
      if(c.captionStyle!==undefined){assertCaptionStyle(c.captionStyle);if(c.captionStyle.font==='gmarket-sans'&&p.version<10)throw new Error('Gmarket Sans 자막은 프로젝트 형식 10 이상이 필요합니다.');}
      if(c.captionAnimation!==undefined){if(c.captionStyle===undefined)throw new Error('새 자막 애니메이션에는 자막 스타일이 필요합니다.');assertCaptionAnimation(c.captionAnimation);}
    }
    if(c.stabilization!==undefined){if(p.version<2)throw new Error('흔들림 보정에는 프로젝트 형식 2 이상이 필요합니다.');assertStabilization(c.stabilization,ids);}
    if(c.reversal!==undefined){
      const r=c.reversal;
      if(p.version<7||c.text!==undefined)throw new Error('잘못된 역재생 원본 연결입니다.');
      assertReversal(r,ids,c.mediaId,c.stabilization);
    }
    if(c.cutout!==undefined){
      const s=c.cutout,base=c.reversal?(c.reversal.priorStabilization?.sourceMediaId??c.reversal.sourceMediaId):(c.stabilization?.sourceMediaId??c.mediaId);
      if(p.version<9||c.text!==undefined||!object(s)||!id(s.sourceMediaId)||!ids.has(s.sourceMediaId)||!id(s.derivedMediaId)||!ids.has(s.derivedMediaId)||s.sourceMediaId===s.derivedMediaId||base!==s.derivedMediaId||!finite(s.sourceIn,0,864000)||!finite(s.sourceDuration,.001,86400)||s.sourceIn+s.sourceDuration>864000||!['portrait','fullbody','precision'].includes(s.quality)||p.media.find(m=>m.id===s.sourceMediaId)?.kind!=='video'||p.media.find(m=>m.id===s.derivedMediaId)?.kind!=='video')throw new Error('잘못된 배경 제거 원본 연결입니다.');
      if(s.priorStabilization!==undefined)assertStabilization(s.priorStabilization,ids);
      if(s.priorReversal!==undefined)assertReversal(s.priorReversal,ids,s.sourceMediaId,s.priorStabilization);
      if([s.priorStabilization?.sourceMediaId,s.priorReversal?.sourceMediaId,s.priorReversal?.derivedMediaId,s.priorReversal?.priorStabilization?.sourceMediaId].includes(s.derivedMediaId))throw new Error('배경 제거 원본 연결이 순환합니다.');
    }
    if(c.enhancement!==undefined){
      const s=c.enhancement,r=c.cutout?.priorReversal??(!c.cutout?c.reversal:undefined),stabilization=c.cutout?c.cutout.priorStabilization:c.stabilization;
      const base=r?(r.priorStabilization?.sourceMediaId??r.sourceMediaId):(stabilization?.sourceMediaId??c.cutout?.sourceMediaId??c.mediaId);
      const source=p.media.find(m=>m.id===s?.sourceMediaId),derived=p.media.find(m=>m.id===s?.derivedMediaId);
      if(p.version<10||c.text!==undefined||!object(s)||!id(s.sourceMediaId)||!id(s.derivedMediaId)||s.sourceMediaId===s.derivedMediaId||base!==s.derivedMediaId||!finite(s.sourceIn,0,864000)||!finite(s.sourceDuration,.001,86400)||s.sourceIn+s.sourceDuration>(source?.duration??0)+.002||![2,4].includes(s.scale)||source?.kind!=='video'||source.hasAlpha||derived?.kind!=='video'||derived.hasAlpha)throw new Error('잘못된 화질 향상 원본 연결입니다.');
      if(s.priorStabilization!==undefined)assertStabilization(s.priorStabilization,ids);
      if(s.priorReversal!==undefined)assertReversal(s.priorReversal,ids,s.sourceMediaId,s.priorStabilization);
      if([s.priorStabilization?.sourceMediaId,s.priorReversal?.sourceMediaId,s.priorReversal?.derivedMediaId,s.priorReversal?.priorStabilization?.sourceMediaId].includes(s.derivedMediaId))throw new Error('화질 향상 원본 연결이 순환합니다.');
    }
    if(c.crop!==undefined){const r=c.crop;if(!object(r)||![r.left,r.top,r.right,r.bottom].every(v=>finite(v,0,.98))||r.left+r.right>.98||r.top+r.bottom>.98)throw new Error('잘못된 자르기 영역입니다.');}
    if(c.chromaKey!==undefined){const k=c.chromaKey;if(!object(k)||!bool(k.enabled)||!color(k.color)||!finite(k.similarity,0,1)||!finite(k.smoothness,.001,1))throw new Error('잘못된 크로마키 설정입니다.');}
    if(c.mask!==undefined){const m=c.mask;if(!object(m)||!['none','rect','ellipse'].includes(m.type)||!finite(m.x,0,1)||!finite(m.y,0,1)||!finite(m.width,.01,1)||!finite(m.height,.01,1)||!finite(m.feather,0,.5)||!bool(m.invert))throw new Error('잘못된 마스크 설정입니다.');}
    const times=new Set<number>();
    for(const k of c.keyframes){if(!object(k)||!finite(k.time,0,c.duration+.001)||times.has(k.time)||!finite(k.x,-16384,16384)||!finite(k.y,-16384,16384)||!finite(k.scale,.01,8)||!finite(k.opacity,0,1)||!finite(k.rotation,-3600,3600)||(k.easing!==undefined&&!['linear','ease-in','ease-out','ease-in-out','hold'].includes(k.easing))||(k.easingStart!==undefined&&!finite(k.easingStart,0,1))||(k.easingEnd!==undefined&&!finite(k.easingEnd,0,1))||(k.easingStart!==undefined&&k.easingEnd!==undefined&&k.easingStart>k.easingEnd))throw new Error('잘못된 키프레임입니다.');times.add(k.time);}
    clips.add(c.id);
  }
  assertTransitions(p);assertProjectMotion(p);assertProjectFiles(p);
}
