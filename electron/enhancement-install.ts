import {promises as fs,createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {gunzipSync} from 'node:zlib';
import yauzl from 'yauzl';
import {sourceRevisionFromStat} from './source-revision';
import {publishRuntimeDirectory} from './project-store';

export interface EnhancementInstallContext {
  runtimeBase:string;
  manifestPath:string;
  cacheDirectory?:string;
  payloadDirectory?:string;
  licensesDirectory?:string;
}
export type EnhancementInstallProgress=(progress:number,message:string)=>void;
interface Artifact {
  id:string;filename:string;url:string;bytes:number;sha256:string;destination:string;
  unpackedBytes:number;maximumEntries:number;
  archive:{type:'file'|'zip'|'wheel'|'tar.gz';stripPrefix?:string;ignoredPaths?:string[];mappings?:{source:string;destination:string}[]};
}
interface Manifest {
  schemaVersion:1;backendId:string;platform:string;architecture:string;pythonExecutable:string;
  pythonPath:{file:string;content:string};minimumFreeBytes:number;totalDownloadBytes:number;artifacts:Artifact[];
  totalUnpackedBytes:number;licenseFiles:{filename:string;bytes:number;sha256:string}[];
  expectedInstalledFilesSha256:string;
}
interface FileRecord {path:string;bytes:number;sha256:string;revision:string}
interface Registry {version:1;manifestSha256:string;files:FileRecord[]}
export interface EnhancementRuntime {runtimeRoot:string;pythonExecutable:string;manifestSha256:string}
const REGISTRY='.complete.json';
const verifiedFiles=new Map<string,{revision:string;sha256:string}>();
const digest=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';
const aborted=(signal?:AbortSignal)=>{signal?.throwIfAborted();};
export function enhancementInventoryDigest(files:readonly Pick<FileRecord,'path'|'bytes'|'sha256'>[]):string {
  const ordered=files.slice().sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return digest(JSON.stringify(ordered.map(file=>[file.path,file.bytes,file.sha256])));
}
function assertInventory(files:Registry['files'],expected:string) {
  const actualInstalledFilesSha256=enhancementInventoryDigest(files);
  if(actualInstalledFilesSha256!==expected)throw Object.assign(new Error('AI 설치 파일 목록이 배포 정보와 일치하지 않습니다.'),{actualInstalledFilesSha256});
}

function relativePath(value:string):string {
  if(typeof value!=='string'||!value||value.includes('\\')||value.includes(':')||value.includes('\0')||path.posix.isAbsolute(value))throw Error('AI 설치 경로가 유효하지 않습니다.');
  for(const part of value.split('/'))if(!part||part==='.'||part==='..'||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))throw Error('AI 설치 경로가 유효하지 않습니다.');
  return value;
}
function inside(root:string,relative:string):string {
  const result=path.resolve(root,relativePath(relative));
  if(!result.startsWith(path.resolve(root)+path.sep))throw Error('AI 설치 경로를 벗어났습니다.');
  return result;
}
async function realDirectory(directory:string,create=false) {
  const absolute=path.resolve(directory),parent=path.dirname(absolute);
  if(process.platform==='win32'&&absolute.startsWith('\\\\'))throw Error('AI 설치에는 로컬 드라이브를 사용하세요.');
  if(parent!==absolute)await realDirectory(parent);
  if(create)await fs.mkdir(absolute).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const stat=await fs.lstat(absolute);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('AI 설치 폴더는 실제 로컬 폴더여야 합니다.');
}
async function ensureDirectory(directory:string) {
  const parent=path.dirname(path.resolve(directory));
  try {await realDirectory(parent);} catch(error) {if(!missing(error))throw error;await ensureDirectory(parent);}
  await realDirectory(directory,true);
}
async function fileHash(file:string,signal?:AbortSignal):Promise<{sha256:string;revision:string;bytes:number}> {
  aborted(signal);
  const before=await fs.lstat(file);
  if(!before.isFile()||before.isSymbolicLink())throw Error('AI 설치 파일이 유효하지 않습니다.');
  const revision=sourceRevisionFromStat(file,before),cached=verifiedFiles.get(file);
  if(cached?.revision===revision)return {sha256:cached.sha256,revision,bytes:before.size};
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file,{signal}))hash.update(chunk);
  const after=await fs.lstat(file);
  if(sourceRevisionFromStat(file,after)!==revision||after.isSymbolicLink())throw Error('검사 중 AI 파일이 변경되었습니다.');
  const sha256=hash.digest('hex');
  verifiedFiles.set(file,{revision,sha256});
  return {sha256,revision,bytes:after.size};
}
async function load(context:EnhancementInstallContext) {
  const stat=await fs.lstat(context.manifestPath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw Error('AI 설치 목록이 유효하지 않습니다.');
  const raw=await fs.readFile(context.manifestPath),manifest=JSON.parse(raw.toString('utf8')) as Manifest;
  if(manifest.schemaVersion!==1||manifest.platform!==process.platform||manifest.architecture!==process.arch||!Array.isArray(manifest.artifacts)||!manifest.artifacts.length||manifest.artifacts.length>200)throw Error('지원하지 않는 AI 설치 목록입니다.');
  const ids=new Set<string>(),filenames=new Set<string>();let total=0,unpacked=0;
  for(const artifact of manifest.artifacts) {
    relativePath(artifact.id);relativePath(artifact.filename);relativePath(artifact.destination);
    if(artifact.id.includes('/')||artifact.filename.includes('/')||ids.has(artifact.id)||filenames.has(artifact.filename)||!/^https:\/\//.test(artifact.url)||!/^[a-f0-9]{64}$/.test(artifact.sha256)||!Number.isSafeInteger(artifact.bytes)||artifact.bytes<=0||artifact.bytes>32*1024**3||!['file','zip','wheel','tar.gz'].includes(artifact.archive?.type))throw Error('AI 파일 목록이 유효하지 않습니다.');
    ids.add(artifact.id);filenames.add(artifact.filename);total+=artifact.bytes;
    if(!Number.isSafeInteger(artifact.unpackedBytes)||artifact.unpackedBytes<0||artifact.unpackedBytes>64*1024**3||!Number.isSafeInteger(artifact.maximumEntries)||artifact.maximumEntries<1||artifact.maximumEntries>200000)throw Error('AI 압축 용량 목록 오류');
    unpacked+=artifact.unpackedBytes;
    if(artifact.archive.stripPrefix)relativePath(artifact.archive.stripPrefix.replace(/\/$/,''));
    for(const mapping of artifact.archive.mappings||[]) {
      if(!mapping.source.endsWith('/'))throw Error('AI 압축 원본 경로 오류');
      relativePath(mapping.source.slice(0,-1));
      if(mapping.destination) {if(!mapping.destination.endsWith('/'))throw Error('AI 압축 대상 경로 오류');relativePath(mapping.destination.slice(0,-1));}
    }
    for(const ignored of artifact.archive.ignoredPaths||[])relativePath(ignored);
  }
  if(total!==manifest.totalDownloadBytes||total>64*1024**3||!Number.isSafeInteger(manifest.minimumFreeBytes)||manifest.minimumFreeBytes<total||manifest.minimumFreeBytes>1024**4)throw Error('AI 설치 용량이 유효하지 않습니다.');
  if(unpacked!==manifest.totalUnpackedBytes||unpacked>manifest.minimumFreeBytes||!Array.isArray(manifest.licenseFiles)||!manifest.licenseFiles.length)throw Error('AI 설치 또는 라이선스 목록 오류');
  if(!/^[a-f0-9]{64}$/.test(manifest.expectedInstalledFilesSha256))throw Error('AI 설치 파일 목록의 검증 정보가 없습니다.');
  for(const license of manifest.licenseFiles) {relativePath(license.filename);if(!Number.isSafeInteger(license.bytes)||license.bytes<0||!/^[a-f0-9]{64}$/.test(license.sha256))throw Error('AI 라이선스 정보 오류');}
  relativePath(manifest.pythonExecutable);relativePath(manifest.pythonPath.file);
  if(typeof manifest.pythonPath.content!=='string'||manifest.pythonPath.content.length>4096)throw Error('AI Python 경로 설정 오류');
  const manifestSha256=digest(raw),runtimeRoot=path.join(path.resolve(context.runtimeBase),manifestSha256);
  return {manifest,manifestSha256,runtimeRoot,pythonExecutable:inside(runtimeRoot,manifest.pythonExecutable)};
}
async function inventory(root:string,signal?:AbortSignal,directory=root):Promise<string[]> {
  aborted(signal);
  await realDirectory(directory);
  const files:string[]=[];
  for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
    aborted(signal);
    const file=path.join(directory,entry.name),stat=await fs.lstat(file);
    if(stat.isSymbolicLink())throw Error('AI 설치에 링크가 포함되어 있습니다.');
    if(stat.isDirectory())files.push(...await inventory(root,signal,file));
    else if(stat.isFile())files.push(path.relative(root,file).replaceAll('\\','/'));
    else throw Error('AI 설치 파일 종류 오류');
  }
  return files.sort();
}
async function registry(root:string,manifestSha256:string,signal?:AbortSignal):Promise<Registry> {
  aborted(signal);
  const file=path.join(root,REGISTRY),stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024)throw Error('AI 설치 기록 오류');
  const value=JSON.parse(await fs.readFile(file,'utf8')) as Registry;
  if(value.version!==1||value.manifestSha256!==manifestSha256||!Array.isArray(value.files)||!value.files.length||value.files.length>200000)throw Error('AI 설치 기록이 일치하지 않습니다.');
  const paths=new Set<string>();
  for(const record of value.files) {
    relativePath(record.path);
    const key=record.path.toLowerCase();
    if(paths.has(key)||record.path===REGISTRY||!Number.isSafeInteger(record.bytes)||record.bytes<0||!/^[a-f0-9]{64}$/.test(record.sha256)||!/^[a-f0-9]{64}$/.test(record.revision))throw Error('AI 설치 파일 기록 오류');
    paths.add(key);
  }
  const actual=(await inventory(root,signal)).filter(file=>file!==REGISTRY);
  if(JSON.stringify(actual)!==JSON.stringify(value.files.map(file=>file.path).sort()))throw Error('AI 설치 파일 구성이 변경되었습니다.');
  return value;
}
export async function enhancementInstallState(context:EnhancementInstallContext) {
  const state=await load(context);
  try {
    const records=await registry(state.runtimeRoot,state.manifestSha256);
    assertInventory(records.files,state.manifest.expectedInstalledFilesSha256);
    for(const record of records.files) {
      const file=inside(state.runtimeRoot,record.path),stat=await fs.lstat(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==record.bytes||sourceRevisionFromStat(file,stat)!==record.revision)throw Error('AI 설치 파일이 변경되었습니다.');
    }
    return {installed:true,downloadBytes:state.manifest.totalDownloadBytes,model:state.manifest.backendId,runtimeRoot:state.runtimeRoot};
  } catch {return {installed:false,downloadBytes:state.manifest.totalDownloadBytes,model:state.manifest.backendId};}
}
export async function verifyEnhancementRuntime(context:EnhancementInstallContext,signal?:AbortSignal):Promise<EnhancementRuntime> {
  aborted(signal);
  const state=await load(context),records=await registry(state.runtimeRoot,state.manifestSha256,signal);
  assertInventory(records.files,state.manifest.expectedInstalledFilesSha256);
  for(const record of records.files) {
    const actual=await fileHash(inside(state.runtimeRoot,record.path),signal);
    if(actual.bytes!==record.bytes||actual.sha256!==record.sha256)throw Error(`AI 설치 파일이 손상되었습니다. 다시 설치하세요. (${record.path})`);
  }
  if(!records.files.some(record=>record.path===state.manifest.pythonExecutable))throw Error('AI Python 실행 파일이 없습니다.');
  return {runtimeRoot:state.runtimeRoot,pythonExecutable:state.pythonExecutable,manifestSha256:state.manifestSha256};
}

async function acquireLock(root:string) {
  const token=randomUUID(),filename=`owner-${process.pid}-${token}.json`,lock=path.join(root,'.install-lock'),candidate=`${lock}-${token}`;
  await fs.mkdir(candidate);await fs.writeFile(path.join(candidate,filename),JSON.stringify({pid:process.pid}),{flag:'wx'});
  let acquired=false;
  const removeEmpty=async()=>{await fs.rmdir(lock).catch(error=>{if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;});};
  try {
    for(let attempt=0;attempt<8;attempt++) {
      try {await fs.rename(candidate,lock);acquired=true;break;} catch(error) {if(!['EEXIST','ENOTEMPTY','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code||''))throw error;}
      try {
        await realDirectory(lock);
        const owners=await fs.readdir(lock);
        if(owners.length>1)throw Error('AI 설치 잠금 오류');
        if(owners.length) {
          const match=/^owner-(\d+)-[a-f0-9-]{36}\.json$/.exec(owners[0]);
          if(!match)throw Error('AI 설치 잠금 오류');
          let alive=true;
          try {process.kill(Number(match[1]),0);} catch(error) {if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
          if(alive)throw Error('AI 설치가 이미 진행 중입니다.');
          await fs.unlink(path.join(lock,owners[0])).catch(error=>{if(!missing(error))throw error;});
        }
        await removeEmpty();
      } catch(error) {if(!missing(error))throw error;}
    }
    if(!acquired)throw Error('AI 설치 잠금이 변경되었습니다. 다시 시도하세요.');
  } finally {if(!acquired)await fs.rm(candidate,{recursive:true,force:true});}
  return async()=>{await fs.unlink(path.join(lock,filename)).catch(error=>{if(!missing(error))throw error;});await removeEmpty();};
}
async function cleanupStaging(root:string,signal?:AbortSignal) {
  const canonicalRoot=await fs.realpath(root);
  for(const entry of await fs.readdir(root,{withFileTypes:true})) {
    aborted(signal);
    const match=/^\.install-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(entry.name);
    if(!match||!entry.isDirectory()||entry.isSymbolicLink())continue;
    const directory=path.join(root,entry.name),marker=directory+'.owner.json';
    let owner:{pid:number;token:string};
    try {
      const stat=await fs.lstat(marker);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)continue;
      owner=JSON.parse(await fs.readFile(marker,'utf8')) as typeof owner;
    } catch(error) {if(missing(error)||error instanceof SyntaxError)continue;throw error;}
    if(!owner||!Number.isSafeInteger(owner.pid)||owner.pid<1||owner.token!==match[1])continue;
    let dead=false;
    try {process.kill(owner.pid,0);} catch(error) {dead=(error as NodeJS.ErrnoException).code==='ESRCH';}
    if(!dead)continue;
    const canonical=await fs.realpath(directory);
    if(path.dirname(canonical)!==canonicalRoot||path.basename(canonical)!==entry.name)continue;
    await fs.rm(canonical,{recursive:true,force:true,maxRetries:5,retryDelay:100});
    await fs.unlink(marker);
  }
}
async function download(artifact:Artifact,cache:string,payloadDirectory:string|undefined,progress:(bytes:number)=>void,signal?:AbortSignal) {
  const complete=path.join(cache,artifact.sha256),partial=complete+'.part';
  const valid=async(file:string)=>{try {const actual=await fileHash(file,signal);return actual.bytes===artifact.bytes&&actual.sha256===artifact.sha256;}catch(error){aborted(signal);if(!missing(error))throw error;return false;}};
  if(await valid(complete)){progress(artifact.bytes);return complete;}
  await fs.rm(complete,{force:true});
  if(payloadDirectory) {
    await realDirectory(payloadDirectory);
    const source=inside(payloadDirectory,artifact.filename);
    if(await valid(source)){progress(artifact.bytes);return source;}
  }
  let offset=0;
  try {const stat=await fs.lstat(partial);if(!stat.isFile()||stat.isSymbolicLink())throw Error('AI 다운로드 파일 오류');offset=stat.size;} catch(error){if(!missing(error))throw error;}
  if(offset>artifact.bytes) {await fs.unlink(partial);offset=0;}
  if(offset<artifact.bytes) {
    const response=await fetch(artifact.url,{signal,headers:{'Accept-Encoding':'identity',...(offset?{Range:`bytes=${offset}-`}:{})}});
    if(!response.ok||!response.body||response.url&&!response.url.startsWith('https://')) {await response.body?.cancel();throw Error(`AI 다운로드 실패 (HTTP ${response.status})`);}
    if(response.status===206) {
      if(response.headers.get('content-range')!==`bytes ${offset}-${artifact.bytes-1}/${artifact.bytes}`) {await response.body.cancel();throw Error('AI 다운로드 재개 범위 오류');}
    } else if(response.status===200)offset=0;
    else {await response.body.cancel();throw Error('AI 다운로드 응답 오류');}
    const length=response.headers.get('content-length');
    if(length!==null&&Number(length)!==artifact.bytes-offset) {await response.body.cancel();throw Error('AI 다운로드 크기 오류');}
    const handle=await fs.open(partial,offset?'a':'w'),reader=response.body.getReader();
    try {
      while(true) {
        aborted(signal);const {done,value}=await reader.read();if(done)break;
        if(offset+value.byteLength>artifact.bytes)throw Error('AI 다운로드 크기 초과');
        for(let written=0;written<value.byteLength;)written+=(await handle.write(value,written,value.byteLength-written)).bytesWritten;
        offset+=value.byteLength;progress(offset);
      }
      await handle.sync();
    } finally {await handle.close();await reader.cancel().catch(()=>{});}
  }
  aborted(signal);
  if(offset!==artifact.bytes)throw Error('AI 다운로드가 끝나지 않았습니다. 다시 시도하면 이어받습니다.');
  if(!await valid(partial)) {await fs.unlink(partial);throw Error('AI 다운로드 무결성 검사 실패');}
  await fs.rename(partial,complete);return complete;
}
function archivePath(name:string,artifact:Artifact):string|undefined {
  const normalized=name.replace(/\/$/,'');if(!normalized)return undefined;relativePath(normalized);
  if(artifact.archive.ignoredPaths?.includes(normalized))return undefined;
  if(artifact.archive.mappings) {
    const mapping=artifact.archive.mappings.find(item=>normalized.startsWith(item.source));
    return mapping?relativePath(mapping.destination+normalized.slice(mapping.source.length)):undefined;
  }
  if(artifact.archive.stripPrefix) {
    const prefix=artifact.archive.stripPrefix;
    if(normalized===prefix.replace(/\/$/,''))return undefined;
    if(!normalized.startsWith(prefix))throw Error('AI 압축 파일의 경로가 예상과 다릅니다.');
    return relativePath(normalized.slice(prefix.length));
  }
  if(artifact.archive.type==='wheel') {
    const parts=normalized.split('/'),data=parts[0].endsWith('.data');
    if(data) {
      if(parts.length<3)return undefined;
      if(!['purelib','platlib'].includes(parts[1])) {
        if(artifact.archive.ignoredPaths?.includes(normalized))return undefined;
        if(name.endsWith('/')&&artifact.archive.ignoredPaths?.some(ignored=>ignored.startsWith(normalized+'/')))return undefined;
        throw Error('지원하지 않는 AI wheel 설치 경로입니다.');
      }
      return relativePath(parts.slice(2).join('/'));
    }
  }
  return normalized;
}
async function extractZip(file:string,artifact:Artifact,root:string,budget:{bytes:number;maximum:number},signal?:AbortSignal) {
  const zip=await new Promise<yauzl.ZipFile>((resolve,reject)=>yauzl.open(file,{lazyEntries:true},(error,value)=>error?reject(error):resolve(value!)));
  let entries=0,bytes=0,zipError:unknown;
  zip.on('error',error=>{zipError=error;});
  try {
    while(true) {
      aborted(signal);if(zipError)throw zipError;
      const entry=await new Promise<yauzl.Entry|null>((resolve,reject)=>{
        const cleanup=()=>{zip.removeListener('entry',next);zip.removeListener('end',end);zip.removeListener('error',fail);signal?.removeEventListener('abort',cancel);};
        const next=(value:yauzl.Entry)=>{cleanup();resolve(value);},end=()=>{cleanup();resolve(null);},fail=(error:unknown)=>{cleanup();reject(error);},cancel=()=>fail(signal?.reason||Error('AI 설치 취소'));
        zip.once('entry',next);zip.once('end',end);zip.once('error',fail);signal?.addEventListener('abort',cancel,{once:true});zip.readEntry();
      });
      if(!entry)break;
      entries++;bytes+=entry.uncompressedSize;budget.bytes+=entry.uncompressedSize;
      const kind=(entry.externalFileAttributes>>>16)&0xf000;
      if(entries>artifact.maximumEntries||bytes>artifact.unpackedBytes||budget.bytes>budget.maximum||![0,0x8000,0x4000].includes(kind))throw Error('AI 압축 용량 또는 링크 오류');
      const relative=archivePath(entry.fileName,artifact);
      if(relative) {
        const target=inside(root,relative);
        if(entry.fileName.endsWith('/'))await ensureDirectory(target);
        else {
          await ensureDirectory(path.dirname(target));
          const stream=await new Promise<NodeJS.ReadableStream>((res,rej)=>zip.openReadStream(entry,(error,value)=>error?rej(error):res(value!)));
          await pipeline(stream,createWriteStream(target,{flags:'wx'}),{signal});
        }
      }
    }
    if(bytes!==artifact.unpackedBytes)throw Error('AI 압축 파일 크기가 일치하지 않습니다.');
  } finally {zip.close();}
}
async function extractSmallTar(file:string,artifact:Artifact,root:string,signal?:AbortSignal) {
  if((await fs.stat(file)).size>16*1024*1024)throw Error('AI 소형 소스 압축 크기 초과');
  const bytes=gunzipSync(await fs.readFile(file),{maxOutputLength:32*1024*1024});
  let entries=0,unpacked=0;
  for(let offset=0;offset+512<=bytes.length;) {
    aborted(signal);const header=bytes.subarray(offset,offset+512);if(header.every(value=>value===0))break;
    const text=(from:number,to:number)=>header.subarray(from,to).toString('utf8').replace(/\0.*$/s,'');
    const size=parseInt(text(124,136).trim(),8),checksum=parseInt(text(148,156).trim(),8);
    const actual=header.reduce((sum,value,index)=>sum+(index>=148&&index<156?32:value),0);
    if(!Number.isSafeInteger(size)||size<0||actual!==checksum||offset+512+size>bytes.length)throw Error('AI 소스 TAR 헤더 오류');
    entries++;unpacked+=size;
    if(entries>artifact.maximumEntries||unpacked>artifact.unpackedBytes)throw Error('AI 소스 TAR 용량 초과');
    const rawName=text(0,100),type=text(156,157);
    if(type==='x') {
      if(rawName!=='././@PaxHeader'||size>1024)throw Error('AI 소스 PAX 헤더 오류');
      const metadata=bytes.subarray(offset+512,offset+512+size).toString('utf8');
      for(let position=0;position<metadata.length;) {
        const match=/^(\d+) mtime=\d+(?:\.\d+)?\n/.exec(metadata.slice(position));
        if(!match||Number(match[1])!==Buffer.byteLength(match[0]))throw Error('지원하지 않는 AI 소스 PAX 정보');
        position+=match[0].length;
      }
      offset+=512+Math.ceil(size/512)*512;continue;
    }
    const prefix=text(345,500),name=relativePath((prefix?prefix+'/':'')+rawName.replace(/\/$/,''));
    if(!['','0','5'].includes(type))throw Error('AI 소스 TAR 파일 종류 오류');
    const mapping=artifact.archive.mappings?.find(item=>name.startsWith(item.source));
    if(mapping&&type!=='5') {
      const target=inside(root,mapping.destination+name.slice(mapping.source.length));
      await ensureDirectory(path.dirname(target));await fs.writeFile(target,bytes.subarray(offset+512,offset+512+size),{flag:'wx'});
    }
    offset+=512+Math.ceil(size/512)*512;
  }
  if(unpacked!==artifact.unpackedBytes)throw Error('AI 소스 TAR 크기가 일치하지 않습니다.');
}
export async function installEnhancementRuntime(context:EnhancementInstallContext,progress:EnhancementInstallProgress=()=>{},signal?:AbortSignal):Promise<EnhancementRuntime> {
  aborted(signal);const state=await load(context),base=path.resolve(context.runtimeBase);
  await ensureDirectory(base);const release=await acquireLock(base);
  const token=randomUUID(),staging=path.join(base,`.install-${token}`),ownerMarker=staging+'.owner.json';
  try {
    await cleanupStaging(base,signal);
    if((await enhancementInstallState(context)).installed)return await verifyEnhancementRuntime(context,signal);
    const free=await fs.statfs(base);
    if(free.bavail*free.bsize<state.manifest.minimumFreeBytes)throw Error(`AI 설치에는 약 ${Math.ceil(state.manifest.minimumFreeBytes/1024**3)} GB의 여유 공간이 필요합니다.`);
    const cache=context.cacheDirectory?path.resolve(context.cacheDirectory):path.join(base,'downloads');
    await ensureDirectory(cache);
    await fs.writeFile(ownerMarker,JSON.stringify({pid:process.pid,token}),{flag:'wx'});
    await fs.mkdir(staging);
    let downloaded=0;const budget={bytes:0,maximum:state.manifest.minimumFreeBytes};
    for(const artifact of state.manifest.artifacts) {
      aborted(signal);
      const source=await download(artifact,cache,context.payloadDirectory,bytes=>progress((downloaded+bytes)/state.manifest.totalDownloadBytes*.8,`AI 설치 · ${artifact.id} · ${Math.round(bytes/1e6)} MB`),signal);
      const sourceProof=await fileHash(source,signal);
      if(sourceProof.bytes!==artifact.bytes||sourceProof.sha256!==artifact.sha256)throw Error('AI 설치 원본이 변경되었습니다.');
      downloaded+=artifact.bytes;
      const destination=inside(staging,artifact.destination);
      if(artifact.archive.type==='file') {await ensureDirectory(path.dirname(destination));await fs.copyFile(source,destination,fs.constants.COPYFILE_EXCL);}
      else {
        await ensureDirectory(destination);
        if(artifact.archive.type==='tar.gz')await extractSmallTar(source,artifact,destination,signal);
        else await extractZip(source,artifact,destination,budget,signal);
      }
      if(sourceRevisionFromStat(source,await fs.lstat(source))!==sourceProof.revision)throw Error('압축 해제 중 AI 설치 원본이 변경되었습니다.');
    }
    aborted(signal);progress(.82,'AI 실행 파일 검사');
    await fs.writeFile(inside(staging,state.manifest.pythonPath.file),state.manifest.pythonPath.content);
    const licenses=context.licensesDirectory||path.join(path.dirname(context.manifestPath),'licenses');
    for(const license of state.manifest.licenseFiles) {
      const actual=await fileHash(inside(licenses,license.filename),signal);
      if(actual.bytes!==license.bytes||actual.sha256!==license.sha256)throw Error('AI 라이선스 파일이 일치하지 않습니다.');
    }
    for(const relative of await inventory(licenses,signal)) {
      const target=inside(staging,`licenses/${relative}`);await ensureDirectory(path.dirname(target));await fs.copyFile(inside(licenses,relative),target,fs.constants.COPYFILE_EXCL);
    }
    for(const license of state.manifest.licenseFiles) {
      const actual=await fileHash(inside(staging,`licenses/${license.filename}`),signal);
      if(actual.bytes!==license.bytes||actual.sha256!==license.sha256)throw Error('복사 중 AI 라이선스 파일이 변경되었습니다.');
    }
    const files:FileRecord[]=[];
    for(const relative of await inventory(staging,signal)) {
      aborted(signal);const actual=await fileHash(inside(staging,relative),signal);
      const finalPath=inside(state.runtimeRoot,relative),stat=await fs.lstat(inside(staging,relative));
      if(sourceRevisionFromStat(inside(staging,relative),stat)!==actual.revision)throw Error('설치 중 AI 파일이 변경되었습니다.');
      files.push({path:relative,...actual,revision:sourceRevisionFromStat(finalPath,stat)});
    }
    if(!files.some(file=>file.path===state.manifest.pythonExecutable))throw Error('AI Python 파일이 없습니다.');
    assertInventory(files,state.manifest.expectedInstalledFilesSha256);
    if((await load(context)).manifestSha256!==state.manifestSha256)throw Error('설치 중 AI 목록이 변경되었습니다.');
    aborted(signal);
    // Include the completion record in the atomic directory publication.
    await fs.writeFile(path.join(staging,REGISTRY),JSON.stringify({version:1,manifestSha256:state.manifestSha256,files} satisfies Registry),{flag:'wx'});
    await publishRuntimeDirectory(staging,state.runtimeRoot);
    for(const file of files) {
      const target=inside(state.runtimeRoot,file.path),stat=await fs.lstat(target);
      if(sourceRevisionFromStat(target,stat)===file.revision)verifiedFiles.set(target,{revision:file.revision,sha256:file.sha256});
    }
    const result=await verifyEnhancementRuntime(context,signal);progress(1,'AI 설치 완료');return result;
  } finally {
    try {
      await fs.rm(staging,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});
      if(!await fs.lstat(staging).then(()=>true,error=>{if(missing(error))return false;throw error;}))await fs.unlink(ownerMarker).catch(error=>{if(!missing(error))throw error;});
    } finally {await release();}
  }
}
