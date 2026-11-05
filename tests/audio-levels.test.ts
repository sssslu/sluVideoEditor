import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {AudioPeakHold,levelDb,levelPercent,validAudioLevels} from '../shared/audio-levels';

const near=(actual:number,expected:number,tolerance=1e-6)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
function processor(rate=48000){
  const messages:any[]=[],context:any={sampleRate:rate,currentTime:0,registerProcessor:(_name:string,ctor:any)=>{context.Processor=ctor;},AudioWorkletProcessor:class{port={postMessage:(data:any)=>messages.push(structuredClone(data)),onmessage:undefined as any};}};
  vm.runInNewContext(readFileSync(new URL('../src/preview/audio-meter.worklet.js',import.meta.url),'utf8'),context);
  const meter=new context.Processor();let time=0;
  const process=(inputs:Float32Array[][],frames:number)=>{const output=new Float32Array(frames).fill(17);context.currentTime=time;time+=frames/rate;const alive=meter.process(inputs,[[output]]);assert.ok(output.every((n:number)=>n===0)||!alive,'Meter must not inject sound');return alive;};
  const send=(data:any)=>meter.port.onmessage({data});return {messages,process,send};
}

test('dBFS conversion and visible floor preserve headroom and silence',()=>{
  near(levelDb(.5),-6.0205999133);near(levelDb(2),6.0205999133);assert.equal(levelDb(0),-120);assert.equal(levelDb(NaN),-120);
  assert.equal(levelPercent(-60),0);assert.equal(levelPercent(0),100);assert.equal(levelPercent(6),100);near(levelPercent(-18),70);
});
test('peak hold lasts1.5s then drops20dB/s; overload and maximum latch survive silence',()=>{
  const h=new AudioPeakHold();h.update([1.1,.5,.25,0],0);assert.deepEqual(h.overload,[true,false,false,false]);
  const initial=levelDb(1.1);near(h.update([0,0,0,0],1.4)[0],initial);near(h.update([0,0,0,0],1.6)[0],initial-2);
  near(h.update([0,0,0,0],2)[0],initial-10);near(h.maximum[0],initial);assert.equal(h.overload[0],true);
  assert.deepEqual(new AudioPeakHold().overload,[false,false,false,false]);
});
test('actual worklet measures four independent channels across variable quantum lengths',()=>{
  const p=processor(),amplitudes=[.5,.125,2,.25];let n=0;
  while(!p.messages.length){const frames=[64,128,256][n++%3],arrays=amplitudes.map(a=>Float32Array.from({length:frames},(_,i)=>i%2?a:-a));p.process([arrays.slice(0,2),arrays.slice(2)],frames);}
  const m=p.messages[0];assert.ok(validAudioLevels(m));assert.ok(m.frames>=2400&&m.frames<2656);
  for(let i=0;i<4;i++){near(m.peak[i],amplitudes[i]);near(m.rms[i],amplitudes[i]);}
});
test('single-sample overload is retained while UI cannot acknowledge; message queue remains bounded',()=>{
  const p=processor();for(let i=0;i<20;i++)p.process([],128);assert.equal(p.messages.length,1);
  const impulse=new Float32Array(128);impulse[17]=1.5;p.process([[impulse]],128);
  for(let i=0;i<100;i++)p.process([],128);assert.equal(p.messages.length,1);
  p.send({type:'ack',revision:0,sequence:1});p.process([],128);assert.equal(p.messages.length,2);
  const m=p.messages[1];near(m.peak[0],1.5);near(m.rms[0],1.5/Math.sqrt(m.frames));assert.deepEqual(m.peak.slice(1),[0,0,0]);
});
test('reset excludes old samples and old acknowledgements cannot release a newer revision',()=>{
  const p=processor();for(let i=0;i<20;i++)p.process([[new Float32Array(128).fill(3)]],128);
  p.send({type:'reset',revision:9});for(let i=0;i<20;i++)p.process([],128);
  assert.equal(p.messages.length,2);assert.equal(p.messages[1].revision,9);assert.deepEqual(p.messages[1].peak,[0,0,0,0]);
  p.send({type:'ack',revision:0,sequence:1});for(let i=0;i<20;i++)p.process([],128);assert.equal(p.messages.length,2);
  p.send({type:'ack',revision:9,sequence:2});p.process([],128);assert.equal(p.messages.length,3);
  p.send({type:'stop'});assert.equal(p.process([],128),false);
});
test('nonfinite samples become silence and reporting rate stays bounded at96kHz',()=>{
  const p=processor(96000);for(let i=0;i<38;i++)p.process([[Float32Array.from([NaN,Infinity,-Infinity,...new Array(125).fill(0)])]],128);
  assert.equal(p.messages.length,1);assert.equal(p.messages[0].frames,4864);assert.ok(validAudioLevels(p.messages[0]));assert.deepEqual(p.messages[0].rms,[0,0,0,0]);
  assert.equal(validAudioLevels({...p.messages[0],rms:[1,0,0,0]}),false);assert.equal(validAudioLevels({...p.messages[0],peak:[NaN,0,0,0]}),false);
});
