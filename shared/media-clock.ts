import type {MediaAsset} from './types';

/** Earlier H264 proxies could change matrix/range when the codec or resolution
 * changed. Only normalized color proxies and alpha-preserving WebM are valid. */
export const previewProxyPath=(media:MediaAsset):string|undefined=>media.proxyPath?.toLowerCase().endsWith(media.hasAlpha?'-alpha-proxy.webm':'-color-proxy.mp4')?media.proxyPath:undefined;
export const needsPreviewProxy=(media:MediaAsset)=>media.kind==='video'&&media.codec?.toLowerCase()==='ffv1'&&!previewProxyPath(media);
export const previewSourceKey=(media:Pick<MediaAsset,'path'|'sourceRevision'>)=>JSON.stringify([media.path,media.sourceRevision??null]);
/** FFV1 sources require a browser-compatible proxy even when optional proxy
 * playback is off. The same selection drives the URL and timestamp origin. */
export const usesPreviewProxy=(media:MediaAsset,proxy=false)=>!!previewProxyPath(media)&&(proxy||media.codec?.toLowerCase()==='ffv1');
export const previewMediaPath=(media:MediaAsset,proxy=false)=>usesPreviewProxy(media,proxy)?previewProxyPath(media)!:media.path;
/** Proxies are encoded on the normalized source clock. Metadata belongs to the
 * original only; never add its absolute origin a second time to a proxy. */
export function previewClockOffset(media:MediaAsset,proxy=false):number {
  return usesPreviewProxy(media,proxy)?0:media.timing?.previewOffset??0;
}
// Chromium converts seconds to integer microseconds. Floating-point sums such
// as .2+.9 can otherwise truncate just before a frame boundary and show the
// preceding frame. Quantize explicitly at the decoder's timestamp precision.
export const toPreviewTime=(media:MediaAsset,time:number,proxy=false)=>Math.round((time+previewClockOffset(media,proxy))*1e6)/1e6;
export const fromPreviewTime=(media:MediaAsset,time:number,proxy=false)=>time-previewClockOffset(media,proxy);
