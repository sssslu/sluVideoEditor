import path from 'node:path';
import {promises as fs} from 'node:fs';
import {randomUUID} from 'node:crypto';
import type {Project} from '../shared/types';
import type {MotionAnalysis} from '../shared/tracking';
import type {ProjectFileReference} from '../shared/project-files';
import {assertProject} from '../shared/validation';
import {atomicWrite,serializeProject} from './project-store';
import {fileDigests,verifyDigest,checkAbort,copyAsset,assetDirectory,relativeAsset,publishAsset,type FileDigest} from './file-digest';
import {requireSourceRevision,readSourceRevision} from './source-revision';
import {assertOutputNotSource,pathKey,localFilePath,insideDirectory} from './file-policy';
import {MotionFileReader,rebaseMotionFile} from './tracking-file';
import {sameAnalysis,type TrackingRegistry} from './tracking-registry';
import type {TrackingReconnectResult} from '../shared/tracking-reconnect';

type Progress=(progress:number,message:string)=>void;
function assertLocalPaths(project:Project){assertProject(project);if([...project.media.map(m=>m.path),...(project.motionPaths||[]).map(a=>a.path)].some(file=>!localFilePath(file)))throw new Error('프로젝트에는 로컬 파일의 절대 경로가 필요합니다.');}
const reference=(kind:ProjectFileReference['kind'],id:string,digest:FileDigest,relativePath?:string):ProjectFileReference=>({kind,id,sha256:digest.sha256,bytes:digest.bytes,revision:digest.revision,...(relativePath?{relativePath}:{})});
const sourceIdentity=(digest:FileDigest):NonNullable<ProjectFileReference['source']>=>({sha256:digest.sha256,bytes:digest.bytes,revision:digest.revision});
function trackingSource(project:Project,analysis:MotionAnalysis,ref?:ProjectFileReference){
  if(ref?.source?.revision===analysis.sourceRevision)return {...ref.source};
  const media=project.fileReferences?.find(r=>r.kind==='media'&&r.id===analysis.mediaId&&r.revision===analysis.sourceRevision);
  return media?sourceIdentity(media):undefined;
}
async function verifyAnalysis(analysis:MotionAnalysis,expected?:ProjectFileReference,signal?:AbortSignal){
  const digest=expected?await verifyDigest(analysis.path,expected,signal):await fileDigests.read(analysis.path,signal);
  const reader=await MotionFileReader.open(analysis.path);try{if(!sameAnalysis(reader.metadata,analysis))throw new Error('프로젝트와 추적 경로 파일의 정보가 일치하지 않습니다.');}finally{await reader.close();}
  await requireSourceRevision(analysis.path,digest.revision);return digest;
}
async function rebasedArtifact(analysis:MotionAnalysis,digest:FileDigest,revision:string,directory:string,signal?:AbortSignal){
  await fs.mkdir(directory,{recursive:true});const temporary=path.join(directory,`.tracking-${randomUUID()}.tmp`);
  try{
    await requireSourceRevision(analysis.path,digest.revision);
    const rebased=await rebaseMotionFile(analysis.path,temporary,revision,signal);
    await requireSourceRevision(analysis.path,digest.revision);const hash=await fileDigests.read(temporary,signal);
    let target=path.join(directory,hash.sha256+'.slutrack');
    try{const stat=await fs.lstat(target);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('기존 파일이 다른 위치에 연결되어 있습니다.');const existing=await verifyDigest(target,hash,signal);return {analysis:{...rebased,path:target},digest:existing};}catch(error){checkAbort(signal);if((error as NodeJS.ErrnoException).code!=='ENOENT')target=path.join(directory,`${hash.sha256}-${randomUUID()}.slutrack`);}
    checkAbort(signal);try{await publishAsset(temporary,target,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    await fs.rm(temporary,{force:true});
    return {analysis:{...rebased,path:target},digest:await verifyDigest(target,hash,signal)};
  }finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
}

/** Publish JSON last: interruption never replaces the last usable project with
 * an incomplete collection. Completed immutable assets may be reused next time.
 * Ordinary saves collect tracking; explicit collection also copies all media. */
export async function saveProjectWithAssets(project:Project,file:string,options:{collect?:boolean;registry?:TrackingRegistry;signal?:AbortSignal;progress?:Progress;warning?:(message:string)=>void}={}){
  assertLocalPaths(project);serializeProject(project);checkAbort(options.signal);if(!localFilePath(file))throw new Error('로컬 프로젝트 저장 경로를 선택하세요.');
  await assertOutputNotSource(file,[...project.media.map(m=>m.path),...(project.motionPaths||[]).map(a=>a.path)]);
  await fs.mkdir(path.dirname(file),{recursive:true});const projectRoot=await fs.realpath(path.dirname(file));
  const result=structuredClone(project);result.version=10;result.updatedAt=new Date().toISOString();
  const refs:ProjectFileReference[]=[],sources=new Map<string,FileDigest>(),original=new Map(project.media.map(m=>[m.id,m])),missingTracking=new Set<string>();
  const work=project.media.length+(project.motionPaths?.length||0),progress=(index:number,fraction:number,message:string)=>options.progress?.((index+fraction)/Math.max(1,work),message);
  let directory:string|undefined;const getDirectory=async()=>directory??=await assetDirectory(file);
  const relative=(asset:string)=>path.relative(projectRoot,asset).split(path.sep).join('/');
  for(let index=0;index<result.media.length;index++){
    checkAbort(options.signal);const media=result.media[index],old=project.fileReferences?.find(r=>r.kind==='media'&&r.id===media.id);
    if(!options.collect&&!old&&!project.motionPaths?.some(a=>a.mediaId===media.id))continue;
    let digest:FileDigest;
    try{digest=await fileDigests.read(media.path,options.signal,(bytes,total)=>progress(index,.4*bytes/Math.max(1,total),`${media.name} 확인 중`));}
    catch(error){if(!options.collect&&(error as NodeJS.ErrnoException).code==='ENOENT'){if(old)refs.push({...old,relativePath:undefined});continue;}throw error;}
    // Metadata must describe the bytes being collected. Changed files need the
    // established probe/refresh path instead of inheriting obsolete timing.
    if(options.collect&&media.sourceRevision&&digest.revision!==media.sourceRevision)throw new Error(`원본이 변경되었습니다. 프로젝트를 다시 연 뒤 모아 저장하세요: ${media.name}`);
    sources.set(media.id,digest);
    if(options.collect){
      const copied=await copyAsset(media.path,await getDirectory(),digest,options.signal,(bytes,total)=>progress(index,.4+.5*bytes/Math.max(1,total),`${media.name} 복사 중`));
      media.path=copied.path;media.sourceRevision=copied.revision;delete media.proxyPath;delete media.thumbnail;
      refs.push(reference('media',media.id,copied,relative(copied.path)));
    }else{
      // A save-as outside the collected folder must not retain a relative path
      // which would unexpectedly select a different nearby file on next open.
      let local:string|undefined;
      if(old?.relativePath){const candidate=await relativeAsset(file,old.relativePath);if(candidate&&pathKey(candidate)===pathKey(media.path))local=old.relativePath;}
      refs.push(reference('media',media.id,digest,local));
    }
    progress(index,1,`${media.name} 확인 완료`);
  }
  for(let index=0;index<(result.motionPaths?.length||0);index++){
    checkAbort(options.signal);const analysis=result.motionPaths![index],approved=options.registry?.referenceFor(analysis),old=project.fileReferences?.find(r=>r.kind==='tracking'&&r.id===analysis.id)??approved,sourceDigest=sources.get(analysis.mediaId);
    const identity=sourceDigest?.revision===analysis.sourceRevision?sourceIdentity(sourceDigest):options.registry?approved?.source:trackingSource(project,analysis,old);
    let digest:FileDigest;
    try{if(options.registry)await options.registry.verifyArtifact(analysis,options.signal);digest=await verifyAnalysis(analysis,old,options.signal);}
    catch(error){if(!options.collect&&(error as NodeJS.ErrnoException).code==='ENOENT'){missingTracking.add(analysis.id);if(old)refs.push({...old,source:identity,relativePath:undefined});continue;}throw error;}
    const source=original.get(analysis.mediaId)!,copiedSource=result.media.find(m=>m.id===analysis.mediaId)!;
    let saved:MotionAnalysis,savedDigest:FileDigest;
    if(options.collect&&sourceDigest&&analysis.sourceRevision===source.sourceRevision&&sourceDigest.revision===analysis.sourceRevision){
      const rebased=await rebasedArtifact(analysis,digest,copiedSource.sourceRevision!,await getDirectory(),options.signal);saved=rebased.analysis;savedDigest=rebased.digest;
    }else{
      const copied=await copyAsset(analysis.path,await getDirectory(),digest,options.signal);saved={...analysis,path:copied.path};savedDigest=copied;
    }
    result.motionPaths![index]=saved;refs.push({...reference('tracking',saved.id,savedDigest,relative(saved.path)),...(identity?{source:{...identity,revision:saved.sourceRevision}}:{})});
    progress(result.media.length+index,1,'추적 경로 저장 중');
  }
  // Recheck originals after the entire copy, not only after each individual
  // asset, so concurrent replacement cannot publish a mixed collection.
  for(const [id,digest] of sources)await requireSourceRevision(original.get(id)!.path,digest.revision);
  for(const analysis of project.motionPaths||[])if(options.registry&&!missingTracking.has(analysis.id))await options.registry.verifyArtifact(analysis,options.signal);
  result.fileReferences=refs.length?refs:undefined;checkAbort(options.signal);
  await atomicWrite(file,serializeProject(result,true));options.progress?.(1,'프로젝트 저장 완료');if(missingTracking.size)options.warning?.(`편집 내용은 저장했지만 추적 파일 ${missingTracking.size}개를 찾지 못했습니다. 연결된 클립의 객체 추적에서 파일을 다시 연결하세요.`);return result;
}

/** Apply a verified source relocation. A matching filename, size or timestamp
 * alone never authorizes carrying motion over to another source. */
export async function relocateProjectSources(project:Project,replacements:ReadonlyMap<string,string>,cacheDirectory:string,signal?:AbortSignal):Promise<Project>{
  assertLocalPaths(project);for(const replacement of replacements.values())if(!localFilePath(replacement))throw new Error('로컬 원본 파일을 선택하세요.');
  const result=structuredClone(project),verified=new Map<string,FileDigest>();
  // Capture legacy source proof before media references move to a new revision.
  for(const a of result.motionPaths||[]){const ref=result.fileReferences?.find(r=>r.kind==='tracking'&&r.id===a.id),identity=trackingSource(project,a,ref);if(ref&&identity)ref.source=identity;}
  for(const media of result.media){
    const replacement=replacements.get(media.id);if(!replacement)continue;
    const ref=result.fileReferences?.find(r=>r.kind==='media'&&r.id===media.id),old=media.sourceRevision;
    const changedPath=pathKey(media.path)!==pathKey(replacement);media.path=replacement;
    if(changedPath){delete media.proxyPath;delete media.thumbnail;}
    if(!ref||ref.revision!==old)continue;
    try{
      const revision=await readSourceRevision(replacement);if(!changedPath&&revision===old&&!result.motionPaths?.some(a=>a.mediaId===media.id&&a.sourceRevision!==revision))continue;
      const digest=await fileDigests.read(replacement,signal);if(digest.sha256!==ref.sha256||digest.bytes!==ref.bytes)continue;
      verified.set(media.id,digest);media.sourceRevision=digest.revision;delete media.proxyPath;delete media.thumbnail;
      Object.assign(ref,{revision:digest.revision});
    }catch(error){checkAbort(signal);if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  for(let index=0;index<(result.motionPaths?.length||0);index++){
    const analysis=result.motionPaths![index],source=verified.get(analysis.mediaId);if(!source||analysis.sourceRevision===source.revision)continue;
    const ref=result.fileReferences?.find(r=>r.kind==='tracking'&&r.id===analysis.id);
    // Legacy projects have no independently recorded artifact hash. Do not
    // bless their data during automatic relocation; normal reads still work.
    if(!ref?.source||ref.source.sha256!==source.sha256||ref.source.bytes!==source.bytes)continue;
    let digest:FileDigest;try{digest=await verifyAnalysis(analysis,ref,signal);}catch{checkAbort(signal);continue;}
    const rebased=await rebasedArtifact(analysis,digest,source.revision,cacheDirectory,signal);
    result.motionPaths![index]=rebased.analysis;Object.assign(ref,reference('tracking',analysis.id,rebased.digest),{source:sourceIdentity(source)});delete ref.relativePath;
  }
  for(const [id,digest] of verified)await requireSourceRevision(result.media.find(m=>m.id===id)!.path,digest.revision);
  assertProject(result);return result;
}

/** Prefer project-local assets even when the original absolute paths still
 * exist. The user may have intentionally copied a project to another drive. */
export async function resolveProjectAssets(project:Project,file:string,cacheDirectory:string,signal?:AbortSignal){
  assertLocalPaths(project);const result=structuredClone(project),replacements=new Map<string,string>();
  for(const ref of result.fileReferences||[]){
    if(!ref.relativePath)continue;const candidate=await relativeAsset(file,ref.relativePath);if(!candidate)continue;
    if(ref.kind==='media')replacements.set(ref.id,candidate);
    else result.motionPaths!.find(a=>a.id===ref.id)!.path=candidate;
  }
  for(const media of result.media)if(!replacements.has(media.id))replacements.set(media.id,media.path);
  return relocateProjectSources(result,replacements,cacheDirectory,signal);
}

/** A selected backup must match the independently recorded artifact hash AND
 * semantic header. Moving its source is allowed only with verified source
 * bytes. Always publish at a fresh immutable path so preview error/page caches
 * cannot retain a prior failure for the repaired reference. */
export async function reconnectTrackingFile(project:Project,id:string,replacement:string,directory:string,options:{registry?:TrackingRegistry;signal?:AbortSignal;progress?:Progress}={}):Promise<TrackingReconnectResult>{
  assertLocalPaths(project);if(!localFilePath(replacement)||!localFilePath(directory))throw new Error('로컬 추적 파일과 저장 폴더를 선택하세요.');checkAbort(options.signal);
  const analysis=project.motionPaths?.find(a=>a.id===id);if(!analysis)throw new Error('추적 경로가 프로젝트에 없습니다.');
  const expected=options.registry?options.registry.referenceFor(analysis):project.fileReferences?.find(r=>r.kind==='tracking'&&r.id===id);
  if(!expected)throw new Error('이 프로젝트에는 추적 파일 확인 정보가 없습니다. 원본 영상에서 다시 분석하세요.');
  const picked={...analysis,path:replacement};options.progress?.(.02,'추적 파일 확인 중');
  const digest=await verifyAnalysis(picked,expected,options.signal),media=project.media.find(m=>m.id===analysis.mediaId)!;
  // A legacy media reference is not analysis provenance after arbitrary source
  // edits. Trusted project opening upgrades it in relocateProjectSources or the
  // registry; never infer a new relationship from a renderer-supplied hash.
  let identity=expected.source?{...expected.source}:undefined,source:FileDigest|undefined;
  try{source=await fileDigests.read(media.path,options.signal,(n,total)=>options.progress?.(.1+.5*n/Math.max(1,total),'원본 영상 확인 중'));}
  catch(error){checkAbort(options.signal);if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(source){
    if(source.revision!==media.sourceRevision)throw new Error('연결 확인 중 원본 영상이 변경되었습니다. 프로젝트를 다시 열어 주세요.');
    if(identity){if(identity.sha256!==source.sha256||identity.bytes!==source.bytes)throw new Error('현재 원본 영상은 추적 당시의 파일과 다릅니다. 다시 분석하세요.');}
    else if(analysis.sourceRevision!==source.revision)throw new Error('이전 추적 원본을 확인할 정보가 없습니다. 다시 분석하세요.');
    identity=sourceIdentity(source);
  }
  await fs.mkdir(directory,{recursive:true});const work=await fs.mkdtemp(path.join(directory,'.tracking-reconnect-')),target=path.join(directory,`tracking-${randomUUID()}.slutrack`);let published=false,complete=false;
  try{
    let prepared:MotionAnalysis;
    if(source&&source.revision!==analysis.sourceRevision)prepared=(await rebasedArtifact(picked,digest,source.revision,work,options.signal)).analysis;
    else{const copy=await copyAsset(replacement,work,digest,options.signal,(n,total)=>options.progress?.(.6+.25*n/Math.max(1,total),'추적 파일 복원 중'));prepared={...picked,path:copy.path};}
    checkAbort(options.signal);await requireSourceRevision(replacement,digest.revision);if(source)await requireSourceRevision(media.path,source.revision);
    await publishAsset(prepared.path,target,options.signal);published=true;
    const stored=await fileDigests.read(target,options.signal);await requireSourceRevision(replacement,digest.revision);if(source)await requireSourceRevision(media.path,source.revision);checkAbort(options.signal);
    const result={analysis:{...prepared,path:target},reference:{...reference('tracking',id,stored),...(identity?{source:identity}:{})}};complete=true;options.progress?.(1,'추적 파일 연결 완료');return result;
  }finally{
    if(published&&!complete)await fs.rm(target,{force:true}).catch(()=>{});
    const realWork=await fs.realpath(work).catch(()=>undefined),realDirectory=await fs.realpath(directory).catch(()=>undefined);if(realWork&&realDirectory&&insideDirectory(realWork,realDirectory))await fs.rm(work,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
  }
}
