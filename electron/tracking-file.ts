import {promises as fs} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import {MOTION_RECORD_BYTES,readMotionSample,writeMotionSample,assertMotionAnalysis,type MotionAnalysis,type MotionSample} from '../shared/tracking';
import {CancelledError} from './media';

const MAGIC=Buffer.from('SLUTRK01');
const view=(data:Buffer)=>new DataView(data.buffer,data.byteOffset,data.byteLength);
async function readExact(handle:FileHandle,data:Buffer,position:number){let offset=0;while(offset<data.length){const {bytesRead}=await handle.read(data,offset,data.length-offset,position+offset);if(!bytesRead)throw new Error('추적 경로 파일이 불완전합니다.');offset+=bytesRead;}}
async function writeAll(handle:FileHandle,data:Buffer){let offset=0;while(offset<data.length){const {bytesWritten}=await handle.write(data,offset,data.length-offset);if(!bytesWritten)throw new Error('추적 경로를 저장하지 못했습니다.');offset+=bytesWritten;}}

export class MotionSampleWriter {
  private buffer=Buffer.alloc(32*256);private used=0;private last?:number;count=0;
  private constructor(private file:FileHandle,private direction:1|-1){}
  static async open(file:string,direction:1|-1){return new MotionSampleWriter(await fs.open(file,'wx'),direction);}
  async append(sample:MotionSample){
    if(this.last!==undefined&&(sample.time-this.last)*this.direction<=0)throw new Error('추적 경로의 프레임 시각이 중복되거나 역행합니다.');
    writeMotionSample(view(this.buffer),this.used,sample);this.used+=MOTION_RECORD_BYTES;this.count++;this.last=sample.time;
    if(this.used===this.buffer.length)await this.flush();
  }
  async flush(){if(this.used){await writeAll(this.file,this.buffer.subarray(0,this.used));this.used=0;}}
  async close(){try{await this.flush();}finally{await this.file.close();}}
}

/** The backward run is reversed in bounded record batches, then the forward
 * run is appended. No all-frames JS array, sorting or JSON expansion. */
export async function assembleMotionFile(target:string,metadata:Omit<MotionAnalysis,'path'>,backward:string,forward:string,signal?:AbortSignal){
  const abort=()=>{if(signal?.aborted)throw new CancelledError();};abort();
  const json=Buffer.from(JSON.stringify(metadata));if(json.length>65536)throw new Error('추적 경로 정보가 너무 큽니다.');
  const head=Buffer.alloc(16);MAGIC.copy(head);head.writeUInt32LE(json.length,8);head.writeUInt32LE(metadata.frames,12);
  const output=await fs.open(target,'wx');let total=0,last=-Infinity;
  try{
    await writeAll(output,head);await writeAll(output,json);
    for(const [name,reverse] of [[backward,true],[forward,false]] as const){
      const input=await fs.open(name,'r');try{
        const size=(await input.stat()).size;if(size%MOTION_RECORD_BYTES)throw new Error('추적 경로의 프레임 기록이 불완전합니다.');
        const buffer=Buffer.alloc(Math.min(size,32*2048)),sorted=Buffer.alloc(buffer.length);let consumed=0;
        while(consumed<size){abort();const length=Math.min(buffer.length,size-consumed),at=reverse?size-consumed-length:consumed,part=buffer.subarray(0,length);await readExact(input,part,at);
          if(reverse)for(let i=0;i<length;i+=32)part.copy(sorted,length-i-32,i,i+32);const data=reverse?sorted.subarray(0,length):part;
          const dataView=view(data);for(let i=0;i<length;i+=32){const sample=readMotionSample(dataView,i);if(sample.time<=last||sample.time<metadata.start-1e-9||sample.time>=metadata.end)throw new Error('추적 경로 구간이 올바르지 않습니다.');last=sample.time;total++;}
          await writeAll(output,data);consumed+=length;
        }
      }finally{await input.close();}
    }
    if(total!==metadata.frames||total<1)throw new Error('추적 경로의 프레임 수가 일치하지 않습니다.');await output.sync();abort();
  }finally{await output.close();}
}

/** Bounded range reads for preview prefetch and export, with indexed seeking. */
export class MotionFileReader {
  private constructor(private file:FileHandle,readonly metadata:MotionAnalysis,private offset:number){}
  static async open(path:string){
    const file=await fs.open(path,'r');try{
      const header=Buffer.alloc(16);await readExact(file,header,0);if(!header.subarray(0,8).equals(MAGIC))throw new Error('지원하지 않는 추적 경로 형식입니다.');
      const length=header.readUInt32LE(8),frames=header.readUInt32LE(12);if(length<2||length>65536||frames<1||frames>20_000_000||(await file.stat()).size!==16+length+frames*32)throw new Error('추적 경로 파일의 크기가 올바르지 않습니다.');
      const json=Buffer.alloc(length);await readExact(file,json,16);const m=JSON.parse(json.toString()) as MotionAnalysis;
      assertMotionAnalysis({...m,path},{allowAnyExtension:true});if(m.frames!==frames)throw new Error('추적 경로의 프레임 수가 일치하지 않습니다.');
      return new MotionFileReader(file,{...m,path},16+length);
    }catch(error){await file.close();throw error;}
  }
  async sample(index:number):Promise<MotionSample>{if(!Number.isInteger(index)||index<0||index>=this.metadata.frames)throw new Error('추적 프레임 번호가 올바르지 않습니다.');const data=Buffer.alloc(32);await readExact(this.file,data,this.offset+index*32);const sample=readMotionSample(view(data),0);this.validateSample(sample,index);return sample;}
  async indexAt(time:number):Promise<number>{
    if(!Number.isFinite(time))throw new Error('추적 경로 시각이 올바르지 않습니다.');let lo=0,hi=this.metadata.frames;
    while(lo<hi){const mid=Math.floor((lo+hi)/2);if((await this.sample(mid)).time<=time)lo=mid+1;else hi=mid;}return Math.max(0,lo-1);
  }
  async range(time:number,limit=256):Promise<{startIndex:number;samples:MotionSample[];nextIndex?:number}>{
    return this.samplesFrom(await this.indexAt(time),limit);
  }
  async samplesFrom(startIndex:number,limit=256):Promise<{startIndex:number;samples:MotionSample[];nextIndex?:number}>{
    if(!Number.isInteger(limit)||limit<1||limit>4096)throw new Error('추적 경로 읽기 범위를 벗어났습니다.');
    if(!Number.isInteger(startIndex)||startIndex<0||startIndex>=this.metadata.frames)throw new Error('추적 프레임 번호가 올바르지 않습니다.');
    const count=Math.min(limit,this.metadata.frames-startIndex),data=Buffer.alloc(count*32);await readExact(this.file,data,this.offset+startIndex*32);
    const dataView=view(data),samples=Array.from({length:count},(_,i)=>{const sample=readMotionSample(dataView,i*32);this.validateSample(sample,startIndex+i);return sample;});for(let i=1;i<samples.length;i++)if(samples[i].time<=samples[i-1].time)throw new Error('추적 경로 시각이 정렬되어 있지 않습니다.');
    return {startIndex,samples,...(startIndex+count<this.metadata.frames?{nextIndex:startIndex+count}:{})};
  }
  private validateSample(sample:MotionSample,index:number){if(sample.time<this.metadata.start-1e-9||sample.time>=this.metadata.end||(index===0&&Math.abs(sample.time-this.metadata.start)>1e-6))throw new Error('추적 경로의 프레임 시각이 올바르지 않습니다.');}
  async close(){await this.file.close();}
}

/** Source relocation changes the stat/path identity. Only callers which have
 * verified the source content hash may create this immutable rebased artifact.
 * Records are checked in bounded batches, with no all-frames allocation. */
export async function rebaseMotionFile(source:string,target:string,sourceRevision:string,signal?:AbortSignal){
  const reader=await MotionFileReader.open(source);let output:FileHandle|undefined;
  try{
    const {path:_path,...metadata}={...reader.metadata,sourceRevision};assertMotionAnalysis({...metadata,path:target},{allowAnyExtension:true});
    const json=Buffer.from(JSON.stringify(metadata)),head=Buffer.alloc(16);if(json.length>65536)throw new Error('추적 경로 정보가 너무 큽니다.');MAGIC.copy(head);head.writeUInt32LE(json.length,8);head.writeUInt32LE(metadata.frames,12);
    if(signal?.aborted)throw new CancelledError();output=await fs.open(target,'wx');await writeAll(output,head);await writeAll(output,json);
    let index=0,last=-Infinity;const buffer=Buffer.alloc(4096*32);
    while(index<metadata.frames){if(signal?.aborted)throw new CancelledError();const page=await reader.samplesFrom(index,4096);page.samples.forEach((sample,i)=>{if(sample.time<=last)throw new Error('추적 경로 시각이 정렬되어 있지 않습니다.');last=sample.time;writeMotionSample(view(buffer),i*32,sample);});await writeAll(output,buffer.subarray(0,page.samples.length*32));index+=page.samples.length;}
    await output.sync();if(signal?.aborted)throw new CancelledError();return {...metadata,path:target};
  }finally{await reader.close();await output?.close();}
}
