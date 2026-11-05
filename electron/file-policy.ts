import path from 'node:path';
import {realpath} from 'node:fs/promises';

/** Compare actual parent directories too, so Windows junctions cannot alias a source file. */
export async function assertOutputNotSource(output:string,sources:string[]):Promise<void>{
  const resolved=async(file:string)=>{try{return await realpath(file);}catch{try{return path.join(await realpath(path.dirname(file)),path.basename(file));}catch{return path.resolve(file);}}};
  const target=pathKey(await resolved(output));
  const originals=await Promise.all(sources.map(resolved));
  if(originals.some(file=>pathKey(file)===target))throw new Error('원본 미디어 파일에 덮어쓸 수 없습니다.');
}
export function localFilePath(value:unknown):value is string {
  return typeof value==='string'&&value.length>0&&value.length<32768&&!value.includes('\0')&&path.isAbsolute(value)&&!/^[/\\]{2}/.test(value);
}
export function pathKey(file:string):string { return path.resolve(file).toLowerCase(); }
export function insideDirectory(file:string,directory:string):boolean {
  const relative=path.relative(pathKey(directory),pathKey(file));
  return !!relative&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);
}
export interface ByteRange {start:number;end:number;partial:boolean}
/** One RFC 9110 byte range, as used by Chromium media seeking. null means 416. */
export function parseByteRange(header:string|null,size:number):ByteRange|null {
  if(!Number.isSafeInteger(size)||size<0)return null;
  if(header===null)return {start:0,end:size-1,partial:false};
  const match=/^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if(!match||(!match[1]&&!match[2])||size===0)return null;
  let start=0,end=size-1;
  if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
  else{const suffix=Number(match[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return null;start=Math.max(0,size-suffix);}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size)return null;
  return {start,end,partial:true};
}
