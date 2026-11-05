import type {Clip,ColorGrade,ColorLut,Project} from './types';
import {assertColorGrade,assertColorLut,MAX_PROJECT_LUT_VALUES} from './color';
export function patchColorGrades(project:Project,ids:ReadonlySet<string>,patch:Partial<ColorGrade>|null):Project {
  const clips=project.clips.map(clip=>{
    if(!ids.has(clip.id)||clip.text!==undefined||project.tracks.find(t=>t.id===clip.trackId)?.locked||project.tracks.find(t=>t.id===clip.trackId)?.type!=='video'||project.media.find(m=>m.id===clip.mediaId)?.kind==='audio')return clip;
    const grade=patch===null?undefined:{enabled:true,intensity:1,...clip.colorGrade,...patch};
    if(grade&&patch?.hsl)grade.hsl={...clip.colorGrade?.hsl,...patch.hsl};
    if(grade)assertColorGrade(grade,new Set(project.colorLuts?.map(l=>l.id)));
    return {...clip,colorGrade:grade};
  });
  return clips.every((c,i)=>c===project.clips[i])?project:{...project,version:10,clips};
}
export function addColorLut(project:Project,lut:ColorLut):Project {
  assertColorLut(lut);const previous=project.colorLuts?.find(l=>l.id===lut.id);
  if(previous){if(JSON.stringify(previous)!==JSON.stringify(lut))throw new Error('같은 ID의 다른 LUT가 있습니다.');return project;}
  const luts=[...(project.colorLuts||[]),lut];if(luts.length>32||luts.reduce((n,l)=>n+3*l.size**3,0)>MAX_PROJECT_LUT_VALUES)throw new Error('프로젝트의 LUT 용량을 초과했습니다. 사용하지 않는 LUT를 정리하세요.');
  return {...project,version:10,colorLuts:luts};
}
/** Clipboard snapshots retain embedded LUTs even after unused-library cleanup or undo. */
export function restoreColorLuts(project:Project,clips:Clip[],available:ColorLut[]):Project {
  let next=project;const required=new Set(clips.flatMap(c=>c.colorGrade?.lutId?[c.colorGrade.lutId]:[]));
  for(const id of required){const lut=available.find(l=>l.id===id);if(lut)next=addColorLut(next,lut);else if(!next.colorLuts?.some(l=>l.id===id))throw new Error('복사한 클립의 LUT 데이터가 없습니다.');}
  return next;
}
