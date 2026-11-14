import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newClip,newProject} from '../shared/project';
import {probeMedia,runProcess} from '../electron/media';
const root=path.resolve('.test-artifacts/audio-fixture');await fs.mkdir(root,{recursive:true});
const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')},file=path.join(root,'stereo-levels.wav');
await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','aevalsrc=0.5*sin(2*PI*1000*t)|0.125*sin(2*PI*750*t):s=48000:d=30','-c:a','pcm_f32le',file]);
const media=await probeMedia(file,ctx,undefined,{derivatives:false}),project={...newProject(),id:'audio-fixture',name:'Stereo levels',width:320,height:180,media:[media],clips:[{...newClip('audio-1',media,0),id:'eq-audio-clip',fadeIn:0,fadeOut:0}]};
await fs.writeFile(path.join(root,'fixture.sluproj'),JSON.stringify(project));console.log('Prepared independent stereo sine levels');
