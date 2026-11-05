import type {MediaTiming} from '../shared/types';

const finite=(value:unknown):number|undefined=>{
  if((typeof value!=='number'&&typeof value!=='string')||value==='')return;
  const number=Number(value);return Number.isFinite(number)?number:undefined;
};
interface ProbeStream {codec_type?:string;start_time?:unknown;duration?:unknown;disposition?:{attached_pic?:number}}
interface Probe {format?:{format_name?:string;start_time?:unknown;duration?:unknown};streams?:ProbeStream[]}

/** FFmpeg input -ss uses format-relative time. Chromium keeps positive packet
 * timestamps, but MP3 discard-sample priming is explicitly rebased to zero.
 * See Chromium media/filters/ffmpeg_demuxer.cc (MP3 start-time workaround).
 * Duration is a span for MOV/MP4, but Matroska's header duration can include the
 * leading absolute timestamp. Decoded video bounds may refine this estimate. */
export function mediaTimingFromProbe(info:Probe):{timing:MediaTiming;duration:number} {
  const streams=(info.streams||[]).filter(s=>(s.codec_type==='video'||s.codec_type==='audio')&&!s.disposition?.attached_pic);
  const starts=streams.flatMap(s=>{const t=finite(s.start_time);return t===undefined?[]:[t];});
  const origin=finite(info.format?.start_time)??(starts.length?Math.min(...starts):0);
  if(Math.abs(origin)>864000)throw new Error('지원 범위를 벗어난 미디어 시작 시각입니다.');
  const formats=(info.format?.format_name||'').split(','),matroska=formats.includes('matroska')||formats.includes('webm');
  const containerDuration=finite(info.format?.duration),durations:number[]=[];
  if(containerDuration!==undefined)durations.push(containerDuration-(matroska?origin:0));
  for(const stream of streams){const duration=finite(stream.duration);if(duration!==undefined)durations.push((finite(stream.start_time)??origin)+duration-origin);}
  const duration=Math.max(0,...durations);
  return {timing:{version:1,origin,previewOffset:formats.includes('mp3')?0:Math.max(0,origin)},duration};
}
