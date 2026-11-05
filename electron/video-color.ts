export interface VideoColorInfo {codec_name?:string;width:number;height:number;pix_fmt?:string;color_space?:string;color_primaries?:string;color_transfer?:string;color_range?:string;side_data_list?:{rotation?:number}[];tags?:{rotate?:string;alpha_mode?:string;ALPHA_MODE?:string}}
const known=(value?:string)=>!!value&&!['unknown','unspecified','reserved'].includes(value);
/** Match Chromium's FFmpeg demuxer: incomplete legacy-codec color tags are
 * replaced as a group, using natural height (<720 =>601). VP9/AV1 retain their
 * stream matrix. This is a decoding convention, not HDR tone mapping.
 * Reference: chromium/src/media/ffmpeg/ffmpeg_common.cc, IsSpecified fallback. */
export function previewVideoColor(info:VideoColorInfo):{matrix:string;range:'pc'|'tv'}{
  const specified=known(info.color_space)&&known(info.color_primaries)&&known(info.color_transfer),modern=['vp9','av1'].includes(info.codec_name||'');
  const rotation=Number(info.side_data_list?.find(s=>s.rotation!==undefined)?.rotation??info.tags?.rotate??0),height=Math.abs(rotation)%180===90?info.width:info.height;
  let matrix=specified||modern?info.color_space:undefined;
  if(!known(matrix))matrix=modern?'bt709':height<720?'smpte170m':'bt709';
  if(matrix==='gbr'&&!/444|gbr|rgb|bgr/.test(info.pix_fmt||''))matrix='bt709';
  return {matrix:['smpte170m','bt470bg'].includes(matrix!)?'bt601':matrix!,range:(specified||modern)&&info.color_range==='pc'?'pc':'tv'};
}

/** swscale treats deprecated YUVJ formats as full-range even with in_range=tv.
 * Re-label the equivalent YUV layout through a full-to-full scale first; this
 * preserves every plane byte, then lets Chromium's limited-range fallback be
 * applied explicitly. Do not use this for still JPEG images. */
export function previewColorPrefix(info:VideoColorInfo):string {
  const formats:Record<string,string>={yuvj420p:'yuv420p',yuvj422p:'yuv422p',yuvj444p:'yuv444p',yuvj440p:'yuv440p',yuvj411p:'yuv411p'},format=formats[info.pix_fmt||''];
  return format&&previewVideoColor(info).range==='tv'?`scale=in_range=pc:out_range=pc,format=${format},`:'';
}
