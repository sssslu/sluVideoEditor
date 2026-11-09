import {stat} from 'node:fs/promises';

/** FFmpeg parses -ss, -t and duration options with av_parse_time, which rejects
 * exponent notation: String(-5.551115123125783e-17) fails a whole export. Use
 * fixed decimals (microseconds by default, FFmpeg's own time base) and turn
 * floating-point residue such as -0.0000000001 into "0". */
export function ffmpegSeconds(value:number,digits=6):string{
  if(!Number.isFinite(value))throw new Error('미디어 처리 시각이 올바르지 않습니다.');
  const text=value.toFixed(digits),trimmed=text.includes('.')?text.replace(/\.?0+$/,''):text;
  return trimmed==='-0'?'0':trimmed;
}

/** Whole-file passes (remux, faststart rewrite, packet counting) take time in
 * proportion to their bytes. Keep the fixed base allowance and add time for a
 * conservative 20 MB/s, so very large intermediates are not killed when done. */
export const MINIMUM_THROUGHPUT=20*1024*1024;
export function sizeScaledTimeout(baseMs:number,bytes:number):number{
  return Math.min(2**31-1,baseMs+(Number.isFinite(bytes)&&bytes>0?Math.ceil(bytes/MINIMUM_THROUGHPUT*1000):0));
}
export async function fileSizeTimeout(baseMs:number,...files:string[]):Promise<number>{
  let bytes=0;for(const file of files)bytes+=await stat(file).then(s=>s.size,()=>0);
  return sizeScaledTimeout(baseMs,bytes);
}
