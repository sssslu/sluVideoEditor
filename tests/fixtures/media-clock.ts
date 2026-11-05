import {promises as fs} from 'node:fs';
import path from 'node:path';
import {probeMedia,runProcess,type EngineContext} from '../../electron/media';

export async function prepareClockFixtures(root:string,ctx:EngineContext){
  await fs.mkdir(root,{recursive:true});
  const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:60000});
  const base=path.join(root,'base.mkv'),files:Record<string,string>={base};
  // Eight monochrome cells encode the original frame number. Reading those bits
  // verifies frame identity independently of browser/FFmpeg color conversion.
  const frameCode="geq=lum='if(lt(Y,12),if(mod(floor(N/pow(2,floor(X/20))),2),235,16),p(X,Y))':cb='if(lt(Y,6),128,p(X,Y))':cr='if(lt(Y,6),128,p(X,Y))'";
  await ff(['-f','lavfi','-i','testsrc2=size=160x90:rate=10:duration=4','-f','lavfi','-i',"aevalsrc='if(lt(t,1),0.05,if(lt(t,2),0.1,if(lt(t,3),0.2,0.3)))*sin(2*PI*1000*t)|0.025*sin(2*PI*750*t)':s=48000:d=4",'-vf',frameCode,'-c:v','libx264','-preset','ultrafast','-crf','0','-g','20','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-c:a','pcm_f32le',base]);
  for(const [name,extension,offset,audio] of [['shifted','mkv',2,'pcm_f32le'],['mp4','mp4',0,'aac'],['mp4-shifted','mp4',2,'aac']] as const){const file=path.join(root,`${name}.${extension}`);await ff(['-itsoffset',String(offset),'-i',base,'-c:v','copy','-c:a',audio,'-avoid_negative_ts','disabled',file]);files[name]=file;}
  for(const [name,extension,codec] of [['mp3','mp3','libmp3lame'],['m4a','m4a','aac'],['opus','ogg','libopus']] as const){const file=path.join(root,`${name}.${extension}`);await ff(['-i',base,'-vn','-c:a',codec,file]);files[name]=file;}
  const assets=Object.fromEntries(await Promise.all(Object.entries(files).map(async([name,file])=>[name,await probeMedia(file,ctx,undefined,{derivatives:false})])));
  return {files,assets};
}
