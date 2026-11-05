import {promises as fs,type Stats} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** Local file identity, without reading media bytes. Timestamp-preserving
 * replacements also change ctime/file ID on the supported Windows filesystem. */
export function sourceRevisionFromStat(file:string,stat:Pick<Stats,'size'|'mtimeMs'|'ctimeMs'|'ino'|'dev'>):string {
  const resolved=path.resolve(file),canonical=process.platform==='win32'?resolved.toLowerCase():resolved;
  return createHash('sha256').update(`source-v1|${canonical}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.ino}|${stat.dev}`).digest('hex');
}
export async function readSourceRevision(file:string):Promise<string>{
  const stat=await fs.stat(file);if(!stat.isFile())throw new Error('미디어 파일을 찾을 수 없습니다.');
  return sourceRevisionFromStat(file,stat);
}
/** A known project revision must still describe the current file. With an
 * absent legacy revision, the returned identity can guard the operation's end. */
export async function requireSourceRevision(file:string,expected?:string):Promise<string>{
  const current=await readSourceRevision(file);
  if(expected!==undefined&&current!==expected)throw new Error('원본 파일이 변경되었습니다. 다시 가져오거나 프로젝트를 다시 연 뒤 작업해 주세요.');
  return current;
}
