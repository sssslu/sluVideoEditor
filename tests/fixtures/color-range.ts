import {promises as fs} from 'node:fs';
import path from 'node:path';
import {probeMedia,runProcess,type EngineContext} from '../../electron/media';
import {newClip,newProject} from '../../shared/project';

export const colorPatches=[[0,0,0],[16,16,16],[64,64,64],[128,128,128],[235,235,235],[255,255,255],[220,35,70],[30,180,220]];
// Expected decoding conventions are specified independently of production code.
// The two HD cases also exercise Chromium's resolution-dependent legacy fallback.
export const colorCases=[
  {name:'partial-sd-pc',width:160,height:90,codec:'libx264',range:'pc',complete:false,matrix:'bt601',previewRange:'tv'},
  {name:'complete-sd-pc',width:160,height:90,codec:'libx264',range:'pc',complete:true,matrix:'bt709',previewRange:'pc'},
  {name:'complete-sd-tv',width:160,height:90,codec:'libx264',range:'tv',complete:true,matrix:'bt709',previewRange:'tv'},
  {name:'vp9-sd-pc',width:160,height:90,codec:'libvpx-vp9',range:'pc',complete:false,matrix:'bt709',previewRange:'pc'},
  {name:'partial-hd-pc',width:1280,height:720,codec:'libx264',range:'pc',complete:false,matrix:'bt709',previewRange:'tv'},
  {name:'partial-wide-tv',width:1600,height:750,codec:'libx264',range:'tv',complete:false,matrix:'bt709',previewRange:'tv'},
] as const;

export async function prepareColorFixtures(root:string,ctx:EngineContext){
  await fs.mkdir(root,{recursive:true});const cases=[];
  for(const spec of colorCases){
    const {width,height}=spec,raw=Buffer.alloc(width*height*3*2);
    for(let frame=0;frame<2;frame++)for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<3;c++)raw[((frame*height+y)*width+x)*3+c]=colorPatches[Math.floor(x*8/width)][c];
    const input=path.join(root,`${spec.name}.rgb`),file=path.join(root,`${spec.name}.${spec.codec==='libx264'?'mp4':'webm'}`);await fs.writeFile(input,raw);
    // Encoder CLI tags alone can be overridden by incoming frame metadata.
    // Set frame metadata as well, and have the tests assert the actual bitstream.
    await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-y','-f','rawvideo','-pix_fmt','rgb24','-s',`${width}x${height}`,'-r','2','-i',input,'-vf',`scale=out_color_matrix=bt709:out_range=${spec.range},format=yuv420p${spec.complete?',setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709':''}`,'-c:v',spec.codec,...(spec.codec==='libx264'?['-preset','ultrafast','-crf','12']:['-lossless','1','-cpu-used','5']),'-colorspace','bt709','-color_range',spec.range,...(spec.complete?['-color_primaries','bt709','-color_trc','bt709']:[]),file],{timeoutMs:60000});
    const media=await probeMedia(file,ctx),info=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-show_streams','-of','json',file])).stdout.toString()).streams[0];
    const project=newProject();project.id=`color-${spec.name}`;project.name=project.id;project.width=width===1600?320:160;project.height=width===1600?150:90;project.fps=30;project.background='#14283c';project.media=[media];project.clips=[{...newClip('video-1',media),id:'color-clip',duration:.8}];
    cases.push({spec,media,info,project});
  }
  return cases;
}

export type ColorFixture=Awaited<ReturnType<typeof prepareColorFixtures>>[number];

export function patchSamples(raw:Uint8Array,width:number,height:number,channels=4,offset=0):number[][]{
  return colorPatches.map((_,i)=>{const at=offset+(Math.floor(height/2)*width+Math.floor(width*(i+.5)/8))*channels;return Array.from(raw.slice(at,at+channels));});
}

/** Independent numeric oracle from unchanged decoded Y/U/V plane bytes.
 * It deliberately uses no scale filter or production color-selection helper. */
export async function colorReference(row:ColorFixture,ctx:EngineContext){
  const {width,height,matrix,previewRange}=row.spec;
  const raw=(await runProcess(ctx.ffmpeg,['-v','error','-nostdin','-i',row.media.path,'-frames:v','1','-pix_fmt',row.info.pix_fmt,'-f','rawvideo','pipe:1'],{maxOutputBytes:8*1024*1024})).stdout;
  const plane=width*height,kr=matrix==='bt601'?.299:.2126,kb=matrix==='bt601'?.114:.0722,kg=1-kr-kb;
  if(raw.length!==plane*1.5)throw new Error('Expected unchanged 8-bit planar420 fixture');
  return colorPatches.map((_,i)=>{
    const x=Math.floor(width*(i+.5)/8),y=Math.floor(height/2),yuv=[raw[y*width+x],raw[plane+Math.floor(y/2)*width/2+Math.floor(x/2)],raw[plane*1.25+Math.floor(y/2)*width/2+Math.floor(x/2)]];
    const l=previewRange==='tv'?(yuv[0]-16)*255/219:yuv[0],u=(yuv[1]-128)*(previewRange==='tv'?255/224:1),v=(yuv[2]-128)*(previewRange==='tv'?255/224:1);
    return {yuv,rgb:[l+2*(1-kr)*v,l-2*kb*(1-kb)/kg*u-2*kr*(1-kr)/kg*v,l+2*(1-kb)*u].map(value=>Math.max(0,Math.min(255,value)))};
  });
}
