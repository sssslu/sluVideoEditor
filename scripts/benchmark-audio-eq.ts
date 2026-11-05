import {AudioEQProcessor,defaultEQ} from '../shared/audio-eq';
import {performance} from 'node:perf_hooks';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
const rate=48000,frames=5*rate,block=4096,eq=defaultEQ();eq.bands.forEach((b,i)=>{b.enabled=true;b.gain=i%2?6:-6;});eq.output=-6;
const input=new Float32Array(block*2);for(let i=0;i<block;i++){input[i*2]=.05*Math.sin(2*Math.PI*437*i/rate);input[i*2+1]=.03*Math.sin(2*Math.PI*900*i/rate);}
const run=(clips:number,enabled:boolean)=>{const processors=Array.from({length:clips},()=>new AudioEQProcessor({...eq,enabled})),scratch=new Float32Array(block*2);let checksum=0;const start=performance.now();for(let at=0;at<frames;at+=block){const data=scratch.subarray(0,Math.min(block,frames-at)*2);for(const processor of processors){data.set(input.subarray(0,data.length));processor.process(data);checksum+=data[data.length-1];}}return {clips,filtersPerClip:enabled?6:0,framesPerClip:frames,seconds:(performance.now()-start)/1000,checksum};};
run(1,true);const results=[];for(let trial=0;trial<3;trial++)for(const clips of [1,32])for(const enabled of [false,true])results.push({trial,...run(clips,enabled)});
const sourceSha256=createHash('sha256').update(await fs.readFile('shared/audio-eq.ts')).digest('hex');await fs.mkdir('.test-artifacts/audio-eq',{recursive:true});await fs.writeFile('.test-artifacts/audio-eq/dsp-benchmark.json',JSON.stringify({generatedAt:new Date().toISOString(),sourceSha256,rate,scope:'Synthetic CPU DSP only. Excludes decode, native time-stretch, preview, mixing, I/O and encoding; background load and JIT/cache not fully controlled.',results},null,2));console.log(JSON.stringify(results));
