import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {freezeFrame,freezeColorFilter} from '../electron/freeze-frame';
import {probeMedia,runProcess} from '../electron/media';
import {prepareClockFixtures} from './fixtures/media-clock';

const root=path.resolve('.test-artifacts/freeze-frame'),ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache'),derivedDir:path.join(root,'derived')};
let fixtures:Awaited<ReturnType<typeof prepareClockFixtures>>;
const ff=(args:string[])=>runProcess(ctx.ffmpeg,['-v','error','-y',...args]);
before(async()=>{fixtures=await prepareClockFixtures(root,ctx);
  for(const [name,args] of [['vfr',['-vf','select=not(eq(mod(n\\,5)\\,2))','-fps_mode','vfr','-c:v','libx264','-crf','0','-c:a','copy']],['tagged',['-c','copy','-bsf:v','h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1']],['sar',['-vf','setsar=2','-c:v','libx264','-crf','0','-c:a','copy']]] as const){const file=path.join(root,`${name}.mkv`);await ff(['-i',fixtures.files.base,...args,file]);fixtures.files[name]=file;fixtures.assets[name]=await probeMedia(file,ctx,undefined,{derivatives:false});}
  const rotated=path.join(root,'rotated.mp4');await ff(['-display_rotation:v:0','90','-i',fixtures.files.mp4,'-c','copy',rotated]);fixtures.files.rotated=rotated;fixtures.assets.rotated=await probeMedia(rotated,ctx,undefined,{derivatives:false});assert.deepEqual([fixtures.assets.rotated.width,fixtures.assets.rotated.height],[90,160]);
  const alpha=path.join(root,'alpha.webm');await ff(['-f','lavfi','-i',"color=red:s=160x90:r=10:d=1,format=rgba,geq=r=255:g=0:b=0:a='if(lt(X,50),0,if(lt(X,100),128,255))'",'-c:v','libvpx-vp9','-lossless','1','-pix_fmt','yuva420p','-auto-alt-ref','0','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709',alpha]);fixtures.files.alpha=alpha;fixtures.assets.alpha=await probeMedia(alpha,ctx,undefined,{derivatives:false});
});
const barcode=(rgba:Buffer,offset=0)=>{let code=0;for(let bit=0;bit<8;bit++){const at=offset+(5*160+bit*20+10)*4;if((rgba[at]+rgba[at+1]+rgba[at+2])/3>128)code|=1<<bit;}return code;};
test('Freeze selects the actual presented frame at subframe boundaries for CFR, VFR and shifted MKV/MP4',{timeout:120000},async()=>{
  const comparisons=[];
  for(const name of ['base','shifted','mp4','mp4-shifted','vfr','tagged']){
    const media=fixtures.assets[name],frames=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',media.path])).stdout.toString()).frames;
    const reference=(await ff(['-i',media.path,'-map','0:v:0','-fps_mode','passthrough','-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout;
    const times=frames.map((f:any)=>Number(f.best_effort_timestamp_time)-media.timing!.origin);
    for(const time of [0,.1999,.2,.29999,.3,1.29999,1.3,2.999,3.999]){
      const image=await freezeFrame(media,time,ctx),pixels=(await ff(['-i',image.path,'-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout;
      const index=Math.max(0,times.findLastIndex((t:number)=>t<=time+1e-7)),expected=barcode(reference,index*160*90*4),actual=barcode(pixels);assert.equal(actual,expected,`${name} at${time}`);assert.equal(image.width,160);assert.equal(image.height,90);comparisons.push({name,time,expected,actual,image});
    }
  }
  await fs.writeFile(path.join(root,'fixtures.json'),JSON.stringify({version:JSON.parse(await fs.readFile('package.json','utf8')).version,...fixtures,comparisons},null,2));
});
test('Freeze preserves display rotation and non-square-pixel geometry at original resolution',async()=>{
  const rotated=await freezeFrame(fixtures.assets.rotated,.7,ctx),sar=await freezeFrame(fixtures.assets.sar,.7,ctx);assert.deepEqual([rotated.width,rotated.height],[90,160]);assert.deepEqual([sar.width,sar.height],[320,90]);
});
test('Transparent WebM freeze retains its alpha plane instead of silently becoming opaque',async()=>{
  const asset=await freezeFrame(fixtures.assets.alpha,.7,ctx),pixels=(await ff(['-i',asset.path,'-pix_fmt','rgba','-f','rawvideo','pipe:1'])).stdout;
  assert.equal(pixels[(45*160+25)*4+3],0);assert.equal(pixels[(45*160+75)*4+3],128);assert.equal(pixels[(45*160+125)*4+3],255);
  const source=(await ff(['-c:v','libvpx-vp9','-i',fixtures.assets.alpha.path,'-frames:v','1','-pix_fmt','yuva420p','-f','rawvideo','pipe:1'])).stdout,reports=[];
  // Independent BT709 limited-range equations, including chroma normalization.
  // Do not imitate the browser's software coefficient approximation.
  for(const x of [25,75,125]){const y=source[45*160+x],u=source[14400+22*80+Math.floor(x/2)],v=source[18000+22*80+Math.floor(x/2)],l=(y-16)*255/219,cb=(u-128)*255/224,cr=(v-128)*255/224;
    const expected=[l+2*(1-.2126)*cr,l-2*.0722*(1-.0722)/.7152*cb-2*.2126*(1-.2126)/.7152*cr,l+2*(1-.0722)*cb].map(value=>Math.max(0,Math.min(255,Math.round(value)))),actual=Array.from(pixels.subarray((45*160+x)*4,(45*160+x)*4+3)),alpha=pixels[(45*160+x)*4+3];
    // Spatial alpha normalization clears invisible RGB at alpha zero; all
    // visible colors still match the independent matrix within one code value.
    if(alpha)assert.ok(actual.every((value,index)=>Math.abs(value-expected[index])<=1));else assert.deepEqual(actual,[0,0,0]);
    reports.push({x,y,u,v,expected,actual,alpha});}
  await fs.writeFile(path.join(root,'alpha-results.json'),JSON.stringify(reports,null,2));
});
test('Freeze rejects invalid ranges, stale source identity and unsupported HDR before publishing',async()=>{
  for(const time of [-1,NaN,Infinity,4])await assert.rejects(freezeFrame(fixtures.assets.base,time,ctx));
  await assert.rejects(freezeFrame({...fixtures.assets.base,sourceRevision:'0'.repeat(64)},.7,ctx),/변경/);
  const controller=new AbortController();controller.abort();await assert.rejects(freezeFrame(fixtures.assets.base,.7,ctx,undefined,controller.signal),{name:'AbortError'});
  assert.throws(()=>freezeColorFilter({index:0,width:1920,height:1080,color_transfer:'smpte2084'}),/HDR/);
  assert.equal((await fs.readdir(ctx.derivedDir)).filter(file=>file.includes('.partial.')).length,0);
});
test('Cancelling active extraction cleans its partial output and never publishes a PNG',async()=>{
  const derivedDir=path.join(root,`cancel-${Date.now()}`),controller=new AbortController();let started!:()=>void;const spawned=new Promise<void>(resolve=>started=resolve);
  const work=freezeFrame(fixtures.assets.base,.7,{...ctx,derivedDir,diagnostics:()=>started()},undefined,controller.signal),rejected=assert.rejects(work,{name:'AbortError'});
  await spawned;controller.abort();await rejected;assert.deepEqual(await fs.readdir(derivedDir),[]);
});
