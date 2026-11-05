import type {Project} from '../shared/types';
import {assertMotionAnalysis,type MotionAnalysis} from '../shared/tracking';
import {localFilePath,pathKey} from './file-policy';
import {readSourceRevision,requireSourceRevision} from './source-revision';
import {MotionFileReader} from './tracking-file';
import {checkAbort,fileDigests,verifyDigest,type FileDigest} from './file-digest';
import type {ProjectFileReference} from '../shared/project-files';

/** Compare semantic fields, independent of JSON property order and path case. */
export function sameAnalysis(a:MotionAnalysis,b:MotionAnalysis){
  return ['version','id','mediaId','sourceRevision','sourceWidth','sourceHeight','analysisWidth','analysisHeight','start','end','firstFrameTime','frames','backend'].every(k=>a[k as keyof MotionAnalysis]===b[k as keyof MotionAnalysis])&&pathKey(a.path)===pathKey(b.path)&&a.anchors.length===b.anchors.length&&a.anchors.every((v,i)=>{const w=b.anchors[i];return v.time===w.time&&(['x','y','width','height'] as const).every(k=>v.box[k]===w.box[k]);});
}
interface Entry {analysis:MotionAnalysis;sourcePath:string;artifactRevision?:string;expected?:Pick<FileDigest,'sha256'|'bytes'>;referenceRevision?:string;source?:ProjectFileReference['source'];legacySource?:ProjectFileReference['source']}
/** Project files explicitly opened by the user may approve path references.
 * Missing/obsolete files remain in the project, but cannot produce motion. */
export class TrackingRegistry {
  private entries=new Map<string,Entry>();
  has(file:string){return this.entries.has(pathKey(file));}
  forget(file:string){this.entries.delete(pathKey(file));}
  approveProject(project:Project,pathsApproved=false){
    const pending:Entry[]=[];
    for(const analysis of project.motionPaths||[]){
      assertMotionAnalysis(analysis);const media=project.media.find(m=>m.id===analysis.mediaId);if(!media||!localFilePath(analysis.path))throw new Error('추적 경로의 원본 또는 파일 위치가 올바르지 않습니다.');
      const known=this.entries.get(pathKey(analysis.path)),previous=known&&sameAnalysis(known.analysis,analysis)?known:undefined,ref=project.fileReferences?.find(r=>r.kind==='tracking'&&r.id===analysis.id),expected=ref?{sha256:ref.sha256,bytes:ref.bytes}:previous?.expected;
      const changedHash=!!ref&&(ref.sha256!==known?.expected?.sha256||ref.bytes!==known?.expected?.bytes);
      const source=ref?ref.source:previous?.source,changedSource=!!ref&&JSON.stringify(source)!==JSON.stringify(known?.source);
      const mediaRef=pathsApproved?project.fileReferences?.find(r=>r.kind==='media'&&r.id===analysis.mediaId&&r.revision===analysis.sourceRevision):undefined;
      const legacySource=mediaRef?{sha256:mediaRef.sha256,bytes:mediaRef.bytes,revision:mediaRef.revision}:previous?.legacySource;
      if(!pathsApproved&&(!known||!sameAnalysis(known.analysis,analysis)||changedHash||changedSource))throw new Error('등록되지 않았거나 변경된 추적 경로입니다.');
      if(pathsApproved||!known||known.sourcePath!==media.path||!previous||changedHash||changedSource)pending.push({analysis:structuredClone(analysis),sourcePath:media.path,expected,referenceRevision:ref?.revision??previous?.referenceRevision,source:source?{...source}:undefined,legacySource});
    }
    for(const entry of pending)this.entries.set(pathKey(entry.analysis.path),entry);
  }
  async register(analysis:MotionAnalysis,sourcePath:string,signal?:AbortSignal){
    checkAbort(signal);
    assertMotionAnalysis(analysis);const artifactRevision=await readSourceRevision(analysis.path);await requireSourceRevision(sourcePath,analysis.sourceRevision);
    const reader=await MotionFileReader.open(analysis.path);try{if(!sameAnalysis(reader.metadata,analysis))throw new Error('추적 경로 파일과 작업 정보가 일치하지 않습니다.');}finally{await reader.close();}
    const digest=await fileDigests.read(analysis.path,signal);await requireSourceRevision(analysis.path,artifactRevision);await requireSourceRevision(sourcePath,analysis.sourceRevision);checkAbort(signal);this.entries.set(pathKey(analysis.path),{analysis:structuredClone(analysis),sourcePath,artifactRevision,referenceRevision:artifactRevision,expected:{sha256:digest.sha256,bytes:digest.bytes}});
  }
  /** Retain already verified identity even if the file is later moved/deleted. */
  referenceFor(analysis:MotionAnalysis):ProjectFileReference|undefined {
    const entry=this.entries.get(pathKey(analysis.path));if(!entry||!sameAnalysis(entry.analysis,analysis))throw new Error('등록되지 않았거나 변경된 추적 경로입니다.');
    if(!entry.expected||!entry.referenceRevision)return;
    const source=entry.source??entry.legacySource;return {kind:'tracking',id:analysis.id,...entry.expected,revision:entry.referenceRevision,...(source?{source:{...source}}:{})};
  }
  async read(file:string,time:number,limit=256){
    if(typeof file!=='string'||!localFilePath(file)||!Number.isFinite(time)||!Number.isInteger(limit)||limit<1||limit>4096)throw new Error('추적 경로 읽기 요청이 올바르지 않습니다.');
    const entry=this.entries.get(pathKey(file));if(!entry)throw new Error('등록되지 않은 추적 경로입니다.');
    try{await requireSourceRevision(entry.sourcePath,entry.analysis.sourceRevision);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('추적 원본 영상을 찾을 수 없습니다. 프로젝트를 다시 열고 원본을 연결하세요.');throw error;}
    let revision:string;try{revision=await this.verifyArtifact(entry.analysis);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('추적 파일을 찾을 수 없습니다. 연결된 클립에서 추적 파일 다시 연결을 선택하세요.');throw error;}
    const reader=await MotionFileReader.open(file);
    try{
      if(!sameAnalysis(reader.metadata,entry.analysis))throw new Error('프로젝트와 추적 경로 파일의 정보가 일치하지 않습니다.');
      const range=await reader.range(time,limit);await requireSourceRevision(entry.sourcePath,entry.analysis.sourceRevision);await requireSourceRevision(file,revision);entry.artifactRevision=revision;
      return {metadata:reader.metadata,...range};
    }finally{await reader.close();}
  }
  /** Saving offline edits still verifies the artifact independently of whether
   * its source media is currently online or the analysis is obsolete. */
  async verifyArtifact(analysis:MotionAnalysis,signal?:AbortSignal){
    const entry=this.entries.get(pathKey(analysis.path));if(!entry||!sameAnalysis(entry.analysis,analysis))throw new Error('등록되지 않았거나 변경된 추적 경로입니다.');
    const revision=await requireSourceRevision(analysis.path,entry.artifactRevision);
    if(entry.expected&&!entry.artifactRevision)await verifyDigest(analysis.path,entry.expected,signal);
    const reader=await MotionFileReader.open(analysis.path);try{if(!sameAnalysis(reader.metadata,analysis))throw new Error('프로젝트와 추적 경로 파일의 정보가 일치하지 않습니다.');}finally{await reader.close();}
    await requireSourceRevision(analysis.path,revision);entry.artifactRevision=revision;return revision;
  }
}
