import type {VideoColorInfo} from './video-color';

export function videoHasAlpha(video:VideoColorInfo|undefined):boolean {
  return !!video&&(video.tags?.alpha_mode==='1'||video.tags?.ALPHA_MODE==='1'||/^(?:yuva|gbrap|rgba|bgra|argb|abgr|ya|pal8)/i.test(video.pix_fmt||''));
}
/** WebM alpha is stored in a separate block; FFmpeg's native VP8/VP9 decoders
 * ignore that plane. Select the bundled libvpx decoder explicitly. */
export function videoDecoderArgs(video:VideoColorInfo|undefined):string[] {
  return videoHasAlpha(video)&&['vp8','vp9'].includes(video?.codec_name||'')?['-c:v',video!.codec_name==='vp9'?'libvpx-vp9':'libvpx']:[];
}
