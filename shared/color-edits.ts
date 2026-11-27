import type {Clip,ColorChannel,ColorGrade,ColorLut,HslAdjustment,HslBand,Project} from './types';
import {assertColorGrade,assertColorLut,MAX_PROJECT_LUT_VALUES} from './color';
import {walkClips} from './clip-tree';
export function patchColorGrades(project:Project,ids:ReadonlySet<string>,patch:Partial<ColorGrade>|null):Project {
  const clips=project.clips.map(clip=>{
    if(!ids.has(clip.id)||clip.text!==undefined||project.tracks.find(t=>t.id===clip.trackId)?.locked||project.tracks.find(t=>t.id===clip.trackId)?.type!=='video'||project.media.find(m=>m.id===clip.mediaId)?.kind==='audio')return clip;
    const grade=patch===null?undefined:{enabled:true,intensity:1,...clip.colorGrade,...patch};
    // Curves and HSL merge per channel and per value, so editing several clips changes only what was
    // touched and keeps each clip's other channels and bands.
    if(grade&&patch?.hsl){const hsl={...clip.colorGrade?.hsl};for(const [band,values] of Object.entries(patch.hsl) as [HslBand,Partial<HslAdjustment>][])hsl[band]={hue:0,saturation:0,lightness:0,...hsl[band],...values};grade.hsl=hsl;}
    // A channel patched to undefined is reset: it is removed instead of merged back in.
    if(grade&&patch?.curves){const curves={...clip.colorGrade?.curves,...patch.curves};for(const channel of Object.keys(curves) as ColorChannel[])if(curves[channel]===undefined)delete curves[channel];if(Object.keys(curves).length)grade.curves=curves;else delete grade.curves;}
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
  let next=project;const required=new Set([...walkClips(clips)].flatMap(c=>c.colorGrade?.lutId?[c.colorGrade.lutId]:[]));
  for(const id of required){const lut=available.find(l=>l.id===id);if(lut)next=addColorLut(next,lut);else if(!next.colorLuts?.some(l=>l.id===id))throw new Error('복사한 클립의 LUT 데이터가 없습니다.');}
  return next;
}

type ClipColor = Pick<Clip,'brightness'|'contrast'|'saturation'|'blur'|'preset'|'colorGrade'>;
export interface ColorSelection {values:ClipColor;lut?:ColorLut}
export function copyClipColor(project:Project,clip:Clip):ColorSelection {
  const {brightness,contrast,saturation,blur,preset,colorGrade}=clip;
  return {values:{brightness,contrast,saturation,blur,preset,colorGrade:colorGrade&&structuredClone(colorGrade)},
    lut:colorGrade?.lutId?project.colorLuts?.find(item=>item.id===colorGrade.lutId):undefined};
}

export function pasteClipColor(project:Project,ids:ReadonlySet<string>,source:ColorSelection):Project {
  const tracks=new Set(project.tracks.filter(track=>track.type==='video'&&!track.locked).map(track=>track.id));
  const media=new Set(project.media.filter(asset=>asset.kind!=='audio').map(asset=>asset.id));
  const values=source.values;
  let changed=false;
  const clips=project.clips.map(clip=>{
    if(!ids.has(clip.id)||!tracks.has(clip.trackId)||!clip.mediaId||!media.has(clip.mediaId)||clip.text!==undefined)return clip;
    if(clip.brightness===values.brightness&&clip.contrast===values.contrast&&clip.saturation===values.saturation&&clip.blur===values.blur&&clip.preset===values.preset&&JSON.stringify(clip.colorGrade)===JSON.stringify(values.colorGrade))return clip;
    changed=true;
    return {...clip,...values,colorGrade:values.colorGrade&&structuredClone(values.colorGrade)};
  });
  if(!changed)return project;
  const restored=source.lut?addColorLut(project,source.lut):project;
  if(values.colorGrade)assertColorGrade(values.colorGrade,new Set(restored.colorLuts?.map(lut=>lut.id)));
  return {...restored,version:10,clips};
}
