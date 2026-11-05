import test,{before} from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {mediaTimingFromProbe} from '../electron/media-timing';
import {previewClockOffset,toPreviewTime,fromPreviewTime} from '../shared/media-clock';
import {assertMedia} from '../shared/validation';
import {probeMedia,createProxy,runProcess} from '../electron/media';
import {changedProjectSources,refreshProjectSources} from '../electron/project-sources';
import {newClip,newProject} from '../shared/project';
import {prepareClockFixtures} from './fixtures/media-clock';
import {mergeAsset} from '../src/editor';

const root=path.resolve('.test-artifacts/media-clock'),ctx={ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
let fixtures:Awaited<ReturnType<typeof prepareClockFixtures>>;
before(async()=>{fixtures=await prepareClockFixtures(root,ctx);});
const near=(a:number,b:number,e=1e-6)=>assert.ok(Math.abs(a-b)<=e,`${a} differs from ${b}`);
test('Absolute container origins, normalized duration and raw MP3 priming have distinct contracts',()=>{
  for(const [format,duration] of [['mov,mp4,m4a,3gp,3g2,mj2',4],['matroska,webm',6]] as const){const r=mediaTimingFromProbe({format:{format_name:format,start_time:'2',duration:String(duration)},streams:[{codec_type:'video',start_time:'2',duration:'4'}]});assert.deepEqual(r,{duration:4,timing:{version:1,origin:2,previewOffset:2}});}
  const audioTail=mediaTimingFromProbe({format:{format_name:'mov',start_time:'2',duration:'5'},streams:[{codec_type:'video',start_time:'2',duration:'4'},{codec_type:'audio',start_time:'2.5',duration:'4.5'}]});assert.equal(audioTail.duration,5);
  assert.equal(mediaTimingFromProbe({format:{format_name:'mp3',start_time:'.023021',duration:'4'}}).timing.previewOffset,0);
  assert.equal(mediaTimingFromProbe({format:{format_name:'ogg',start_time:'-.0065',duration:'4'}}).timing.previewOffset,0);
  assert.throws(()=>mediaTimingFromProbe({format:{start_time:864001}}));
});
test('Decoder boundary conversion is reversible and normalized proxies never receive the original offset',()=>{
  const media=fixtures.assets.shifted;for(const t of [0,.001,1.25,3.999]){near(toPreviewTime(media,t),t+2);near(fromPreviewTime(media,toPreviewTime(media,t)),t);near(toPreviewTime({...media,proxyPath:'current-color-proxy.mp4'},t,true),t);}
  assert.equal(previewClockOffset({...media,timing:undefined}),0);assert.equal(previewClockOffset(media,true),2);
  assert.equal(toPreviewTime({...media,timing:undefined},.2+.8999999999999999),1.1);
  for(const timing of [{version:2,origin:0,previewOffset:0},{version:1,origin:NaN,previewOffset:0},{version:1,origin:0,previewOffset:-1}])assert.throws(()=>assertMedia({...media,timing}));
  const changed=mergeAsset(media,{sourceRevision:'a'.repeat(64)});assert.equal(changed.timing,undefined);
});
test('Real shifted MKV and MP4 sources preserve four seconds and probe original clocks without decoding all frames',async()=>{
  const {assets}=fixtures;near(assets.shifted.duration,4);near(assets.shifted.timing!.origin,2);near(assets.shifted.timing!.previewOffset,2);
  near(assets.base.duration,4);near(assets.base.timing!.previewOffset,0);assert.ok(assets.mp3.timing!.origin>0);assert.equal(assets.mp3.timing!.previewOffset,0);
  for(const asset of Object.values(assets)){assertMedia(asset);assert.ok(asset.duration>3.9&&asset.duration<4.1);assert.ok(asset.timing);}
  const oldKey=createHash('sha256').update(`media-source-v1|${assets.shifted.sourceRevision}`).digest('hex').slice(0,28);await fs.mkdir(ctx.cacheDir,{recursive:true});await fs.writeFile(path.join(ctx.cacheDir,`${oldKey}.json`),JSON.stringify({...assets.shifted,duration:6,timing:undefined}));
  const reprobed=await probeMedia(assets.shifted.path,ctx,undefined,{derivatives:false});assert.equal(reprobed.duration,4);assert.equal(reprobed.timing!.origin,2);
});
test('Legacy projects refresh clocks without altering source trims, names, valid proxies or source identity',async()=>{
  const media={...fixtures.assets.shifted,name:'User title',timing:undefined,duration:6,proxyPath:'retained-color-proxy.mp4',waveform:[.5]},p=newProject();p.media=[media];p.clips=[{...newClip('video-1',media),in:.25,duration:2}];const snapshot=JSON.stringify(p);
  const changed=await changedProjectSources(p);assert.equal(changed.size,1);const result=await refreshProjectSources(p,changed,ctx);assert.equal(result.changedSources,0);assert.equal(result.detachedTransitions,0);assert.equal(JSON.stringify(p),snapshot);assert.deepEqual(result.project.clips,p.clips);
  const update=result.project.media[0];assert.equal(update.name,'User title');assert.equal(update.proxyPath,media.proxyPath);assert.equal(update.waveform,undefined);assert.equal(update.sourceRevision,media.sourceRevision);assert.equal(update.duration,4);assert.equal(update.timing!.previewOffset,2);assert.equal((await changedProjectSources(result.project)).size,0);
});
test('Actual GPU/CPU proxy generation normalizes the timestamp origin and retains the source timing metadata',{timeout:60000},async()=>{
  const source=fixtures.assets.shifted,proxy=await createProxy(source,ctx);assert.ok(proxy.proxyPath);assert.deepEqual(proxy.timing,source.timing);const actual=await probeMedia(proxy.proxyPath!,ctx,undefined,{derivatives:false});near(actual.timing!.origin,0,.001);near(actual.duration,4,.05);assert.equal(previewClockOffset(proxy,true),0);
  const probe=JSON.parse((await runProcess(ctx.ffprobe,['-v','error','-show_streams','-of','json',proxy.proxyPath!])).stdout.toString());assert.ok(probe.streams.some((s:any)=>s.codec_type==='audio'));await fs.writeFile(path.join(root,'fixtures.json'),JSON.stringify({version:JSON.parse(await fs.readFile('package.json','utf8')).version,...fixtures,proxy},null,2));
});
