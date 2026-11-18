import {createHash} from 'node:crypto';
import path from 'node:path';
import type {MediaAsset} from '../shared/types';

function key(label:string, revision:string):string {
  return createHash('sha256').update(`${label}|${revision}`).digest('hex').slice(0,28);
}

export function proxyCacheKey(asset:MediaAsset):string {
  if (!asset.sourceRevision) throw new Error('Proxy source revision is missing');
  const version = asset.hasAlpha ? 'proxy-alpha-source-v5' : 'proxy-color-source-v4';
  return key((asset.videoStreamOrdinal??0)>0?`${version}|video-stream-${asset.videoStreamOrdinal}`:version, asset.sourceRevision);
}

/** Recognize old timing/audio caches and proxies that selected a cover image.
 * Ordinary current proxies and externally named files remain valid. */
export function hasLegacyProxyTiming(asset:MediaAsset):boolean {
  if (!asset.proxyPath || !asset.sourceRevision) return false;
  const basename = path.basename(asset.proxyPath).toLowerCase();
  for (const kind of ['alpha','color']) {
    const lastLegacyVersion = (kind === 'alpha' ? 4 : 3)+Number((asset.videoStreamOrdinal??0)>0);
    const extension = kind === 'alpha' ? 'webm' : 'mp4';
    for (let version = 1; version <= lastLegacyVersion; version++) {
      const signature = key(`proxy-${kind}-source-v${version}`, asset.sourceRevision);
      if (basename === `${signature}-${kind}-proxy.${extension}`) return true;
    }
  }
  return false;
}
