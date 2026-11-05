import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,rename,rm,readFile,readdir,stat,lstat} from 'node:fs/promises';
import type {Project} from '../shared/types';
import {assertProject} from '../shared/validation';
const writes=new Map<string,Promise<void>>();
/** Queue the whole manual-save operation, including asynchronous validation
 * and destination dialogs, before the per-file atomic write is reached. */
export class ProjectSaveQueue {
  private pending:Promise<void>=Promise.resolve();
  run<T>(save:()=>Promise<T>):Promise<T>{
    const result=this.pending.then(save);
    this.pending=result.then(()=>{},()=>{});
    return result;
  }
  flush(){return this.pending;}
}
export function serializeProject(project:Project,pretty=false):string {assertProject(project);const content=JSON.stringify(project,null,pretty?2:undefined);if(Buffer.byteLength(content,'utf8')>50*1024*1024)throw new Error('프로젝트 파일이 50 MB를 넘습니다. 사용하지 않는 LUT를 정리하거나 일부 미디어·자막을 별도 프로젝트로 옮기세요.');return content;}
export async function readProject(file:string):Promise<Project>{if((await stat(file)).size>50*1024*1024)throw new Error('프로젝트 파일이 너무 큽니다.');const project=JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));assertProject(project);return {...project,version:10};}
export async function replaceWithRetry(from:string,to:string){
  for(let attempt=0;;attempt++)try{await rename(from,to);return;}catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(process.platform!=='win32'||!['EPERM','EBUSY','EACCES'].includes(code||'')||attempt>=12)throw error;
    // Windows indexing, anti-virus and OneDrive can briefly deny replacing an
    // open destination. Keep both complete files intact; never unlink the old one.
    await new Promise(resolve=>setTimeout(resolve,Math.min(250,25*2**attempt)));
  }
}
/** Repair an application-owned runtime without leaving a partially replaced installation. */
export async function publishRuntimeDirectory(staging:string,destination:string){
  if(path.dirname(path.resolve(staging))!==path.dirname(path.resolve(destination)))throw new Error('음성 엔진 설치 경로 오류');
  const previous=await lstat(destination).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
  if(previous&&(!previous.isDirectory()||previous.isSymbolicLink()))throw new Error('음성 엔진 폴더가 올바르지 않습니다.');
  const backup=`${destination}.previous-${randomUUID()}`;let moved=false;
  if(previous){await replaceWithRetry(destination,backup);moved=true;}
  try{await replaceWithRetry(staging,destination);}catch(error){if(moved)await replaceWithRetry(backup,destination);throw error;}
  if(moved)await rm(backup,{recursive:true,force:true}).catch(()=>{});
}
/** Serialize writes to a destination; a slow earlier save cannot replace a newer save. */
export function atomicWrite(file:string,content:string):Promise<void>{
  const canonical=path.resolve(file),key=process.platform==='win32'?canonical.toLowerCase():canonical;
  const operation=(writes.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{
    const temporary=`${canonical}.${randomUUID()}.tmp`;await mkdir(path.dirname(canonical),{recursive:true});
    try{const handle=await open(temporary,'wx');try{await handle.writeFile(content,'utf8');await handle.sync();}finally{await handle.close();}await replaceWithRetry(temporary,canonical);}finally{await rm(temporary,{force:true}).catch(()=>{});}
  });writes.set(key,operation);void operation.finally(()=>{if(writes.get(key)===operation)writes.delete(key);}).catch(()=>{});return operation;
}
const recoveryKey=(id:string)=>createHash('sha256').update(id).digest('hex');
export async function saveRecovery(root:string,project:Project){
  const directory=path.join(root,'recoveries'),content=serializeProject(project);
  await atomicWrite(path.join(directory,`${recoveryKey(project.id)}.sluproj`),content);
  await atomicWrite(path.join(root,'recovery.sluproj'),content);
}
export async function listRecoveries(root:string){
  const directory=path.join(root,'recoveries');const entries=await readdir(directory).catch(()=>[]);
  const results: {id:string;name:string;updatedAt:string;clips:number}[]=[];
  for(const entry of entries){if(!/^[a-f0-9]{64}\.sluproj$/.test(entry))continue;try{const file=path.join(directory,entry);if((await stat(file)).size>50*1024*1024)continue;const project=JSON.parse(await readFile(file,'utf8'));assertProject(project);results.push({id:project.id,name:project.name,updatedAt:project.updatedAt,clips:project.clips.length});}catch{/* A malformed recovery must not prevent other recoveries from opening. */}}
  return results.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,100);
}
export async function loadRecovery(root:string,id:string):Promise<Project|null>{
  if(typeof id!=='string'||!id||id.length>128)throw new Error('잘못된 복구 ID입니다.');
  try{const file=path.join(root,'recoveries',`${recoveryKey(id)}.sluproj`);if((await stat(file)).size>50*1024*1024)return null;const project=JSON.parse(await readFile(file,'utf8'));assertProject(project);return project.id===id?project:null;}catch{return null;}
}
