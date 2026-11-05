import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {sourceRevisionFromStat,readSourceRevision,requireSourceRevision} from './source-revision';
import {pathKey,insideDirectory} from './file-policy';
import {CancelledError} from './media';
import {validRelativeAssetPath} from '../shared/project-files';

export interface FileDigest {sha256:string;bytes:number;revision:string}
export function checkAbort(signal?:AbortSignal){if(signal?.aborted)throw new CancelledError();}
/** Bounded streaming reads. Cached hashes are keyed by the complete stat/path
 * revision and every hit re-stats the file; the cache contains no media bytes. */
export class FileDigests {
  private cache=new Map<string,FileDigest>();
  async read(file:string,signal?:AbortSignal,progress?:(bytes:number,total:number)=>void,fresh=false):Promise<FileDigest>{
    checkAbort(signal);const revision=await readSourceRevision(file),key=pathKey(file)+'|'+revision,cached=this.cache.get(key);
    if(cached&&!fresh){checkAbort(signal);return cached;}
    const handle=await fs.open(file,'r');
    try{
      const before=await handle.stat();if(!before.isFile()||sourceRevisionFromStat(file,before)!==revision)throw new Error('파일을 읽는 중 원본이 변경되었습니다.');
      const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let bytes=0;
      while(bytes<before.size){checkAbort(signal);const read=await handle.read(buffer,0,Math.min(buffer.length,before.size-bytes),bytes);if(!read.bytesRead)throw new Error('파일을 끝까지 읽지 못했습니다.');hash.update(buffer.subarray(0,read.bytesRead));bytes+=read.bytesRead;progress?.(bytes,before.size);}
      checkAbort(signal);if(sourceRevisionFromStat(file,await handle.stat())!==revision)throw new Error('파일을 읽는 중 원본이 변경되었습니다.');await requireSourceRevision(file,revision);
      const result={sha256:hash.digest('hex'),bytes,revision};this.cache.set(key,result);if(this.cache.size>512)this.cache.delete(this.cache.keys().next().value!);return result;
    }finally{await handle.close();}
  }
}
export const fileDigests=new FileDigests();
export async function verifyDigest(file:string,expected:Pick<FileDigest,'sha256'|'bytes'>,signal?:AbortSignal){
  const digest=await fileDigests.read(file,signal);if(digest.sha256!==expected.sha256||digest.bytes!==expected.bytes)throw new Error(`파일 내용이 저장 당시와 다릅니다: ${path.basename(file)}`);return digest;
}
/** Resolve only a project-local relative reference, including junction/symlink
 * checks. Missing assets return undefined; unsafe references never fall back. */
export async function relativeAsset(projectFile:string,relative:string):Promise<string|undefined>{
  if(!validRelativeAssetPath(relative))throw new Error('프로젝트의 상대 파일 경로가 올바르지 않습니다.');
  const root=await fs.realpath(path.dirname(projectFile)),candidate=path.resolve(root,...relative.split('/'));
  if(!insideDirectory(candidate,root))throw new Error('프로젝트 폴더를 벗어난 파일 연결입니다.');
  // Check existing ancestors as well, so a dangling junction cannot disguise
  // an out-of-folder path merely because the final file is missing.
  let cursor=root;
  for(const part of relative.split('/')){cursor=path.join(cursor,part);try{const resolved=await fs.realpath(cursor);if(!insideDirectory(resolved,root))throw new Error('프로젝트 폴더 밖으로 연결된 파일입니다.');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
  return candidate;
}
export async function assetDirectory(projectFile:string){
  const root=await fs.realpath(path.dirname(projectFile)),name=path.basename(projectFile,path.extname(projectFile))+'.slu-data';
  if(!validRelativeAssetPath(name))throw new Error('프로젝트 파일 이름을 확인하세요.');
  const directory=path.join(root,name);await fs.mkdir(directory,{recursive:true});
  const actual=await fs.realpath(directory);if(!insideDirectory(actual,root)||pathKey(actual)!==pathKey(directory))throw new Error('프로젝트 데이터 폴더가 다른 위치에 연결되어 있습니다.');return directory;
}
/** The caller owns temporary. Publish a complete immutable file without ever
 * replacing another file. Unsupported hard-link filesystems use exclusive copy. */
export async function publishAsset(temporary:string,destination:string,signal?:AbortSignal){
  checkAbort(signal);
  try{await fs.link(temporary,destination);}catch(error){
    if((error as NodeJS.ErrnoException).code==='EEXIST')throw error;
    // exFAT/removable drives may not support links. Keep this copy cancellable
    // too, and remove only the incomplete file this operation created.
    const input=await fs.open(temporary,'r');let output:Awaited<ReturnType<typeof fs.open>>|undefined,identity:Awaited<ReturnType<typeof fs.stat>>|undefined,complete=false;
    try{
      output=await fs.open(destination,'wx');identity=await output.stat();const buffer=Buffer.alloc(1024*1024);let at=0;
      for(;;){checkAbort(signal);const {bytesRead}=await input.read(buffer,0,buffer.length,at);if(!bytesRead)break;let written=0;while(written<bytesRead){const {bytesWritten}=await output.write(buffer,written,bytesRead-written);if(!bytesWritten)throw new Error('파일을 저장하지 못했습니다.');written+=bytesWritten;}at+=bytesRead;}
      await output.sync();checkAbort(signal);complete=true;
    }finally{
      await input.close();await output?.close();
      if(identity&&!complete){const current=await fs.lstat(destination).catch(()=>undefined);if(current&&current.ino===identity.ino&&current.dev===identity.dev&&!current.isSymbolicLink())await fs.rm(destination,{force:true});}
    }
  }
}
export async function copyAsset(source:string,directory:string,expected:FileDigest,signal?:AbortSignal,progress?:(bytes:number,total:number)=>void){
  checkAbort(signal);await requireSourceRevision(source,expected.revision);
  const ext=path.extname(source).toLowerCase(),base=expected.sha256+ext;
  let destination=path.join(directory,base);
  try{const stat=await fs.lstat(destination);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('기존 파일이 다른 위치에 연결되어 있습니다.');const existing=await verifyDigest(destination,expected,signal);return {path:destination,...existing};}catch(error){checkAbort(signal);if((error as NodeJS.ErrnoException).code!=='ENOENT')destination=path.join(directory,`${expected.sha256}-${randomUUID()}${ext}`);}
  const temporary=path.join(directory,`.copy-${randomUUID()}.tmp`),input=await fs.open(source,'r');let output;
  try{
    output=await fs.open(temporary,'wx');const buffer=Buffer.alloc(1024*1024);let at=0;
    while(at<expected.bytes){checkAbort(signal);const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,expected.bytes-at),at);if(!bytesRead)throw new Error('파일을 복사하는 중 원본이 변경되었습니다.');let written=0;while(written<bytesRead){const {bytesWritten}=await output.write(buffer,written,bytesRead-written);if(!bytesWritten)throw new Error('파일을 복사하지 못했습니다.');written+=bytesWritten;}at+=bytesRead;progress?.(at,expected.bytes);}
    await output.sync();await output.close();output=undefined;await requireSourceRevision(source,expected.revision);await verifyDigest(temporary,expected,signal);checkAbort(signal);
    try{await publishAsset(temporary,destination,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await verifyDigest(destination,expected,signal);}
    await fs.rm(temporary,{force:true});
    return {path:destination,...await verifyDigest(destination,expected,signal)};
  }finally{await input.close();await output?.close();await fs.rm(temporary,{force:true}).catch(()=>{});}
}
