import type {Clip,Project,Track,Transition} from '../shared/types';
import {uid} from '../shared/project';
import {walkClips} from '../shared/clip-tree';
import {copyMotionBindings,restoreMotionPaths} from '../shared/motion';
import {restoreColorLuts} from '../shared/color-edits';
import {copyTransitions} from '../shared/transition-edits';
import {clipMediaAvailable} from '../shared/processing';
import {assertProject} from '../shared/validation';
import {settleOverlaps} from './timeline-model';

export interface ClipClipboard {
  projectId:string;
  clips:Clip[];
  tracks:Track[];
  transitions:Transition[];
  fps:number;
  colorLuts:NonNullable<Project['colorLuts']>;
  motionPaths:NonNullable<Project['motionPaths']>;
}

export function captureClipClipboard(project:Project,selected:readonly string[],onlyUnlocked=false):ClipClipboard|null {
  const chosen=new Set(selected),tracks=new Map(project.tracks.map(track=>[track.id,track]));
  const source=project.clips.filter(clip=>chosen.has(clip.id)&&(!onlyUnlocked||!tracks.get(clip.trackId)?.locked));
  if(!source.length)return null;
  const clips=copyMotionBindings(project,structuredClone(source),new Map(),0),ids=new Set(clips.map(clip=>clip.id));
  const nested=[...walkClips(clips)],luts=new Set(nested.map(clip=>clip.colorGrade?.lutId)),paths=new Set(nested.map(clip=>clip.motionBinding?.analysisId));
  return {
    projectId:project.id,clips,tracks:structuredClone(project.tracks),fps:project.fps,
    colorLuts:structuredClone((project.colorLuts||[]).filter(lut=>luts.has(lut.id))),
    motionPaths:structuredClone((project.motionPaths||[]).filter(path=>paths.has(path.id))),
    transitions:structuredClone((project.transitions||[]).filter(transition=>ids.has(transition.fromClipId)&&ids.has(transition.toClipId))),
  };
}

/** Restore cut-away tracks in their original layer order without moving surviving tracks. */
function restoreTracks(project:Project,clipboard:ClipClipboard,clips:readonly Clip[]):Track[] {
  const tracks=[...project.tracks],required=new Set(clips.map(clip=>clip.trackId));
  const missing=clipboard.tracks.filter(track=>required.has(track.id)&&!tracks.some(current=>current.id===track.id));
  if(tracks.length+missing.length>100)throw new Error('프로젝트당 최대 100개 트랙을 지원합니다.');
  for(const track of missing){
    const original=clipboard.tracks.findIndex(value=>value.id===track.id);
    const next=clipboard.tracks.slice(original+1).find(value=>tracks.some(current=>current.id===value.id));
    const previous=clipboard.tracks.slice(0,original).reverse().find(value=>tracks.some(current=>current.id===value.id));
    const index=next?tracks.findIndex(value=>value.id===next.id):previous?tracks.findIndex(value=>value.id===previous.id)+1:tracks.length;
    tracks.splice(index,0,structuredClone(track));
  }
  return tracks;
}

export function pasteClipClipboard(project:Project,clipboard:ClipClipboard|null,time:number):{project:Project;selected:string[]}|null {
  if(!clipboard)return null;
  const tracks=new Map(project.tracks.map(track=>[track.id,track])),originalTracks=new Map(clipboard.tracks.map(track=>[track.id,track]));
  const source=clipboard.clips.filter(clip=>{
    const current=tracks.get(clip.trackId),original=originalTracks.get(clip.trackId);
    return current?!current.locked:clipboard.projectId===project.id&&!!original&&!original.locked;
  });
  if(!source.length)return null;
  if(source.some(clip=>!clipMediaAvailable(clip,project.media)))throw new Error('복사한 클립의 원본 미디어가 없습니다. 미디어 삭제를 취소한 뒤 붙여넣으세요.');
  const first=Math.min(...source.map(clip=>clip.start)),ids=new Map(source.map(clip=>[clip.id,uid()]));
  // Cut sources no longer exist in the live project. Keep clipboard originals in
  // this lookup so links within the copied selection can still map to the new IDs.
  const lookup={...project,clips:[...project.clips.filter(clip=>!ids.has(clip.id)),...source]};
  const clips=copyMotionBindings(lookup,source.map(clip=>({...structuredClone(clip),id:ids.get(clip.id)!,start:time+clip.start-first})),ids,time-first);
  if(clips.length+project.clips.length>10000||clips.some(clip=>!Number.isFinite(clip.start)||clip.start<0||clip.start+clip.duration>86400))throw new Error('클립 수 또는 타임라인 길이 제한을 넘을 수 없습니다.');
  const restored=restoreMotionPaths(restoreColorLuts(project,clips,clipboard.colorLuts),clips,clipboard.motionPaths);
  const selected=clips.map(clip=>clip.id);
  const candidate=settleOverlaps({...restored,tracks:restoreTracks(project,clipboard,clips),clips:[...project.clips,...clips],transitions:[...(project.transitions||[]),...copyTransitions(clipboard.transitions,ids,uid,clipboard.fps,project.fps)]},selected);
  assertProject(candidate);
  return {project:candidate,selected};
}
