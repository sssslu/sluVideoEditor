import {app,BrowserWindow} from 'electron';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {newProject,newClip,splitClip} from '../shared/project';
import {defaultCaptionStyle} from '../shared/captions';
import type {ExportSettings,Project,Clip} from '../shared/types';
import {createCaptionRasterWithPaths} from '../electron/caption-raster';
import {renderProject,renderProjectDirect,runProcess,type EngineContext} from '../electron/media';
import type {CaptionRasterFactory} from '../electron/caption-raster-types';
import {electronTestLifecycle} from './electron-test-lifecycle';

const root=path.resolve('.test-artifacts/rich-captions'),checks:string[]=[],details:unknown[]=[],events:Record<string,unknown>[]=[];
if(process.env.SLU_USER_DATA)app.setPath('userData',process.env.SLU_USER_DATA);
const lifecycle=electronTestLifecycle();
const paths={directory:path.resolve('dist'),preload:path.resolve('dist-electron/caption-preload.cjs')};
const factory:CaptionRasterFactory=async(project,settings,signal,diagnostics)=>{const session=await createCaptionRasterWithPaths(project,settings,signal?AbortSignal.any([signal,lifecycle.signal]):lifecycle.signal,diagnostics,paths);lifecycle.registerCleanup(()=>session.close());return session;};
const ctx:EngineContext={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),gpuProcessing:false,captionRasterFactory:factory,diagnostics:event=>events.push(event)};
const settings=(fps:number,width=320,height=180):ExportSettings=>({width,height,fps,format:'mp4',codec:'h264',encoder:'cpu',quality:'high',outputPath:path.join(root,`output-${fps}.mp4`)});
function fixture(fps=120):Project{
  const p=newProject();p.width=320;p.height=180;p.fps=fps;p.background='#000000';
  const c=newClip('text-1');Object.assign(c,{text:'한글 ABC {\\} 👩‍💻',duration:1.6,start:.003,fontSize:25,y:0,animation:'none',captionStyle:{...defaultCaptionStyle(),background:'line',outlineWidth:1,paddingX:6,paddingY:3,radius:5},captionWords:[{from:0,to:2,start:.101,end:.307,timing:'measured'},{from:3,to:6,start:.307,end:.511,timing:'manual'}],captionAnimation:{entry:'pop',exit:'slide',entrySeconds:.1,exitSeconds:.12,easing:'ease-in-out'},fadeIn:.05,fadeOut:.07,keyframes:[{time:0,x:-25,y:0,scale:.9,opacity:.8,rotation:-5,easing:'ease-in-out'},{time:1.6,x:25,y:0,scale:1.1,opacity:1,rotation:5}]});p.clips=[c];return p;
}
app.on('window-all-closed',()=>{});
let reference:BrowserWindow|undefined;
const hashFiles=async(files:string[])=>Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
void (async()=>{
try{
  await app.whenReady();await fs.mkdir(root,{recursive:true});
  const sourceFiles=['electron/media.ts','electron/caption-raster.ts','electron/caption-renderer.ts','electron/caption-preload.ts','electron/caption-raster-types.ts','electron/render-captions.ts','electron/render-plan.ts','src/preview/text.ts','src/preview/math.ts','src/captions/font.ts','src/captions/layout.ts','shared/captions.ts','shared/project.ts'];
  const bundleFiles=['dist/caption-export.html','dist-electron/caption-preload.cjs',...((await fs.readdir('dist/assets')).filter(file=>/^(text-|captions-|Noto)/.test(file)).map(file=>`dist/assets/${file}`))];
  const sourceHashes=await hashFiles(sourceFiles),bundleHashes=await hashFiles(bundleFiles);
  reference=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await reference.loadFile(path.join(root,'reference/tests/caption-reference.html'));
  for(let i=0;i<100&&!await reference.webContents.executeJavaScript('typeof window.captionReference === "function"');i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(await reference.webContents.executeJavaScript('typeof window.captionReference'),'function');
  for(const [width,height,fps] of [[320,180,30],[320,180,60],[320,180,120],[180,320,120],[640,360,120]]){
    const p=fixture(fps),s=settings(fps,width,height),session=await factory(p,s),group=await session.prepare(p.clips);
    try{for(const frame of [0,1,3,4,9,10,12,13,18,19,30,37,38,50]){
      const actual=await session.frame(group,frame),expected=await reference.webContents.executeJavaScript(`window.captionReference(${JSON.stringify(p)},${JSON.stringify(s)},${JSON.stringify(p.clips)},${frame})`) as Uint8Array;
      const expanded=Buffer.alloc(width*height*4);for(let y=0;y<group.height;y++)Buffer.from(actual.buffer,actual.byteOffset+y*group.width*4,group.width*4).copy(expanded,((group.y+y)*width+group.x)*4);
      if(!expanded.equals(Buffer.from(expected))){let max=0,count=0;const points:unknown[]=[];for(let i=0;i<expanded.length;i++)if(expanded[i]!==expected[i]){max=Math.max(max,Math.abs(expanded[i]-expected[i]));count++;if(points.length<20)points.push({x:Math.floor(i/4)%width,y:Math.floor(i/4/width),channel:i%4,actual:expanded[i],expected:expected[i]});}await fs.writeFile(path.join(root,'pixel-difference.json'),JSON.stringify({width,height,fps,frame,group,max,count,points},null,2));await fs.writeFile(path.join(root,'actual.rgba'),expanded);await fs.writeFile(path.join(root,'expected.rgba'),Buffer.from(expected));}
      assert.ok(expanded.equals(Buffer.from(expected)),`Cropped raster parity ${width}x${height} fps${fps} frame${frame}`);
    }details.push({raster:{width,height,fps,frames:14,bounds:group,rgbaBytesPerFrame:group.width*group.height*4,fullFrameBytes:width*height*4}});}finally{await session.close();}
  }
  checks.push('Cropped hidden-renderer RGBA exactly equals full-canvas shared preview raster at 30/60/120 fps, portrait and scaled output');
  {
    const p=fixture(120),c=p.clips[0];c.start=.1;c.duration=.2;c.keyframes=[];c.captionWords=[];c.captionAnimation=undefined;c.fadeIn=0;c.fadeOut=0;c.animation='none';const s=settings(120),session=await factory(p,s),group=await session.prepare(p.clips);
    for(const [frame,visible] of [[11,false],[12,true],[35,true],[36,false]] as const){const rgba=await session.frame(group,frame);let alpha=0;for(let i=3;i<rgba.length;i+=4)alpha+=rgba[i];assert.equal(alpha>0,visible,`Fractional caption exposure at frame ${frame}`);}await session.close();
  }
  checks.push('Fractional .1 + .2 second clip exposure has exact half-open output-frame boundaries at120 fps');
  {
    const p=fixture(120),original=p.clips[0],halves=splitClip(original,original.start+.307)!;assert.ok(halves);const split={...p,clips:halves},s=settings(120),session=await factory(p,s),whole=await session.prepare([original]),parts=await session.prepare(halves);
    const expanded=async(group:typeof whole,frame:number)=>{const data=await session.frame(group,frame),full=Buffer.alloc(s.width*s.height*4);for(let y=0;y<group.height;y++)Buffer.from(data.buffer,data.byteOffset+y*group.width*4,group.width*4).copy(full,((group.y+y)*s.width+group.x)*4);return full;};
    for(const frame of [1,12,36,37,38,61,180])assert.ok((await expanded(whole,frame)).equals(await expanded(parts,frame)),`Split changed original animation/word clock at ${frame}`);await session.close();
  }
  checks.push('Split rich captions preserve complete sentence, active word and original fade/animation/keyframe state pixel-for-pixel');
  {
    const p=fixture(120),c=p.clips[0];c.duration=.6;c.keyframes[1].time=.6;const s=settings(120),frames=Math.ceil((c.start+c.duration)*120-1e-7),rawPath=path.join(root,'reference.rgba'),raw=await fs.open(rawPath,'w');
    await fs.writeFile(path.join(root,'raw-fixture.json'),JSON.stringify({project:p,settings:s,frames},null,2));
    try{for(let frame=0;frame<frames;frame++){const rgba=await reference.webContents.executeJavaScript(`window.captionReference(${JSON.stringify(p)},${JSON.stringify(s)},${JSON.stringify(p.clips)},${frame})`) as Uint8Array;await raw.write(Buffer.from(rgba));}}finally{await raw.close();}
    const expected=(await runProcess(ctx.ffmpeg,['-v','error','-f','rawvideo','-pixel_format','rgba','-video_size','320x180','-framerate','120','-i',rawPath,'-f','lavfi','-i',`color=c=black:s=320x180:r=120:d=${frames/120}`,'-filter_complex','[1:v]format=rgba[b];[b][0:v]overlay=format=rgb:alpha=straight:shortest=1,scale=out_color_matrix=bt709,format=yuv420p[out]','-map','[out]','-frames:v',String(frames),'-f','rawvideo','pipe:1'],{maxOutputBytes:16*1024*1024})).stdout;
    const actualPath=path.join(root,'actual.yuv');await lifecycle.track(renderProjectDirect(p,s,ctx,undefined,lifecycle.signal,{start:0,duration:frames/120,frames,destination:actualPath}));const actual=await fs.readFile(actualPath);
    assert.ok(actual.equals(expected),'Actual FFmpeg compositing changes exact shared-raster output frames');details.push({rawCompositing:{fps:120,frames,byteIdentical:true}});
  }
  checks.push('Actual FFmpeg window output exactly matches full-canvas preview raster passed through the same RGB/YUV compositing at every frame');
  {
    const p=fixture(30);p.tracks=[{id:'legacy-bottom',name:'Legacy bottom',type:'text',hidden:false,muted:false,locked:false},{id:'rich-middle',name:'Rich middle',type:'text',hidden:false,muted:false,locked:false},{id:'legacy-top',name:'Legacy top',type:'text',hidden:false,muted:false,locked:false}];
    const bottom=newClip('legacy-bottom'),rich=newClip('rich-middle'),top=newClip('legacy-top');for(const c of [bottom,rich,top])Object.assign(c,{start:0,duration:.5,x:0,y:0,animation:'none',fadeIn:0,fadeOut:0});
    Object.assign(bottom,{text:'A',fontSize:80,color:'#ffffff'});Object.assign(top,{text:'B',fontSize:50,color:'#00ff00'});Object.assign(rich,{text:' ',fontSize:80,textBackground:'#ff0000',captionStyle:{...defaultCaptionStyle(),outlineWidth:0,background:'box',paddingX:100,paddingY:20,maxWidth:1}});p.clips=[top,bottom,rich];
    const actualPath=path.join(root,'mixed.yuv');await lifecycle.track(renderProjectDirect(p,settings(30),ctx,undefined,lifecycle.signal,{start:0,duration:.5,frames:15,destination:actualPath}));
    const rgb=(await runProcess(ctx.ffmpeg,['-v','error','-f','rawvideo','-pixel_format','yuv420p','-video_size','320x180','-framerate','30','-i',actualPath,'-vf','scale=in_color_matrix=bt709','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{maxOutputBytes:1024*1024})).stdout;
    let green=0,red=0,white=0;for(let i=0;i<rgb.length;i+=3){if(rgb[i+1]>150&&rgb[i]<100&&rgb[i+2]<100)green++;if(rgb[i]>150&&rgb[i+1]<100&&rgb[i+2]<100)red++;if(rgb[i]>200&&rgb[i+1]>200&&rgb[i+2]>200)white++;}assert.ok(green>100&&red>5000&&white<10,`Legacy/rich stack changed: ${JSON.stringify({green,red,white})}`);details.push({mixedStack:{green,red,white}});
  }
  checks.push('Actual mixed legacy ASS → rich Canvas → legacy ASS overlap order preserves both foreground glyphs and opaque caption boxes');
  for(const fps of [30,60,120]){
    const p=fixture(fps),outputs:Buffer[]=[];
    for(const maxWindowSeconds of [.5,6]){const s={...settings(fps),outputPath:path.join(root,`window-${fps}-${maxWindowSeconds}.mp4`)};await lifecycle.track(renderProject(p,s,{...ctx,maxWindowSeconds},undefined,lifecycle.signal));const raw=(await runProcess(ctx.ffmpeg,['-v','error','-i',s.outputPath,'-pix_fmt','yuv420p','-f','rawvideo','pipe:1'],{maxOutputBytes:32*1024*1024})).stdout;outputs.push(raw);}
    assert.equal(outputs[0].length,Math.ceil(1.603*fps-1e-7)*320*180*1.5);assert.ok(outputs[0].equals(outputs[1]),`Window-dependent rich caption output at ${fps} fps`);
    details.push({windowParity:{fps,frames:outputs[0].length/(320*180*1.5),windows:[.5,6],mismatches:0,sha256:createHash('sha256').update(outputs[0]).digest('hex')}});
  }
  checks.push('Actual encoded caption frames are byte-identical across 0.5/6 second windows at 30/60/120 fps');
  const cancel=new AbortController(),cancelProject=fixture(120);cancelProject.clips[0].duration=60;const cancelOutput=path.join(root,'cancel.mp4');
  await assert.rejects(lifecycle.track(renderProject(cancelProject,{...settings(120,1920,1080),outputPath:cancelOutput},{...ctx,diagnostics:event=>{events.push(event);if(event.event==='caption-stream')setTimeout(()=>cancel.abort(),50);}},undefined,AbortSignal.any([cancel.signal,lifecycle.signal]))),{name:'AbortError'});
  await assert.rejects(fs.access(cancelOutput));assert.equal(BrowserWindow.getAllWindows().length,1);checks.push('Cancellation closes the isolated renderer and all caption streams without publishing output');
  assert.deepEqual(await hashFiles(sourceFiles),sourceHashes,'Caption source changed while testing');assert.deepEqual(await hashFiles(bundleFiles),bundleHashes,'Caption bundle changed while testing');
  reference.destroy();reference=undefined;await fs.writeFile(path.join(root,'results.json'),JSON.stringify({passed:true,version:JSON.parse(await fs.readFile('package.json','utf8')).version,executable:process.execPath,recordedAt:new Date().toISOString(),checks,details,events,sourceHashes,bundleHashes,hostSha256:createHash('sha256').update(await fs.readFile(__filename)).digest('hex')},null,2));await lifecycle.close(0);
}catch(error){await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({error:String(error),stack:error instanceof Error?error.stack:undefined,checks,details,events},null,2));reference?.destroy();await lifecycle.close(1,error);}
})();
