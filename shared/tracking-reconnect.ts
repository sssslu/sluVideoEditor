import type {Project} from './types';
import type {MotionAnalysis,MotionBinding} from './tracking';
import type {ProjectFileReference} from './project-files';
import {assertProject} from './validation';

export interface TrackingReconnectResult {analysis:MotionAnalysis;reference:ProjectFileReference}
export interface TrackingReconnectTarget {
  projectId:string;clipId:string;binding:MotionBinding;analysis:MotionAnalysis;reference?:ProjectFileReference;
  media:{id:string;path:string;sourceRevision?:string};
}
export function planTrackingReconnect(project:Project,clipId:string):TrackingReconnectTarget {
  const clip=project.clips.find(c=>c.id===clipId),binding=clip?.motionBinding,analysis=project.motionPaths?.find(a=>a.id===binding?.analysisId),media=project.media.find(m=>m.id===analysis?.mediaId);
  if(!clip||!binding||!analysis||!media)throw new Error('추적이 연결된 클립을 선택하세요.');
  return structuredClone({projectId:project.id,clipId,binding,analysis,reference:project.fileReferences?.find(r=>r.kind==='tracking'&&r.id===analysis.id),media:{id:media.id,path:media.path,sourceRevision:media.sourceRevision}});
}
/** Only the shared artifact reference changes. Keep simultaneous unrelated
 * edits, clip transforms and locks; one history entry restores all followers. */
export function applyTrackingReconnect(project:Project,target:TrackingReconnectTarget,result:TrackingReconnectResult):Project {
  const clip=project.clips.find(c=>c.id===target.clipId),analysis=project.motionPaths?.find(a=>a.id===target.analysis.id),ref=project.fileReferences?.find(r=>r.kind==='tracking'&&r.id===target.analysis.id),media=project.media.find(m=>m.id===target.media.id);
  if(project.id!==target.projectId||!media||media.path!==target.media.path||media.sourceRevision!==target.media.sourceRevision||JSON.stringify(clip?.motionBinding)!==JSON.stringify(target.binding)||JSON.stringify(analysis)!==JSON.stringify(target.analysis)||JSON.stringify(ref)!==JSON.stringify(target.reference))throw new Error('연결 확인 중 프로젝트, 원본 또는 추적 연결이 변경되어 적용하지 않았습니다.');
  const a=result.analysis,unchanged=['version','id','mediaId','sourceWidth','sourceHeight','analysisWidth','analysisHeight','start','end','firstFrameTime','frames','backend'] as const;
  if(unchanged.some(k=>a[k]!==target.analysis[k])||JSON.stringify(a.anchors)!==JSON.stringify(target.analysis.anchors)||![target.analysis.sourceRevision,media.sourceRevision].includes(a.sourceRevision)||result.reference.kind!=='tracking'||result.reference.id!==a.id)throw new Error('복구한 추적 정보가 기존 연결과 다릅니다.');
  const next={...project,motionPaths:project.motionPaths!.map(old=>old.id===a.id?a:old),fileReferences:[...(project.fileReferences||[]).filter(r=>r.kind!=='tracking'||r.id!==a.id),result.reference]};assertProject(next);return next;
}
