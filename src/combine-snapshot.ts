import type {Project} from '../shared/types';
import {combinationProject} from '../shared/combine';
import {walkClips} from '../shared/clip-tree';

/** Only dependencies that determine the rendered selection belong in the job
 * snapshot. Decoder caches and unrelated edits can finish while it renders. */
export function combinationSignature(project:Project,ids:readonly string[]):string {
  const input=combinationProject(project,ids),luts=new Set([...walkClips(input.clips)].map(clip=>clip.colorGrade?.lutId));
  const byId=<T extends {id:string}>(values:readonly T[])=>[...values].sort((a,b)=>a.id.localeCompare(b.id));
  const snapshot={
    width:input.width,height:input.height,fps:input.fps,background:input.background,
    clips:input.clips,transitions:input.transitions||[],
    tracks:input.tracks.map(({id,type,hidden,muted})=>({id,type,hidden,muted})),
    media:byId(input.media).map(({name,thumbnail,waveform,proxyPath,...source})=>source),
    colorLuts:byId((input.colorLuts||[]).filter(lut=>luts.has(lut.id))),
    motionPaths:byId(input.motionPaths||[]),
  };
  return JSON.stringify(snapshot,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value);
}
