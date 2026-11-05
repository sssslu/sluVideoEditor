import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {NutVideoStream} from '../electron/nut-video';
import {reverseMedia} from '../electron/reverse';
import {probeMedia,runProcess} from '../electron/media';

test('cutout FFV1 reverse keeps every RGB/alpha byte across chunk boundaries and reverses exact VFR display intervals',async()=>{
 const root=path.resolve('.test-artifacts/reverse-alpha',Date.now().toString());await fs.mkdir(root,{recursive:true});
 const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),derivedDir:path.join(root,'derived'),reverseBufferBytes:32*32*4*2};
 const mux=new NutVideoStream(32,32),pts=[0,100000,250000,300000,700000],frames=pts.map((_,i)=>Buffer.from(Uint8Array.from({length:32*32*4},(_,p)=>(i*43+p*7)%256)));
 const source=path.join(root,'original.mov'),input=path.join(root,'input.nut');await fs.writeFile(input,Buffer.concat([mux.header,...frames.flatMap((frame,i)=>[...mux.frame(frame,pts[i])])]));
 await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-f','nut','-i',input,'-c:v','ffv1','-level','3','-pix_fmt','bgra','-fps_mode','passthrough','-enc_time_base:v','1:1000000','-color_range','pc','-colorspace','rgb','-color_primaries','bt709','-color_trc','iec61966-2-1','-bsf:v',"setts=duration='if(eq(N,4),300000,DURATION)'",'-video_track_timescale','1000000','-movie_timescale','1000000',source]);
 const media=await probeMedia(source,ctx,undefined,{derivatives:false});assert.equal(media.hasAlpha,true);
 const diagnostics:Record<string,unknown>[]=[],output=await reverseMedia(media,{start:.15,duration:.6},{...ctx,diagnostics:e=>diagnostics.push(e)});
 const info=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-show_frames','-show_streams','-of','json',output.path])).stdout.toString());
 assert.equal(output.hasAlpha,true);assert.ok(Math.abs(output.duration-.6)<1e-6);assert.equal(info.streams[0].codec_name,'ffv1');assert.equal(info.streams[0].pix_fmt,'bgra');
 assert.deepEqual(info.frames.map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*1e6)),[0,50000,450000,500000]);
 const decoded=(await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-i',output.path,'-fps_mode','passthrough','-pix_fmt','bgra','-f','rawvideo','pipe:1'])).stdout;
 assert.deepEqual(decoded,Buffer.concat([frames[4],frames[3],frames[2],frames[1]]));assert.ok(diagnostics.some(e=>e.event==='reverse-encoded'&&e.encoder==='ffv1'&&e.parts===2));
 await fs.writeFile(path.join(root,'results.json'),JSON.stringify({source,output,diagnostics,frames:4,exactBytes:decoded.length},null,2));
});
