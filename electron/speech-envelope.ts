import {runProcess} from './media';
import {SPEECH_ENVELOPE_RATE} from '../shared/caption-timing';

/** Loudness of an audio file in dBFS, SPEECH_ENVELOPE_RATE values per second (16 kHz mono RMS over
 * 10 ms windows), streamed from FFmpeg so an hour of audio stays a few megabytes. */
export async function speechEnvelope(file:string,ffmpeg:string,signal?:AbortSignal):Promise<Float32Array>{
  const rate=16000,window=rate/SPEECH_ENVELOPE_RATE,values:number[]=[];let carry:Buffer=Buffer.alloc(0),sum=0,count=0;
  const take=(data:Buffer)=>{
    const buffer=carry.length?Buffer.concat([carry,data]):data,usable=buffer.length-(buffer.length%2);
    for(let i=0;i<usable;i+=2){const v=buffer.readInt16LE(i)/32768;sum+=v*v;if(++count===window){values.push(sum>0?10*Math.log10(sum/window):-120);sum=0;count=0;}}
    carry=buffer.subarray(usable);
  };
  await runProcess(ffmpeg,['-hide_banner','-nostdin','-v','error','-i',file,'-map','0:a:0','-vn','-ac','1','-ar',String(rate),'-f','s16le','-'],{signal,onStdout:take,captureStdout:false});
  if(count)values.push(sum>0?10*Math.log10(sum/count):-120);
  return Float32Array.from(values);
}
