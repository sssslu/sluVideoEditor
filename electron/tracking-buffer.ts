import {promises as fs} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import type {DecodedTrackingFrame} from './tracking-decode';
import {CancelledError} from './media';

type Stamp=Omit<DecodedTrackingFrame,'data'>;
/** A bounded reverse window. Large analysis frames can use an owned raw spool
 * instead of repeatedly decoding the same one-second prefix into a tiny RAM
 * ring. Only one read frame is resident in disk mode; timestamps stay paired
 * with the exact byte slot. The caller owns/removes the spool directory. */
export class BackwardTrackingBuffer {
  readonly mode:'memory'|'disk';readonly capacity:number;readonly payloadBytes:number;readonly diskBytes:number;
  private stamps:Stamp[]=[];private buffers:Buffer[]=[];private cursor=0;private count=0;private file?:FileHandle;private readBuffer?:Buffer;private closed=false;
  private constructor(private frameBytes:number,memoryBytes:number,spoolBytes:number){
    if(!Number.isSafeInteger(frameBytes)||frameBytes<3||!Number.isSafeInteger(memoryBytes)||memoryBytes<1||memoryBytes>128*1024*1024||!Number.isSafeInteger(spoolBytes)||spoolBytes<0||spoolBytes>1024*1024*1024)throw new Error('추적 프레임 버퍼 설정이 올바르지 않습니다.');
    this.mode=spoolBytes?'disk':'memory';if(spoolBytes&&spoolBytes<frameBytes)throw new Error('추적 임시 저장 공간이 한 프레임보다 작습니다.');
    this.capacity=Math.max(1,Math.min(512,Math.floor((spoolBytes||memoryBytes)/frameBytes)));this.payloadBytes=frameBytes*(spoolBytes?1:this.capacity);this.diskBytes=spoolBytes?frameBytes*this.capacity:0;
  }
  static async open(frameBytes:number,memoryBytes:number,spoolBytes:number,file:string){
    const buffer=new BackwardTrackingBuffer(frameBytes,memoryBytes,spoolBytes);if(spoolBytes)buffer.file=await fs.open(file,'wx+');return buffer;
  }
  reset(){if(this.closed)throw new Error('추적 버퍼가 닫혔습니다.');this.cursor=0;this.count=0;}
  private abort(signal?:AbortSignal){if(signal?.aborted)throw new CancelledError();if(this.closed)throw new Error('추적 버퍼가 닫혔습니다.');}
  async push(frame:DecodedTrackingFrame,signal?:AbortSignal){
    this.abort(signal);if(frame.data.byteLength!==this.frameBytes)throw new Error('추적 영상의 프레임 크기가 변경되었습니다.');
    if(this.file){let offset=0;while(offset<this.frameBytes){this.abort(signal);const {bytesWritten}=await this.file.write(frame.data,offset,this.frameBytes-offset,this.cursor*this.frameBytes+offset);if(!bytesWritten)throw new Error('추적 임시 프레임을 기록하지 못했습니다.');offset+=bytesWritten;}}
    else{const data=this.buffers[this.cursor]??=Buffer.alloc(this.frameBytes);data.set(frame.data);}
    const {data:_data,...stamp}=frame;this.stamps[this.cursor]=stamp;this.cursor=(this.cursor+1)%this.capacity;this.count++;
  }
  get length(){return Math.min(this.count,this.capacity);}
  /** Frame data is borrowed until the next iteration; no frame array is built. */
  async *reverse(signal?:AbortSignal):AsyncGenerator<DecodedTrackingFrame>{
    for(let i=0;i<this.length;i++){
      this.abort(signal);const slot=(this.cursor-1-i+this.capacity)%this.capacity,stamp=this.stamps[slot];let data:Buffer;
      if(this.file){data=this.readBuffer??=Buffer.alloc(this.frameBytes);let offset=0;while(offset<this.frameBytes){this.abort(signal);const {bytesRead}=await this.file.read(data,offset,this.frameBytes-offset,slot*this.frameBytes+offset);if(!bytesRead)throw new Error('추적 임시 프레임이 불완전합니다.');offset+=bytesRead;}}
      else data=this.buffers[slot];
      yield {...stamp,data};
    }
  }
  async close(){if(this.closed)return;this.closed=true;const file=this.file;this.file=undefined;this.stamps=[];this.buffers=[];this.readBuffer=undefined;await file?.close();}
}
