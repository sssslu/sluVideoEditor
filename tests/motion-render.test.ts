import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {newProject,newClip,interpolate,splitClip} from '../shared/project';
import {attachMotion,splitMotionSources,reconcileMotion} from '../shared/motion';
import {MotionPageCache} from '../shared/motion-pages';
import type {MotionAnalysis,MotionSample} from '../shared/tracking';
import type {Project} from '../shared/types';
import {MotionSampleWriter,assembleMotionFile,MotionFileReader} from '../electron/tracking-file';
import {TrackingRegistry} from '../electron/tracking-registry';
import {RenderMotion} from '../electron/render-motion';
import {probeMedia,runProcess,renderProject,type EngineContext} from '../electron/media';
import {assertProject} from '../shared/validation';
import {readProject,serializeProject} from '../electron/project-store';
import {createHash} from 'node:crypto';

const root=path.resolve('.test-artifacts/motion-render'),ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-y','-nostdin',...args],{timeoutMs:120000,maxOutputBytes:128*1024*1024});
type Fixture={project:Project;analysis:MotionAnalysis;samples:MotionSample[]};
let fixture:Fixture|undefined;
async function prepare():Promise<Fixture>{
  if(fixture)return fixture;await fs.mkdir(root,{recursive:true});const id=Date.now().toString(),source=path.join(root,`source-${id}.mp4`),image=path.join(root,'marker.png');
  await ff(['-f','lavfi','-i','color=c=black:s=160x90:r=30:d=22','-c:v','libx264','-crf','0',source]);await ff(['-f','lavfi','-i','color=c=white:s=20x20','-frames:v','1',image]);
  const media=await probeMedia(source,ctx,undefined,{derivatives:false}),marker=await probeMedia(image,ctx,undefined,{derivatives:false});
  const samples:MotionSample[]=Array.from({length:660},(_,i)=>({time:i/30,box:{x:.2+i/3000,y:.3+i/6000,width:.1,height:.1},score:.9,status:'tracked',anchor:i===0}));
  const file=path.join(root,`motion-${id}.slutrack`),forward=file+'.forward',back=file+'.back',writer=await MotionSampleWriter.open(forward,1);for(const s of samples)await writer.append(s);await writer.close();await fs.writeFile(back,'');
  const metadata:Omit<MotionAnalysis,'path'>={version:1,id,mediaId:media.id,sourceRevision:media.sourceRevision!,sourceWidth:160,sourceHeight:90,analysisWidth:160,analysisHeight:90,start:0,end:22,firstFrameTime:0,frames:660,anchors:[{time:0,box:samples[0].box}],backend:'cpu'};
  await assembleMotionFile(file,metadata,back,forward);const analysis={...metadata,path:file};
  const p=newProject();p.width=320;p.height=180;p.fps=30;p.background='#000000';p.media=[media,marker];p.tracks[0].hidden=true;p.tracks.push({id:'image',name:'image',type:'video',hidden:false,locked:false,muted:true});
  const sourceClip={...newClip('video-1',media),id:'source',duration:4},target={...newClip('image',marker),id:'marker',duration:4,scale:.05,x:-80,y:-27};p.clips=[sourceClip,target];
  const project=attachMotion(p,'source',['marker'],analysis,samples[0],0,false);fixture={project,analysis,samples};return fixture;
}

test('tracking project survives save/reopen approval, rejects substitution and changed source',async()=>{
  const {project,analysis}=await prepare(),file=path.join(root,'saved.sluproj');await fs.writeFile(file,serializeProject(project,true));const opened=await readProject(file);assertProject(opened);assert.deepEqual(opened,JSON.parse(JSON.stringify(project)));
  const registry=new TrackingRegistry();assert.throws(()=>registry.approveProject(opened));registry.approveProject(opened,true);assert.equal((await registry.read(analysis.path,1,10)).samples.length,10);
  const changed=structuredClone(opened);changed.motionPaths![0].anchors[0].box.x=.5;assert.throws(()=>registry.approveProject(changed),/변경/);
  const other=new TrackingRegistry();other.approveProject(changed,true);await assert.rejects(other.read(analysis.path,1),/정보가 일치/);
  const missing=structuredClone(project);missing.motionPaths![0].path=path.join(root,'absent.slutrack');registry.approveProject(missing,true);registry.approveProject(missing);await assert.rejects(registry.read(missing.motionPaths![0].path,1));assert.equal(missing.clips[1].motionBinding!.analysisId,analysis.id);
  const touched=structuredClone(project);touched.media[0].sourceRevision='b'.repeat(64);const render=new RenderMotion(touched);await assert.rejects(render.prepare(),/추적 원본이 변경/);
});
test('bounded motion pages retain distant playheads, evict old pages and reject wrong coverage',async()=>{
  const {analysis}=await prepare();let calls=0;const cache=new MotionPageCache(async(file,time,limit)=>{calls++;const reader=await MotionFileReader.open(file);try{return {metadata:reader.metadata,...await reader.range(time,limit)};}finally{await reader.close();}},()=>{},2);
  assert.equal((await cache.get(analysis,1)).time,1);assert.equal((await cache.get(analysis,20)).time,20);const before=calls;assert.equal((await cache.get(analysis,1)).time,1);assert.equal(calls,before);assert.equal(cache.stats().pages,2);assert.ok(cache.stats().samples<=1024);
  await cache.get(analysis,0);assert.equal(cache.stats().pages,2);cache.clear();assert.equal(cache.stats().samples,0);
  const bad=new MotionPageCache(async()=>({metadata:analysis,startIndex:1,samples:[{time:10,box:{x:0,y:0,width:1,height:1},score:1,status:'tracked',anchor:false}],nextIndex:2}));await assert.rejects(bad.get(analysis,2),/요청한 프레임/);
});
test('window-only output keys preserve source frame holds across 120 fps output and manual animation',async()=>{
  const {project,analysis}=await prepare(),p=structuredClone(project);p.clips[1].duration=22;p.clips[0].duration=22;p.clips[1].keyframes=[{time:0,x:-80,y:-27,scale:.05,rotation:0,opacity:1,easing:'ease-in'},{time:22,x:-50,y:-7,scale:.08,rotation:0,opacity:.8}];
  const before=serializeProject(p),motion=new RenderMotion(p);await motion.prepare();const resolved=await motion.window(1200,720,120);assert.equal(resolved.clips[1].keyframes.length,720);assert.equal(serializeProject(p),before);
  for(const index of [0,1,3,4,250,718,719]){const t=(1200+index)/120,k=resolved.clips[1].keyframes[index],manual=interpolate(p.clips[1],t),frame=Math.floor(t*30+1e-8);assert.ok(Math.abs(k.x-(manual.x+frame/3000*320))<.0001);assert.ok(Math.abs(k.y-(manual.y+frame/6000*180))<.0001);assert.equal(k.scale,manual.scale);assert.equal(k.opacity,manual.opacity);}
  const abort=new AbortController(),cancelled=new RenderMotion(p,abort.signal);abort.abort();await assert.rejects(cancelled.prepare(),{name:'AbortError'});await motion.verify();assert.equal(analysis.frames,660);
});
test('actual output follows every held source frame through bounded render windows',{timeout:180000},async()=>{
  const {project}=await prepare(),output=path.join(root,'output.mp4');const diagnostics:Record<string,unknown>[]=[];
  await renderProject(project,{width:320,height:180,fps:120,format:'mp4',codec:'h264',quality:'high',encoder:'cpu',outputPath:output},{...ctx,maxWindowSeconds:.7,diagnostics:e=>diagnostics.push(e)});
  const raw=(await ff(['-i',output,'-an','-pix_fmt','rgb24','-fps_mode','passthrough','-f','rawvideo','pipe:1'])).stdout,stride=320*180*3;assert.equal(raw.length,stride*480);
  let maximum=0;for(let frame=0;frame<480;frame++){let x=0,y=0,count=0;for(let py=0;py<180;py++)for(let px=0;px<320;px++){const at=frame*stride+(py*320+px)*3;if(raw[at]>200&&raw[at+1]>200&&raw[at+2]>200){x+=px;y+=py;count++;}}assert.ok(count>20,'missing marker '+frame);const sourceFrame=Math.floor(frame/4),expectedX=80+sourceFrame/3000*320,expectedY=63+sourceFrame/6000*180;maximum=Math.max(maximum,Math.abs(x/count-expectedX),Math.abs(y/count-expectedY));assert.ok(maximum<2,'frame '+frame+' difference '+maximum);}
  assert.ok(diagnostics.filter(e=>e.event==='window-start').length>1);await fs.writeFile(path.join(root,'results.json'),JSON.stringify({frames:480,maximumCentroidError:maximum,windows:diagnostics.filter(e=>e.event==='window-start').length},null,2));
});
test('nonaligned tracked scale, eased manual transforms and a transition retain pixel parity across window boundaries',{timeout:180000},async()=>{
  const {project}=await prepare(),p=structuredClone(project),s=p.clips[0],c=p.clips[1];
  s.crop={left:.1,right:.2,top:.1,bottom:0};s.flipH=true;s.keyframes=[{time:0,x:0,y:0,scale:.8,rotation:10,opacity:1,easing:'ease-in-out'},{time:4,x:20,y:10,scale:1.3,rotation:30,opacity:1}];
  c.start=.137;c.duration=1.4;c.motionBinding!.followScale=true;c.keyframes=[{time:0,x:-80,y:-27,scale:.06,rotation:0,opacity:1,easing:'ease-out'},{time:1.4,x:-45,y:-10,scale:.1,rotation:35,opacity:.75}];
  const next={...structuredClone(c),id:'next',start:c.start+c.duration,duration:1.4};p.clips.push(next);p.transitions=[{id:'transition',fromClipId:c.id,toClipId:next.id,kind:'dissolve',durationFrames:12,easing:'ease-in-out'}];assertProject(p);
  const hashes=[];for(const seconds of [.37,1.25]){const output=path.join(root,`complex-${seconds}.mp4`);await renderProject(p,{width:320,height:180,fps:60,format:'mp4',codec:'h264',quality:'high',encoder:'cpu',outputPath:output},{...ctx,maxWindowSeconds:seconds});const raw=(await ff(['-i',output,'-an','-pix_fmt','rgb24','-fps_mode','passthrough','-f','rawvideo','pipe:1'])).stdout;hashes.push(createHash('sha256').update(raw).digest('hex'));assert.equal(raw.length,320*180*3*240);}
  assert.equal(hashes[0],hashes[1]);await fs.writeFile(path.join(root,'window-parity.json'),JSON.stringify({windows:[.37,1.25],frames:240,hashes},null,2));
});

test('splitting a speed-ramped, transformed source keeps every decoded tracked-image output pixel unchanged',{timeout:180000},async()=>{
  const {project}=await prepare(),p=structuredClone(project),s=p.clips[0],c=p.clips[1];s.speedCurve=[{position:0,speed:.5},{position:1,speed:1.5}];s.crop={left:.1,right:.2,top:.1,bottom:0};s.flipH=true;s.keyframes=[{time:0,x:0,y:0,scale:.8,rotation:10,opacity:1,easing:'ease-in-out'},{time:4,x:20,y:10,scale:1.3,rotation:30,opacity:1}];c.start=.137;c.duration=2.8;c.motionBinding!.followScale=true;c.keyframes=[{time:0,x:-80,y:-27,scale:.08,rotation:17,opacity:1,easing:'ease-out'},{time:2.8,x:-45,y:-10,scale:.1,rotation:35,opacity:1}];
  const pieces=splitClip(s,1.137)!,again=splitClip(pieces[1],2.917)!,all=[pieces[0],...again],split=splitMotionSources(p,[...all,c],new Map([[s.id,all]]));assertProject(split);const hashes=[];
  for(const [name,project] of [['whole',p],['split',split]] as const){const output=path.join(root,`source-${name}.mp4`);await renderProject(project,{width:320,height:180,fps:60,format:'mp4',codec:'h264',quality:'high',encoder:'cpu',outputPath:output},{...ctx,maxWindowSeconds:.73});const raw=(await ff(['-i',output,'-an','-pix_fmt','rgb24','-fps_mode','passthrough','-f','rawvideo','pipe:1'])).stdout;assert.equal(raw.length,320*180*3*240);hashes.push(createHash('sha256').update(raw).digest('hex'));}
  assert.equal(hashes[0],hashes[1]);await fs.writeFile(path.join(root,'split-parity.json'),JSON.stringify({frames:240,splits:[1.137,2.917],hashes},null,2));
});
test('export follows an edited right piece and its last snapshot after deletion',{timeout:180000},async()=>{
  const {project}=await prepare(),parts=splitClip(project.clips[0],2)!,p=splitMotionSources(project,[...parts,project.clips[1]],new Map([['source',parts]]));p.clips[1]={...p.clips[1],x:36};const removed=reconcileMotion(p,{...p,clips:p.clips.filter(c=>c.id!==parts[1].id)}),hashes=[];
  for(const [name,scene] of [['live',p],['deleted',removed]] as const){const output=path.join(root,`right-${name}.mp4`);await renderProject(scene,{width:320,height:180,fps:30,format:'mp4',codec:'h264',quality:'high',encoder:'cpu',outputPath:output},{...ctx,maxWindowSeconds:.7});const raw=(await ff(['-i',output,'-an','-pix_fmt','rgb24','-fps_mode','passthrough','-f','rawvideo','pipe:1'])).stdout;assert.equal(raw.length,320*180*3*120);for(const frame of [0,30,59,60,61,90,119]){let x=0,n=0;for(let i=0;i<320*180;i++){const at=(frame*320*180+i)*3;if(raw[at]>200&&raw[at+1]>200&&raw[at+2]>200){x+=i%320;n++;}}assert.ok(n>20);assert.ok(Math.abs(x/n-(80+frame/3000*320+(frame>=60?36:0)))<2,`${name} frame ${frame}: ${x/n}`);}hashes.push(createHash('sha256').update(raw).digest('hex'));}
  assert.equal(hashes[0],hashes[1]);await fs.writeFile(path.join(root,'split-deletion-parity.json'),JSON.stringify({frames:120,hashes},null,2));
});
