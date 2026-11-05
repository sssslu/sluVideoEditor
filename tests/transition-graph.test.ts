import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newClip} from '../shared/project';
import {transitionInterval,transitionPixel,transitionProgress} from '../shared/transitions';
import type {Transition} from '../shared/types';
import {appendTransitionPair,transitionOpacityCommands} from '../electron/render-transitions';
import {runProcess} from '../electron/media';

const root=path.resolve('.test-artifacts/transitions/graph'),ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),width=32,height=18,fps=11,frames=12;
const ff=(args:string[])=>runProcess(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args]);
function sampler(pixels:Buffer){return (u:number,v:number)=>{
  const x=Math.max(0,Math.min(width-1,u*width-.5)),y=Math.max(0,Math.min(height-1,v*height-.5)),x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1),fx=x-x0,fy=y-y0;
  const pixel=(px:number,py:number)=>{const i=(py*width+px)*4,a=pixels[i+3]/255;return [pixels[i]/255*a,pixels[i+1]/255*a,pixels[i+2]/255*a,a];};
  const a=pixel(x0,y0),b=pixel(x1,y0),c=pixel(x0,y1),d=pixel(x1,y1);return a.map((n,i)=>(n*(1-fx)+b[i]*fx)*(1-fy)+(c[i]*(1-fx)+d[i]*fx)*fy);
};}

test('FFmpeg transitions match shared premultiplied pixel math for transparency, directions, easing and endpoints',{timeout:30000},async(t)=>{
  await fs.mkdir(root,{recursive:true});const pixels=[Buffer.alloc(width*height*4),Buffer.alloc(width*height*4)];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;pixels[0].set([40+x*5,30+y*6,75,x<width/2?128:255],i);pixels[1].set([20,200-y*5,30+x*6,y<height/2?64:220],i);}
  for(let i=0;i<2;i++){await fs.writeFile(path.join(root,`${i}.rgba`),pixels[i]);await ff(['-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-i',path.join(root,`${i}.rgba`),'-frames:v','1',path.join(root,`${i}.png`)]);}
  const a=newClip('video-1'),b=newClip('video-1');a.duration=.5;b.start=.5;b.duration=1;
  const cases:Pick<Transition,'kind'|'direction'|'easing'>[]=[{kind:'dissolve'},{kind:'zoom'},...(['left','right','up','down'] as const).flatMap(direction=>[{kind:'wipe' as const,direction},{kind:'slide' as const,direction}]),...(['ease-in','ease-out','ease-in-out','hold'] as const).map(easing=>({kind:'dissolve' as const,easing}))];
  const results=[];
  for(const entry of cases){const transition={id:'pair',fromClipId:a.id,toClipId:b.id,durationFrames:4,...entry},compiled=transitionInterval(transition,a,b,4),graph:string[]=[];await fs.writeFile(path.join(root,'opacity.cmd'),transitionOpacityCommands(compiled,'pair',`(PTS+1)/${fps}`));appendTransitionPair(graph,compiled,'0:v:0','1:v:0','pair',width,height,'T','opacity.cmd',1,{fps,frames,startFrame:0});
    const raw=(await runProcess(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-filter_complex_threads','1','-loop','1','-framerate',String(fps),'-i',path.join(root,'0.png'),'-loop','1','-framerate',String(fps),'-i',path.join(root,'1.png'),'-filter_complex',graph.join(';'),'-map','[pair]','-frames:v',String(frames),'-pix_fmt','rgba','-f','rawvideo','pipe:1'],{cwd:root})).stdout;assert.equal(raw.length,width*height*4*frames);
    let maximum=0,total=0;for(let frame=0;frame<frames;frame++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const color=transitionPixel(entry.kind,transitionProgress(compiled,frame/fps),entry.direction,(x+.5)/width,(y+.5)/height,sampler(pixels[0]),sampler(pixels[1])),expected=[...color.slice(0,3).map(value=>color[3]>0?value/color[3]:0),color[3]].map(value=>Math.round(Math.min(1,Math.max(0,value))*255)),at=((frame*height+y)*width+x)*4;
      for(let channel=0;channel<4;channel++){const difference=Math.abs(raw[at+channel]-expected[channel]);maximum=Math.max(maximum,difference);total+=difference;}
    }
    const result={...entry,maximumError:maximum,meanError:total/raw.length};results.push(result);if(maximum>2){await fs.writeFile(path.join(root,'failed.rgba'),raw);await fs.writeFile(path.join(root,'failed-filter.txt'),graph.join(';'));t.diagnostic(JSON.stringify({samples:Array.from({length:5},(_,i)=>[...raw.subarray(i*width*height*4,i*width*height*4+4)])}));}assert.ok(maximum<=2,JSON.stringify(result));
  }
  await fs.writeFile(path.join(root,'results.json'),JSON.stringify(results,null,2));t.diagnostic(JSON.stringify(results));
});


