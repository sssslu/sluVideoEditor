import coverage from '../assets/fonts/NotoSansKR-coverage.json';
import emoji from '../assets/fonts/NotoEmoji-coverage.json';
import {captionGraphemes} from '../../shared/captions';
const cache=new Map<string,string[]>();
/** Zero-width and direction marks that pasted or imported text often carries. They draw nothing in any
 * font, so they must not hide the caption or stop the export. (U+200D is left to the emoji rules.) */
const INVISIBLE=new Set([0xad,0x200b,0x200c,0x200e,0x200f,0x2060,0xfeff,0x202a,0x202b,0x202c,0x202d,0x202e,0x2066,0x2067,0x2068,0x2069]);
function supported(codepoint:number,ranges:number[][]=coverage.ranges){if(codepoint===9||codepoint===10||codepoint===13||INVISIBLE.has(codepoint))return true;let lo=0,hi=ranges.length;while(lo<hi){const mid=(lo+hi)>>>1;if(ranges[mid][0]<=codepoint)lo=mid+1;else hi=mid;}return lo>0&&codepoint<=ranges[lo-1][1];}
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
/** `name`: the caption, for a message shown away from it (export, preview). */
export function captionGlyphError(text:string,name?:string):string|undefined{const missing=unsupportedCaptionGlyphs(text);return missing.length?`${name?`'${name.slice(0,30)}' 자막에 `:''}자막 글꼴로 표시할 수 없는 글자가 있습니다: ${missing.join(' ')}. 이 글자를 지우거나 다른 글자로 바꾸세요. 그대로 두면 이 자막은 보이지 않고 내보내기가 멈춥니다.`:undefined;}
export function assertCaptionGlyphs(text:string,name?:string){const message=captionGlyphError(text,name);if(message){const error=new Error(message);error.name='CaptionGlyphError';throw error;}}
