import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newProject,newClip} from '../shared/project';
import {clipSourceTime} from '../shared/speed';
import {probeMedia,renderProjectDirect,runProcess} from '../electron/media';
import type {MediaAsset,Project} from '../shared/types';

const root=path.resolve('.test-artifacts/render-clock'),ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false},assets=new Map<string,MediaAsset>(),timestamps=new Map<string,number[]>();
const code="geq=lum='if(lt(Y,12),if(mod(floor(N/pow(2,floor(X/20))),2),235,16),p(X,Y))':cb='if(lt(Y,6),128,p(X,Y))':cr='if(lt(Y,6),128,p(X,Y))'";
before(async()=>{await fs.mkdir(root,{recursive:true});for(const rate of ['10','24','30','60','30000/1001']){const file=path.join(root,`source-${rate.replace('/','-')}.mp4`);await runProcess(ctx.ffmpeg,['-v','error','-y','-f','lavfi','-i',`testsrc2=s=160x90:r=${rate}:d=4`,'-vf',code,'-c:v','libx264','-crf','0','-preset','ultrafast',file]);const media=await probeMedia(file,ctx,undefined,{derivatives:false});assets.set(rate,media);const frames=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',file])).stdout.toString()).frames;timestamps.set(rate,frames.map((f:any)=>Math.round(Number(f.best_effort_timestamp_time)*1e6)));}
  await runProcess(ctx.ffmpeg,['-v','error','-y','-i',path.join(root,'source-30.mp4'),'-c','copy','-bsf:v','h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1',path.join(root,'source-30-tagged.mp4')]);
});
async function raw(project:Project,label:string,chunk:number){const count=Math.ceil(Math.max(...project.clips.map(c=>c.start+c.duration))*project.fps-1e-7),buffers:Buffer[]=[];for(let from=0;from<count;from+=chunk){const frames=Math.min(chunk,count-from),file=path.join(root,`${label}-${from}.yuv`);await renderProjectDirect(project,{width:160,height:90,fps:project.fps,format:'mp4',codec:'h264',encoder:'cpu',quality:'high',outputPath:path.join(root,'unused.mp4')},ctx,undefined,undefined,{start:from/project.fps,duration:frames/project.fps,frames,destination:file});const b=await fs.readFile(file);assert.equal(b.length,frames*160*90*1.5,`${label} window${from} length`);buffers.push(b);}return Buffer.concat(buffers);}
function frames(buffer:Buffer){const result:number[]=[];for(let offset=0;offset<buffer.length;offset+=160*90*1.5){let frame=0;for(let bit=0;bit<8;bit++)if(buffer[offset+5*160+bit*20+10]>128)frame|=1<<bit;result.push(frame);}return result;}
test('Export sampling matches native microsecond frame boundaries across frame rates, fractional trims and speed curves',{timeout:180000},async()=>{
  const reports=[];
  for(const [rate,fps,sourceIn,speed,curve] of [['10',30,.137,.1,false],['30',30,0,1,false],['30',30,.06,1,false],['30',60,.137,1,false],['24',60,.013,1,false],['60',24,.137,1,false],['30000/1001',30,.06,1,false],['30',30,.137,1.5,false],['30',30,.137,1,true]] as const){
    const media=assets.get(rate)!,project=newProject();project.width=160;project.height=90;project.fps=fps;project.media=[media];const clip={...newClip('video-1',media),in:sourceIn,duration:1,speed,...(curve?{speedCurve:[{position:0,speed:.5},{position:.5,speed:2},{position:1,speed:1}]}:{})};project.clips=[clip];
    const label=`${rate.replace('/','-')}-${fps}-${sourceIn}-${speed}-${curve}`,actual=frames(await raw(project,label,7)),times=timestamps.get(rate)!;
    const expected=actual.map((_,n)=>{const target=Math.round((clipSourceTime(clip,n/fps)+(media.timing?.origin||0))*1e6);let last=0;for(let i=0;i<times.length;i++)if(times[i]<=target)last=i;return last;});
    const mismatches=actual.flatMap((frame,index)=>frame===expected[index]?[]:[{index,frame,expected:expected[index]}]);reports.push({label,frames:actual.length,mismatches});
  }
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify(reports,null,2));assert.equal(reports.reduce((n,row)=>n+row.mismatches.length,0),0,JSON.stringify(reports));
});
test('Fractional timeline placement retains source phase in each window and through the composite path',{timeout:120000},async()=>{
  const reports=[];
  for(const start of [.015,.5/30,7.25/30]){
    const project=newProject(),media=assets.get('30')!;project.width=160;project.height=90;project.fps=30;project.media=[media];const clip={...newClip('video-1',media),start,in:.137,duration:1};project.clips=[clip];
    const a=await raw(project,`phase-${start}`,7),b=await raw(project,`phase-whole-${start}`,100),actual=frames(a);assert.ok(a.equals(b),`window parity at${start}`);
    const times=timestamps.get('30')!,mismatches=[];for(let n=0;n<actual.length;n++){if(n/30<start||n/30>=start+clip.duration)continue;const target=Math.round((clipSourceTime(clip,n/30-start)+(media.timing?.origin||0))*1e6);let expected=0;for(let i=0;i<times.length;i++)if(times[i]<=target)expected=i;if(expected!==actual[n])mismatches.push({n,actual:actual[n],expected});}reports.push({start,frames:actual.length,mismatches});
  }
  await fs.writeFile(path.join(root,'phase-results.json'),JSON.stringify(reports,null,2));assert.equal(reports.reduce((n,row)=>n+row.mismatches.length,0),0,JSON.stringify(reports));
});
