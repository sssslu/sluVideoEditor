import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeScopes} from '../shared/scopes';
const frame=(colors:number[][])=>Uint8ClampedArray.from(colors.flatMap(c=>[...c,255]));
test('SDR black, white and gray have exact distributions and a neutral vectorscope center',()=>{
  for(const v of [0,1,127,128,254,255]){const scope=analyzeScopes(frame(Array.from({length:4},()=>[v,v,v])),2,2);assert.equal(scope.samples,4);assert.deepEqual(scope.min,[v,v,v,v]);assert.deepEqual(scope.max,[v,v,v,v]);assert.deepEqual(scope.mean,[v,v,v,v]);for(let c=0;c<4;c++)assert.equal(scope.histogram[c*256+v],4);assert.equal(scope.vectors[64*128+64],4);}
});
test('primary color luma uses Rec709 coefficients and vectors retain hue orientation',()=>{
  const scope=analyzeScopes(frame([[255,0,0],[0,255,0],[0,0,255]]),3,1);assert.equal(scope.histogram[54],1);assert.equal(scope.histogram[182],1);assert.equal(scope.histogram[18],1);assert.equal(scope.vectors[0*128+49],1);assert.equal(scope.vectors[121*128+15],1);assert.equal(scope.vectors[69*128+127],1);
});
test('ramp histogram is uniform and waveform preserves horizontal position with white at top',()=>{
  const scope=analyzeScopes(frame(Array.from({length:256},(_,v)=>[v,v,v])),256,1);
  for(let c=0;c<4;c++)for(let x=0;x<256;x++){assert.equal(scope.histogram[c*256+x],1);assert.equal(scope.waveform[(c*128+127-(x>>1))*256+x],1);}
  assert.deepEqual(scope.mean,[127.5,127.5,127.5,127.5]);assert.equal(scope.waveform.reduce((a,b)=>a+b,0),256*4);
});
test('RGB parade separates channels rather than reporting an identical luma waveform',()=>{
  const scope=analyzeScopes(frame([[255,0,0],[0,0,255]]),2,1),plane=256;
  assert.equal(scope.waveform[plane+0*2+0],1);assert.equal(scope.waveform[plane+127*2+1],1);assert.equal(scope.waveform[3*plane+127*2+0],1);assert.equal(scope.waveform[3*plane+0*2+1],1);
});
test('large frame counts do not overflow; horizontal downsampling retains all samples',()=>{
  const data=new Uint8ClampedArray(320*180*4);for(let i=0;i<data.length;i+=4){data[i]=255;data[i+3]=255;}const scope=analyzeScopes(data,320,180);assert.equal(scope.waveWidth,256);assert.equal(scope.samples,57600);assert.equal(scope.histogram[54],57600);assert.equal(scope.waveform.reduce((a,b)=>a+b,0),57600*4);assert.equal(scope.vectors.reduce((a,b)=>a+b,0),57600);
});
test('transparent data is excluded and invalid dimensions or buffers are refused',()=>{
  const scope=analyzeScopes(new Uint8ClampedArray([255,255,255,0]),1,1);assert.equal(scope.samples,0);assert.deepEqual(scope.mean,[0,0,0,0]);for(const [w,h,length]of [[0,1,0],[321,1,1284],[1,181,724],[1,1,3],[1.5,1,6]])assert.throws(()=>analyzeScopes(new Uint8ClampedArray(length),w,h));
});
