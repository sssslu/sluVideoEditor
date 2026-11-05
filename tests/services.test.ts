import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSrt, formatSrt } from '../electron/services';

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
