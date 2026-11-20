import type {Project} from '../../shared/types';
import {editCaptionText} from '../../shared/captions';

export interface CaptionReplaceReport {changedClips:number;occurrences:number;lockedMatches:number}
/** Literal, case-sensitive replacement; one returned project is one history edit. */
export function replaceCaptionText(project:Project,find:string,replacement:string):CaptionReplaceReport&{project:Project}{
  const report:CaptionReplaceReport={changedClips:0,occurrences:0,lockedMatches:0};
  if(!find||find===replacement)return {project,...report};
  if(find.length>20000||replacement.length>20000||replacement.includes('\0'))throw new Error('찾거나 바꿀 내용은 널 문자 없이 20,000자 이내로 입력하세요.');
  const locked=new Set(project.tracks.filter(track=>track.locked).map(track=>track.id));
  const clips=project.clips.map(clip=>{
    const text=clip.text;if(text===undefined)return clip;
    let count=0;for(let at=text.indexOf(find);at>=0;at=text.indexOf(find,at+find.length))count++;
    if(!count)return clip;if(locked.has(clip.trackId)){report.lockedMatches+=count;return clip;}
    if(text.length+count*(replacement.length-find.length)>20000)throw new Error(`바꾸면 “${clip.name}” 자막이 20,000자를 넘습니다. 아무 내용도 바꾸지 않았습니다.`);
    report.changedClips++;report.occurrences+=count;
    return editCaptionText(clip,text.split(find).join(replacement));
  });
  return {project:report.changedClips?{...project,clips}:project,...report};
}
