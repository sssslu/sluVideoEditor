import coverage from '../assets/fonts/NotoSansKR-coverage.json';
import emoji from '../assets/fonts/NotoEmoji-coverage.json';
import {captionGraphemes} from '../../shared/captions';
const cache=new Map<string,string[]>();
function supported(codepoint:number,ranges:number[][]=coverage.ranges){if(codepoint===9||codepoint===10||codepoint===13)return true;let lo=0,hi=ranges.length;while(lo<hi){const mid=(lo+hi)>>>1;if(ranges[mid][0]<=codepoint)lo=mid+1;else hi=mid;}return lo>0&&codepoint<=ranges[lo-1][1];}
const sequences=new Set(emoji.sequences),variation16=new Set(emoji.variation16);
function supportedCluster(text:string){const points=[...text].map(c=>c.codePointAt(0)!);if(points.every(c=>supported(c)))return true;
  const normalized=text.replace(/\ufe0f/g,'');for(let index=0;index<points.length;index++)if(points[index]===0xfe0f&&(!index||!variation16.has(points[index-1])))return false;
  return sequences.has(normalized)||([...normalized].length===1&&supported(normalized.codePointAt(0)!,emoji.ranges));
}
/** Reject substitution outside the exact bundled Korean/Latin and emoji faces. */
export function unsupportedCaptionGlyphs(text:string):string[]{
  const cached=cache.get(text);if(cached)return cached;
  const missing=[...new Set(captionGraphemes(text).filter(g=>!supportedCluster(g.text)).map(g=>g.text))].slice(0,8);cache.set(text,missing);if(cache.size>64)cache.delete(cache.keys().next().value!);return missing;
}
export function captionGlyphError(text:string):string|undefined{const missing=unsupportedCaptionGlyphs(text);return missing.length?`번들 자막 글꼴에서 지원하지 않는 문자: ${missing.join(' ')}. 문자를 바꾸거나 기존 텍스트 스타일을 사용하세요.`:undefined;}
export function assertCaptionGlyphs(text:string){const message=captionGlyphError(text);if(message){const error=new Error(message);error.name='CaptionGlyphError';throw error;}}
