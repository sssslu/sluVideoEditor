import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newClip,newProject} from '../shared/project';
import {probeMedia,runProcess} from '../electron/media';
const root=path.resolve('.test-artifacts/scopes-ui');await fs.mkdir(root,{recursive:true});const ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')},media=[];
for(const [name,rgb]of [['red',[255,0,0]],['blue',[0,0,255]]] as const){const bytes=Buffer.alloc(320*180*4);for(let i=0;i<bytes.length;i+=4){bytes[i]=rgb[0];bytes[i+1]=rgb[1];bytes[i+2]=rgb[2];bytes[i+3]=255;}const raw=path.join(root,`${name}.rgba`),png=path.join(root,`${name}.png`);await fs.writeFile(raw,bytes);await runProcess(ctx.ffmpeg,['-v','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size','320x180','-i',raw,'-frames:v','1',png]);media.push(await probeMedia(png,ctx,undefined,{derivatives:false}));}
const project={...newProject(),id:'scopes-fixture',name:'Scopes',width:320,height:180,media,clips:media.map((m,i)=>({...newClip('video-1',m,i),id:`scope-${i}`,duration:1}))};await fs.writeFile(path.join(root,'fixture.sluproj'),JSON.stringify(project));console.log('Prepared red/blue scope fixture');
