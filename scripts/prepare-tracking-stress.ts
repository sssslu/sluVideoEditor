import {promises as fs} from 'node:fs';
import path from 'node:path';
import {probeMedia,runProcess} from '../electron/media';
import {fileDigests} from '../electron/file-digest';

// A small public research clip is enlarged/padded to exercise UHD decoding.
// Repetition is deliberate. This is a workload fixture, not an accuracy set.
const root=path.resolve('.test-artifacts/tracking-stress-fixtures');await fs.mkdir(root,{recursive:true});
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const fixture=JSON.parse(await fs.readFile('.test-artifacts/tracking-fixtures/david.json','utf8'));
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y',...args],{timeoutMs:180000});
const cases=[];
for(const fps of [30,60]){
  const short=path.join(root,`uhd-${fps}-4s.mp4`),long=path.join(root,`uhd-${fps}-120s.mp4`);
  await ff(['-ss','11.96','-i',path.resolve('.build-cache/tracking/samples/david/david.webm'),'-t','4','-an','-vf',`fps=${fps},scale=2880:2160:flags=bilinear,pad=3840:2160:480:0:black,setsar=1`,'-c:v','h264_nvenc','-preset','p3','-qp','24','-g',String(fps*2),'-bf','3','-color_range','tv','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709',short]);
  await ff(['-stream_loop','29','-i',short,'-map','0:v:0','-c','copy','-movflags','+faststart',long]);
  const media=await probeMedia(long,ctx,undefined,{derivatives:false});if(media.width!==3840||media.height!==2160||Math.abs(media.duration-120)>.01||media.fps!==fps)throw new Error('Unexpected UHD fixture');
  cases.push({fps,media,digest:await fileDigests.read(long)});
}
await fs.writeFile(path.join(root,'fixtures.json'),JSON.stringify({scope:'Padded/upscaled/repeated public David sequence, not native UHD details or a tracking accuracy benchmark',ground:fixture.ground.slice(0,100),cases},null,2));
console.log(JSON.stringify(cases.map(c=>({fps:c.fps,bytes:c.digest.bytes,duration:c.media.duration}))));
