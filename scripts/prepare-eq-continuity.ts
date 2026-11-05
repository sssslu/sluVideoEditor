import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newClip,newProject,splitClip} from '../shared/project';
import {defaultEQ} from '../shared/audio-eq';
import {probeMedia,runProcess} from '../electron/media';
const root=path.resolve('.test-artifacts/eq-continuity-ui');await fs.mkdir(root,{recursive:true});const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const audio=path.join(root,'tone.wav'),video=path.join(root,'tone.mkv');await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','aevalsrc=0.08*sin(2*PI*1000*t)|0.04*sin(2*PI*1000*t):s=48000:d=8','-c:a','pcm_f32le',audio]);
await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=160x90:rate=30:duration=8','-i',audio,'-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast','-c:a','pcm_f32le',video]);
for(const kind of ['audio','video'] as const){const media=await probeMedia(kind==='audio'?audio:video,ctx,undefined,{derivatives:false}),p=newProject(),eq=defaultEQ();eq.bands.forEach(b=>b.enabled=false);eq.bands[2]={enabled:true,type:'peaking',frequency:1000,gain:6,q:1};const clip={...newClip(`${kind}-1`,media),id:`${kind}-first`,in:.4,duration:6,audioEQ:eq},[first,rest]=splitClip(clip,2)!,[second,last]=splitClip(rest,4)!;p.id=`eq-continuity-${kind}`;p.name=`EQ continuity ${kind}`;p.width=320;p.height=180;p.media=[media];p.clips=[first,{...second,id:`${kind}-second`},{...last,id:`${kind}-last`}];await fs.writeFile(path.join(root,`${kind}.sluproj`),JSON.stringify(p));}
console.log('Prepared split audio and video EQ playback fixtures');
