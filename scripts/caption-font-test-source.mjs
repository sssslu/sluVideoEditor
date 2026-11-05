import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';

/** Resolve the same four built font assets when a test bundles renderer code. */
export async function captionFontTestSource() {
  const assets=await readdir('dist/assets');
  let source=await readFile('src/captions/font.ts','utf8');
  for(const name of ['NotoSansKR-VF','NotoColorEmoji','GmarketSansTTFMedium','GmarketSansTTFBold']) {
    const matches=assets.filter(file=>file.startsWith(`${name}-`)&&file.endsWith('.ttf'));
    assert.equal(matches.length,1,`Expected one built ${name} asset`);
    const expression=`new URL('../assets/fonts/${name}.ttf',import.meta.url).href`;
    assert.ok(source.includes(expression));
    source=source.replace(expression,JSON.stringify(`slu-app://studio/assets/${matches[0]}`));
  }
  return source;
}
