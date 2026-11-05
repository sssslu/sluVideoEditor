/** Resample premultiplied color and alpha together, so invisible RGB cannot
 * bleed into visible edges. Use 16-bit intermediates: FFmpeg's 8-bit
 * premultiply divides by 256 and darkens even fully opaque pixels. */
// Decode native YUV alpha to RGBA8 first. Direct YUVA->GBRAP16 expands alpha
// by 256, while RGBA8->GBRAP16 uses the full-range257 representation below.
export const alphaPremultiply=['format=rgba','format=gbrap16le','premultiply=inplace=1:planes=7'];
// The bundled swscale expands 8-bit alpha by 257 but reduces it by 256
// with rounding. Undo that bias only after unpremultiplication, otherwise
// repeated transforms raise 128 to 129, then 130, and eventually opacity.
// lutrgb's planar 16-bit path clips every channel at 65280. Its packed
// RGBA64 path accepts the full 65535 range, keeping RGB and alpha intact.
export const alpha16To8=['format=rgba64le',"lutrgb=r=val:g=val:b=val:a='round(val/257)*256'",'format=rgba'];
export const alphaUnpremultiply=['unpremultiply=inplace=1:planes=7',...alpha16To8];
export const alphaSpatialFilters=(filters:string[]):string[]=>[
  ...alphaPremultiply,...filters,...alphaUnpremultiply
];
