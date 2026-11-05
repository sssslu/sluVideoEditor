import type {Project} from './types';

/** The revision binds a content hash to the precise file which was verified.
 * A stale hash must never authorize rebinding tracking to a replaced source. */
export interface ProjectFileReference {
  kind:'media'|'tracking';id:string;sha256:string;bytes:number;revision:string;relativePath?:string;
  /** The source bytes used by this analysis, independent of the current media
   * path/revision. Keep this while the tracking artifact is offline. */
  source?:{sha256:string;bytes:number;revision:string};
}
const validIdentity=(r:{sha256:string;bytes:number;revision:string})=>!!r&&typeof r==='object'&&typeof r.sha256==='string'&&/^[a-f0-9]{64}$/.test(r.sha256)&&typeof r.revision==='string'&&/^[a-f0-9]{64}$/.test(r.revision)&&Number.isSafeInteger(r.bytes)&&r.bytes>=0;
export function validRelativeAssetPath(value:unknown):value is string {
  return typeof value==='string'&&value.length>0&&value.length<=8192&&!/[\\:\x00-\x1f<>"|?*]/.test(value)&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function assertProjectFiles(project:Project){
  const refs=project.fileReferences;if(refs===undefined)return;
  if(project.version<8||!Array.isArray(refs)||refs.length>3000)throw new Error('프로젝트 파일 연결 정보가 올바르지 않습니다.');
  const media=new Set(project.media.map(m=>m.id)),tracking=new Set(project.motionPaths?.map(a=>a.id)),seen=new Set<string>();
  for(const r of refs){
    if(!r||typeof r!=='object'||!['media','tracking'].includes(r.kind)||typeof r.id!=='string'||!(r.kind==='media'?media:tracking).has(r.id)||!validIdentity(r)||(r.relativePath!==undefined&&!validRelativeAssetPath(r.relativePath))||seen.has(`${r.kind}:${r.id}`))throw new Error('프로젝트 파일 연결 정보가 올바르지 않습니다.');
    if(r.source!==undefined&&(r.kind!=='tracking'||!validIdentity(r.source)||r.source.revision!==project.motionPaths!.find(a=>a.id===r.id)!.sourceRevision))throw new Error('추적 원본 확인 정보가 올바르지 않습니다.');
    seen.add(`${r.kind}:${r.id}`);
  }
}
export function pruneProjectFiles(project:Project):Project {
  if(!project.fileReferences)return project;
  const media=new Set(project.media.map(m=>m.id)),tracking=new Set(project.motionPaths?.map(a=>a.id));
  const refs=project.fileReferences.filter(r=>(r.kind==='media'?media:tracking).has(r.id));
  return refs.length===project.fileReferences.length?project:{...project,fileReferences:refs.length?refs:undefined};
}
