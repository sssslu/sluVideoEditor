import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt, formatSrt, decodeSubtitleText } from '../electron/services';

test('SRT parses BOM, CRLF, multiline Korean, decimal precision, and cue settings', () => {
  const result = parseSrt('\uFEFF1\r\n00:00:01,200 --> 00:00:03,450\r\n안녕하세요\r\n두 번째 줄\r\n\r\n2\r\n00:01:02.5 --> 00:01:03.05 position:50%\r\n<b>Hello</b> &amp; world\r\n');
  assert.deepEqual(result, [{start:1.2,end:3.45,text:'안녕하세요\n두 번째 줄'},{start:62.5,end:63.05,text:'Hello & world'}]);
});
test('WebVTT parses short timestamps and skips control blocks and invalid ranges', () => {
  const result = parseSrt('WEBVTT\n\nNOTE comment\n00:00.000 --> 00:01.000\nnot a cue\n\ncue-id\n00:01.500 --> 00:02.800 align:center\n<c.green>실제 자막</c>\n\n00:99:00.000 --> 01:40:00.000\nbad\n\n00:00:10,000 --> 00:00:02,000\nreverse');
  assert.deepEqual(result, [{start:1.5,end:2.8,text:'실제 자막'}]);
});
test('SRT roundtrip preserves millisecond boundaries, Unicode, and overlaps', () => {
  const cues = [{start:3599.999,end:3601.1,text:'한 시간\n테스트'},{start:0,end:2.001,text:'Hello!'},{start:1.8,end:3.5,text:'겹치는 자막'}];
  assert.deepEqual(parseSrt(formatSrt(cues)), [...cues].sort((a,b)=>a.start-b.start));
  assert.ok(formatSrt(cues).includes('00:59:59,999 --> 01:00:01,100'));
});
test('SRT export discards invalid numbers and never emits broken blank cue blocks', () => {
  const result = formatSrt([{start:NaN,end:3,text:'bad'},{start:0,end:Infinity,text:'bad'},{start:0,end:1,text:'x\n\ny'},{start:-1,end:0,text:'bad'}]);
  assert.deepEqual(parseSrt(result), [{start:0,end:1,text:'x\ny'}]);
});
test('subtitle import decodes byte-order marks, strict UTF-8 and legacy Korean CP949 text', () => {
  const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\n안녕하세요. 자막입니다\r\n', expected = [{ start: 1, end: 2.5, text: '안녕하세요. 자막입니다' }];
  const utf16be = (text: string) => { const bytes = Buffer.from(text, 'utf16le'); for (let i = 0; i < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]]; return bytes; };
  const cp949 = Buffer.concat([Buffer.from('1\r\n00:00:01,000 --> 00:00:02,500\r\n'), Buffer.from([0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4, 0x2e, 0x20, 0xc0, 0xda, 0xb8, 0xb7, 0xc0, 0xd4, 0xb4, 0xcf, 0xb4, 0xd9]), Buffer.from('\r\n')]);
  for (const [label, bytes] of [
    ['utf-8', Buffer.from(srt)],
    ['utf-8 bom', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(srt)])],
    ['utf-16le bom', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(srt, 'utf16le')])],
    ['utf-16be bom', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(srt)])],
    ['cp949', cp949],
  ] as const) {
    const text = decodeSubtitleText(bytes);
    assert.ok(!text.startsWith('\uFEFF') && !text.includes('\uFFFD'), label);
    assert.deepEqual(parseSrt(text), expected, label);
  }
  assert.equal(decodeSubtitleText(new Uint8Array()), '');
  // Electron's ICU maps euc-kr to the full CP949 table, including UHC-only
  // syllables. Plain Node builds may decode strict EUC-KR only.
  if (process.versions.electron) assert.equal(decodeSubtitleText(Buffer.from([0x8c, 0x63, 0xb9, 0xe6, 0xb0, 0xa2, 0xc7, 0xcf])), '똠방각하');
});
