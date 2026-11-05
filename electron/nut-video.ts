/** Minimal NUT v3 writer for an internal non-seekable BGRA stream. One video
 * stream, 1 microsecond time base, full absolute PTS, every frame a key frame.
 * The encoder consumes this pipe and writes its own indexed final container.
 * No video-sized copies, packet accumulation, nominal-FPS resampling or disk
 * raw intermediates. Callers must await pipe backpressure between packets.
 * Format reference: FFmpeg n8.0.1 libavformat/nutenc.c and nutdec.c (LGPL-2.1+),
 * https://github.com/FFmpeg/FFmpeg/tree/n8.0.1/libavformat .
 */
const MAIN=Buffer.from('4e4d7a561f5f04ad','hex'),STREAM=Buffer.from('4e5311405bf2f9db','hex'),SYNC=Buffer.from('4e4be4adeeca4569','hex');
const table=Uint32Array.from({length:256},(_,n)=>{let crc=n<<24;for(let i=0;i<8;i++)crc=(crc<<1)^((crc>>>31)?0x04c11db7:0);return crc>>>0;});
const checksum=(bytes:Uint8Array)=>{let crc=0;for(const b of bytes)crc=((crc<<8)^table[(crc>>>24)^b])>>>0;const result=Buffer.alloc(4);result.writeUInt32BE(crc);return result;};
function v(value:number):Buffer {
 if(!Number.isSafeInteger(value)||value<0)throw new Error('NUT stream integer is outside the supported range');
 const bytes=[value%128];while((value=Math.floor(value/128))>0)bytes.unshift((value%128)|128);return Buffer.from(bytes);
}
const values=(...list:number[])=>Buffer.concat(list.map(v));
function packet(start:Buffer,data:Buffer):Buffer {
 const prefix=Buffer.concat([start,v(data.length+4)]);
 return Buffer.concat([prefix,...(data.length+4>4096?[checksum(prefix)]:[]),data,checksum(data)]);
}

export class NutVideoStream {
 private lastPts=-1;readonly header:Buffer;readonly frameBytes:number;
 constructor(readonly width:number,readonly height:number,maximumPixels=4096*4096){
  if(!Number.isSafeInteger(maximumPixels)||maximumPixels<1||maximumPixels>33177600||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>8192||height>8192||width*height>maximumPixels)throw new Error('투명 영상 스트림의 크기가 올바르지 않습니다.');
  this.frameBytes=width*height*4;
  // Frame codes 0 and 2..255 are invalid; 'N' (78) is always reserved. Code 1
  // carries KEY | CODED_PTS | SIZE_MSB | CHECKSUM. Explicit run lengths avoid
  // depending on FFmpeg's optimized frame-code table or its guessed FPS.
  const main=Buffer.concat([values(3,1,32767,1,1,1000000),values(8192,6,0,1,0,0,0,1),values(105,6,0,1,0,0,0,1),values(8192,6,0,1,0,0,0,253),v(0)]);
  const stream=Buffer.concat([values(0,0,4),Buffer.from('BGRA'),values(0,14,1000000,0,0,0,width,height,1,1,0)]);
  this.header=Buffer.concat([Buffer.from('nut/multimedia container\0'),packet(MAIN,main),packet(STREAM,stream)]);
 }
 frame(data:Uint8Array,pts:number):readonly Buffer[]{
  if(!(data instanceof Uint8Array)||data.length!==this.frameBytes)throw new Error('투명 영상 프레임의 크기가 올바르지 않습니다.');
  if(!Number.isSafeInteger(pts)||pts<0||pts<=this.lastPts||pts>864000000000)throw new Error('투명 영상 프레임 시각이 올바르지 않습니다.');
  const sync=packet(SYNC,values(pts,0));
  // Values >= 2^msb_pts_shift explicitly encode pts + 2^shift, rather than a
  // wrapped low-order timestamp predicted from the previous frame.
  const header=Buffer.concat([Buffer.from([1]),v(pts+16384),v(data.length)]);
  this.lastPts=pts;
  return [sync,Buffer.concat([header,checksum(header)]),Buffer.from(data.buffer,data.byteOffset,data.byteLength)];
 }
}
