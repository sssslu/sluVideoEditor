import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatProgramTimecode,parseProgramTimecode} from '../src/preview/program-timecode';

function parsed(text:string,fps:number,duration=86400){const result=parseProgramTimecode(text,fps,duration);if(!result.ok)assert.fail(result.error);return result;}
test('program timecode resolves exact project frames through second, minute and hour carries including 120 fps',()=>{
  for(const fps of [1,15,24,25,30,50,60,100,120]){
    const width=fps>100?3:2,frame=String(fps-1).padStart(width,'0');
    assert.equal(formatProgramTimecode((fps-1)/fps,fps),`00:00:00:${frame}`);
    assert.equal(formatProgramTimecode(1,fps),`00:00:01:${'0'.repeat(width)}`);
    assert.equal(parsed(`00:00:59:${frame}`,fps).frame,60*fps-1);
    assert.equal(parsed(`00:59:59:${frame}`,fps).frame,3600*fps-1);
    assert.equal(parsed(`01:00:00:${'0'.repeat(width)}`,fps).time,3600);
  }
  assert.equal(parsed('00:00:01:100',120).frame,220);assert.equal(parsed('00:00:01:100',120).time,220/120);
});
test('formatting and parsing round-trip the integer frame grid across supported integer and fractional rates',()=>{
  for(const fps of [1,15,24,25,30,50,60,100,120,24000/1001,29.97,30000/1001,60000/1001]){
    const nominal=Math.round(fps),last=Math.floor(86400*fps);
    const frames=[0,1,nominal-1,nominal,nominal+1,59*nominal+nominal-1,3600*nominal-1,3600*nominal,last-1,last];
    for(let frame=0;frame<nominal*4;frame++)frames.push(frame);
    for(const frame of frames){const time=frame/fps,result=parsed(formatProgramTimecode(time,fps),fps);assert.equal(result.frame,frame,`${fps} fps frame ${frame}`);assert.ok(Math.abs(result.time-time)<1e-10);}
  }
});
test('fractional frame rates use explicit non-drop numbering rather than ambiguous wall-clock fractions',()=>{
  const fps=30000/1001,result=parsed('01:00:00:00',fps);
  assert.equal(result.frame,108000);assert.equal(result.time,3603.6);assert.equal(formatProgramTimecode(result.time,fps),'01:00:00:00');
  assert.equal(parsed('00:00:01:00',fps).time,30/fps);
  assert.equal(parseProgramTimecode('00:00:01;00',fps,10).ok,false,'Drop-frame notation is not silently interpreted as non-drop');
});
test('playback display selects the current frame, never rounds halfway to a future frame',()=>{
  assert.equal(formatProgramTimecode(.999,120),'00:00:00:119');
  assert.equal(formatProgramTimecode(1.999,30),'00:00:01:29');
  assert.equal(formatProgramTimecode(.51/30,30),'00:00:00:00');
  assert.equal(formatProgramTimecode(-2,30),'00:00:00:00');assert.equal(formatProgramTimecode(NaN,30),'00:00:00:00');
});
test('input rejects invalid fields and overflow instead of silently seeking to another frame',()=>{
  for(const value of ['', '1.5','-00:00:01:00','00:60:00:00','00:00:60:00','00:00:00:30','00:00:01:999','1e2:00:00:00','00:00:00:0.5','00:00:00:00x','100:00:00:00'])assert.equal(parseProgramTimecode(value,30,86400).ok,false,value);
  assert.equal(parseProgramTimecode('00:00:00:120',120,86400).ok,false);
  assert.equal(parsed(' 00:00:00:29 ',30).frame,29);assert.equal(parsed('0:00:00:0',30).frame,0);
});
test('project boundaries accept the final frame and exact endpoint without seeking beyond short or fractional clips',()=>{
  assert.equal(parsed('00:00:00:012',120,.101).time,.1);
  assert.equal(parseProgramTimecode('00:00:00:013',120,.101).ok,false);
  assert.equal(parsed('00:00:01:000',120,1).time,1);
  assert.equal(parseProgramTimecode('00:00:01:001',120,1).ok,false);
  assert.equal(parsed('24:00:00:000',120).time,86400);
  assert.equal(parseProgramTimecode('24:00:00:001',120,86400).ok,false);
  assert.equal(parsed('00:00:00:00',30,0).time,0);assert.equal(parseProgramTimecode('00:00:00:01',30,0).ok,false);
});
test('timecode rejects invalid project clocks before converting user input',()=>{
  for(const fps of [0,-1,121,NaN,Infinity])assert.throws(()=>parseProgramTimecode('00:00:00:00',fps,1),RangeError);
  for(const duration of [-1,86401,NaN,Infinity])assert.throws(()=>parseProgramTimecode('00:00:00:00',30,duration),RangeError);
});
