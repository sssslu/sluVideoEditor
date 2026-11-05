import {promises as fs} from 'node:fs';
import {CancelledError} from './media';

/** Fit local motions once, then share the same rigid transform with all four
 * full-resolution planes. Fitting four times would consume different rand()
 * sequences in libvidstab and separate the foreground from its alpha edge.
 * Pinned vid.stab 4bd81e3 writes debug transforms BEFORE smoothZoom=0 discards
 * fitted zoom. Reproduce that discard and convert to its indexed old format.
 * Stream records so a long clip never creates a second in-memory motion list. */
export async function shareAlphaTransforms(source:string,target:string,signal?:AbortSignal):Promise<number>{
  const abort=()=>{if(signal?.aborted)throw new CancelledError();};abort();
  const input=await fs.open(source,'r');let output:Awaited<ReturnType<typeof fs.open>>|undefined;
  try{
    output=await fs.open(target,'wx');
    const buffer=Buffer.alloc(65536);let pending='',batch='',count=0;
    const parse=(raw:string)=>{
      if(raw.length>4096)throw new Error('흔들림 보정 분석 기록이 너무 깁니다.');
      const line=raw.trim();if(!line||line.startsWith('#'))return;
      const fields=line.split(/\s+/),values=fields.map(Number);
      if(fields.length!==6||values.some(n=>!Number.isFinite(n))||values[0]!==0||!Number.isInteger(values[5])||Math.abs(values[5])>1)
        throw new Error('흔들림 보정 분석 기록이 올바르지 않습니다.');
      if(++count>10_000_000)throw new Error('흔들림 보정 프레임 수가 지원 범위를 벗어났습니다.');
      batch+=`${count} ${values[1]} ${values[2]} ${values[3]} 0 ${values[5]}\n`;
    };
    while(true){
      abort();const {bytesRead}=await input.read(buffer,0,buffer.length,null);if(!bytesRead)break;
      pending+=buffer.subarray(0,bytesRead).toString('ascii');const lines=pending.split('\n');pending=lines.pop()!;
      for(const line of lines)parse(line);
      if(pending.length>4096)throw new Error('흔들림 보정 분석 기록이 너무 깁니다.');
      if(batch){await output.writeFile(batch);batch='';}
    }
    if(pending)parse(pending);abort();
    if(!count)throw new Error('선택 구간에서 분석할 영상 프레임을 찾지 못했습니다.');
    if(batch)await output.writeFile(batch);return count;
  }finally{await input.close();await output?.close();}
}
