import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {NutVideoStream} from '../electron/nut-video';
import {runProcess} from '../electron/media';

const root=path.resolve('.test-artifacts/nut-video'),ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),ffprobe=path.resolve('resources/bin/ffprobe.exe');
test('timestamped transparent raw stream decodes byte-exactly and FFV1 preserves irregular microsecond PTS',async()=>{
 await fs.mkdir(root,{recursive:true});const width=67,height=39,mux=new NutVideoStream(width,height),times=[0,33333,66667,1000000,1800001];
 const input=path.join(root,'raw.nut'),output=path.join(root,'lossless.nut'),file=await fs.open(input,'w');const frames:Buffer[]=[];
 try{
  await file.write(mux.header);
  for(let i=0;i<times.length;i++){
   const data=Buffer.from(Uint8Array.from({length:width*height*4},(_,j)=>(j*17+i*63+(j>>3))%256));frames.push(data);
   for(const part of mux.frame(data,times[i]))await file.write(part);
  }
 }finally{await file.close();}
 const raw=async(file:string)=>(await runProcess(ffmpeg,['-v','error','-nostdin','-i',file,'-map','0:v:0','-fps_mode','passthrough','-pix_fmt','bgra','-f','rawvideo','pipe:1'],{timeoutMs:30000})).stdout;
 const timestamps=async(file:string)=>{const info=JSON.parse((await runProcess(ffprobe,['-v','error','-show_frames','-show_streams','-of','json',file],{timeoutMs:30000})).stdout.toString());assert.equal(info.streams[0].pix_fmt,'bgra');return info.frames.map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*1e6));};
 assert.deepEqual(await raw(input),Buffer.concat(frames));assert.deepEqual(await timestamps(input),times);
 await runProcess(ffmpeg,['-v','error','-nostdin','-y','-i',input,'-map','0:v:0','-fps_mode','passthrough','-enc_time_base:v','1:1000000','-c:v','ffv1','-level','3','-g','1','-pix_fmt','bgra',output],{timeoutMs:30000});
 assert.deepEqual(await raw(output),Buffer.concat(frames));assert.deepEqual(await timestamps(output),times);
});

test('BGRA transport handles large checksummed packets and long timestamp gaps without wrapping',async()=>{
 await fs.mkdir(root,{recursive:true});const mux=new NutVideoStream(1920,1080),data=Buffer.alloc(mux.frameBytes,123),times=[400000000000,400000000001,864000000000],target=path.join(root,'large.nut');
 const file=await fs.open(target,'w');try{await file.write(mux.header);for(const time of times)for(const part of mux.frame(data,time))await file.write(part);}finally{await file.close();}
 const result=await runProcess(ffprobe,['-v','error','-show_packets','-show_entries','packet=pts,size','-of','json',target],{timeoutMs:30000});const packets=JSON.parse(result.stdout.toString()).packets;
 assert.deepEqual(packets.map((p:any)=>p.pts),times);assert.ok(packets.every((p:any)=>Number(p.size)===data.length));
});

test('bad dimensions, frame sizes and nonmonotonic timestamps are rejected before writing',()=>{
 assert.throws(()=>new NutVideoStream(8192,8192));const mux=new NutVideoStream(16,16),data=new Uint8Array(16*16*4);
 for(const pts of [-1,NaN,.5,864000000001])assert.throws(()=>mux.frame(data,pts));assert.throws(()=>mux.frame(new Uint8Array(1),0));
 const packets=mux.frame(data,0);assert.equal(packets[2].buffer,data.buffer);assert.throws(()=>mux.frame(data,0));
});

test('8K transport requires the explicit bounded enhancement pixel allowance',()=>{
 assert.throws(()=>new NutVideoStream(7680,4320));
 const mux=new NutVideoStream(7680,4320,33177600);
 assert.equal(mux.frameBytes,7680*4320*4);
 assert.throws(()=>new NutVideoStream(7680,4321,33177600));
 assert.throws(()=>new NutVideoStream(8192,8192,8192*8192));
 assert.throws(()=>new NutVideoStream(1,1,NaN));
});
