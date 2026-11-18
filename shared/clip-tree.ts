import type {Clip} from './types';

/** Compound originals keep their own clip-ID scope, but share project assets. */
export function* walkClips(clips:readonly Clip[],depth=0):Generator<Clip>{
  if(depth>8)throw new Error('합친 클립이 너무 깊게 겹쳐 있습니다.');
  for(const clip of clips){yield clip;if(clip.compound)yield* walkClips(clip.compound.clips,depth+1);}
}

/** Preserve unchanged snapshots so history can still detect metadata-only edits. */
export function mapClipTree(clips:Clip[],transform:(clip:Clip)=>Clip,depth=0):Clip[]{
  if(depth>8)throw new Error('합친 클립이 너무 깊게 겹쳐 있습니다.');
  let changed=false;const next=clips.map(clip=>{
    let current=clip;
    if(clip.compound){const children=mapClipTree(clip.compound.clips,transform,depth+1);if(children!==clip.compound.clips)current={...clip,compound:{...clip.compound,clips:children}};}
    const result=transform(current);changed ||= result!==clip;return result;
  });return changed?next:clips;
}
