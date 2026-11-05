import {TrackingStillService} from './tracking-source';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell, Menu, nativeTheme } from 'electron';
import { promises as fs, existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeMedia, enrichMedia, THUMBNAIL_SUFFIX, createProxy, detectEncoders, renderProject, CancelledError, type EngineContext, type ProgressCallback } from './media';
import { installSpeechModel, transcribeMedia, parseSrt, formatSrt, modelReady, SPEECH_MODELS, type ServiceContext } from './services';
import {parseCube,MAX_LUT_BYTES} from '../shared/color';
import { installSpeechEngine,speechCudaReady } from './speech';
import {stabilizeMedia} from './stabilization';
import {reverseMedia,type ReverseOptions} from './reverse';
import {trackMedia} from './tracking';
import {TrackingProcess} from './tracking-process';
import {removePersonBackground} from './matting';
import {MattingProcess} from './matting-process';
import {enhanceMedia,validateEnhancementOptions} from './enhancement';
import {EnhancementProcess} from './enhancement-process';
import {enhancementInstallState,installEnhancementRuntime,verifyEnhancementRuntime} from './enhancement-install';
import {previewProxyPath} from '../shared/media-clock';
import type {EnhancementOptions,PersonCutoutOptions,PreviewStatusEvent} from '../shared/types';
import {TrackingRegistry} from './tracking-registry';
import type {TrackingOptions} from '../shared/tracking';
import {probeVideoRange} from './video-range';
import {readSourceRevision,requireSourceRevision} from './source-revision';
import {changedProjectSources,refreshProjectSources} from './project-sources';
import {AudioPreviewCache} from './audio-preview';
import {freezeFrame} from './freeze-frame';
import type {StabilizationOptions} from '../shared/types';
import {atomicWrite,saveRecovery,listRecoveries,loadRecovery,readProject,serializeProject,ProjectSaveQueue} from './project-store';
import {saveProjectWithAssets,resolveProjectAssets,relocateProjectSources,reconnectTrackingFile} from './project-assets';
import { assertProject, assertMedia } from '../shared/validation';
import { localFilePath, pathKey, insideDirectory, parseByteRange,assertOutputNotSource } from './file-policy';
import type { Project, MediaAsset, JobEvent, JobType, ExportSettings, SubtitleCue, SystemInfo, SpeechOptions,SpeechModelId } from '../shared/types';

app.setName('SLU Studio');
nativeTheme.themeSource='dark';
if(process.env.SLU_USER_DATA)app.setPath('userData',process.env.SLU_USER_DATA);
protocol.registerSchemesAsPrivileged([{scheme:'slu-app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}},{scheme:'slu-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const execute=promisify(execFile);
const resourceRoot=app.isPackaged?process.resourcesPath:path.resolve(__dirname,'../resources');
// Automated UI runs use an isolated profile and keep their window off the user's desktop.
const backgroundTest=process.env.SLU_TEST_BACKGROUND==='1'&&!!process.env.SLU_USER_DATA;
// Mute only the output sink; WebAudio meters and export processing remain active.
// The creation hook also covers caption/manual windows before their first load.
if(backgroundTest)app.on('web-contents-created',(_event,contents)=>contents.setAudioMuted(true));
const docsRoot=app.isPackaged?path.join(process.resourcesPath,'docs'):path.resolve(__dirname,'../docs');
const cacheDir=path.join(app.getPath('userData'),'cache');
const modelDir=path.join(app.getPath('userData'),'models');
const enhancementResources=app.isPackaged?path.join(resourceRoot,'enhancement'):path.resolve(__dirname,'../native/enhancement');
const enhancementInstallation={runtimeBase:path.join(app.getPath('userData'),'enhancement-runtime'),manifestPath:path.join(enhancementResources,'backend-manifest.json')};
const enhancementPreviewRoot=path.join(cacheDir,'enhancement-previews');
const enhancementPreviews=new Map<string,{media:MediaAsset;directory:string}>();
const enhancementPreviewDiscards=new Map<string,Promise<void>>();
const engine:EngineContext={ffmpeg:path.join(resourceRoot,'bin','ffmpeg.exe'),ffprobe:path.join(resourceRoot,'bin','ffprobe.exe'),cacheDir};
const trackingStills=new TrackingStillService(engine);
const audioPreviews=new AudioPreviewCache(engine),mp3PreviewFiles=new Set<string>();
const services:ServiceContext={ffmpeg:engine.ffmpeg,ffprobe:engine.ffprobe,modelDir,cacheDir,whisper:path.join(resourceRoot,'bin','whisper-cpu','Release','whisper-cli.exe')};
const allowedFiles=new Set<string>();
const trackingFiles=new TrackingRegistry();
const mediaExtensions=new Set(['.mp4','.mov','.mkv','.webm','.avi','.m4v','.mts','.m2ts','.ts','.mpeg','.mpg','.wmv','.mp3','.wav','.aac','.m4a','.flac','.ogg','.opus','.aiff','.wma','.png','.jpg','.jpeg','.webp','.bmp','.gif','.tiff','.tif','.avif']);
let win:BrowserWindow|null=null;
let systemPromise:Promise<SystemInfo>|undefined;
let autoSaveQueue:Promise<void>=Promise.resolve();
const manualSaves=new ProjectSaveQueue();
let autoSaveTimer:ReturnType<typeof setTimeout>|undefined;
let autoSaveRevision=0;
const latestAutoSaves=new Map<string,{revision:number;project:Project}>();
const autoSaveWaiters:{revision:number;resolve:()=>void;reject:(error:unknown)=>void}[]=[];
const jobs=new Map<string,{controller:AbortController;type:JobType;done:Promise<void>}>();
const analysisQueue:{media:MediaAsset;attemptId?:string}[]=[];
const analysisControllers=new Set<AbortController>();
function previewStatus(event:PreviewStatusEvent){if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('media:preview-status',event);}
function beginPreviewPreparation(media:MediaAsset){
  const attemptId=randomUUID();
  previewStatus({media:{id:media.id,path:media.path,sourceRevision:media.sourceRevision},attemptId,status:'preparing'});
  return attemptId;
}
function failPreviewPreparation(media:MediaAsset,attemptId:string,error:unknown){
  const detail=error instanceof CancelledError?'준비를 취소했습니다.':String(error instanceof Error?error.message:error);
  previewStatus({media:{id:media.id,path:media.path,sourceRevision:media.sourceRevision},attemptId,status:'failed',message:`${media.name}: 미리보기 파일 준비 실패 · ${detail}`});
}
function queueAnalysis(media:MediaAsset){
  const thumbnailReady=media.thumbnail?.toLowerCase().endsWith(THUMBNAIL_SUFFIX),needsProxy=media.codec?.toLowerCase()==='ffv1'&&(!previewProxyPath(media)||!existsSync(previewProxyPath(media)!));
  if(!needsProxy&&(media.kind==='audio'||thumbnailReady)&&(!media.hasAudio||media.waveform?.length))return;
  analysisQueue.push({media,attemptId:needsProxy?beginPreviewPreparation(media):undefined});
  setTimeout(pumpAnalysis,200);
}
function pumpAnalysis(){
  if(!win||win.isDestroyed()||[...jobs.values()].some(job=>job.type==='export')){if(win&&analysisQueue.length)setTimeout(pumpAnalysis,1000);return;}
  while(analysisControllers.size<2&&analysisQueue.length){
    const {media,attemptId}=analysisQueue.shift()!,controller=new AbortController();
    analysisControllers.add(controller);
    void enrichMedia(media,engine,controller.signal).then(async result=>{
      if(result.codec?.toLowerCase()==='ffv1'&&(!previewProxyPath(result)||!existsSync(previewProxyPath(result)!)))result=await createProxy(result,engine,undefined,controller.signal);
      if(controller.signal.aborted)return;
      await requireSourceRevision(result.path,result.sourceRevision);
      register(result);
      if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('media:updated',result);
    }).catch(error=>{
      if(controller.signal.aborted)return;
      if(attemptId)failPreviewPreparation(media,attemptId,error);
      else if(media.codec?.toLowerCase()==='ffv1'&&win&&!win.isDestroyed())win.webContents.send('project:warning',`미디어 분석 실패 · ${String(error instanceof Error?error.message:error)}`);
    }).finally(()=>{analysisControllers.delete(controller);pumpAnalysis();});
  }
}
const key=pathKey;
function allow(p?:string){if(p)allowedFiles.add(key(p));}
function register(m:MediaAsset){allow(m.path);allow(m.thumbnail);allow(m.proxyPath);if(m.kind==='audio'&&m.codec==='mp3'&&path.extname(m.path).toLowerCase()==='.mp3')mp3PreviewFiles.add(key(m.path));else mp3PreviewFiles.delete(key(m.path));return m;}
function checkMedia(m:MediaAsset){assertMedia(m);if(!localFilePath(m.path)||!allowedFiles.has(key(m.path)))throw new Error('먼저 미디어 파일을 가져오세요.');}
/** FFV1 is an editing intermediate, not a Chromium playback codec. Publish a
 * processed clip only after its required representation is ready, so applying
 * reverse/stabilization never briefly installs an undecodable source. */
async function playableDerived(media:MediaAsset,signal:AbortSignal,progress:ProgressCallback,create:(ctx:EngineContext&{derivedDir:string},progress:ProgressCallback)=>Promise<MediaAsset>):Promise<MediaAsset>{
  const revision=await requireSourceRevision(media.path,media.sourceRevision),derivedDir=path.join(app.getPath('userData'),'media-derived');let result:MediaAsset|undefined,complete=false;
  try{
    result=await create({...engine,derivedDir},(p,m)=>progress(p*.9,m));
    if(result.codec?.toLowerCase()==='ffv1')result=await createProxy(result,engine,p=>progress(.9+.1*p,'투명 영상 미리보기 준비 중'),signal);
    if(signal.aborted)throw new CancelledError();await requireSourceRevision(media.path,revision);await requireSourceRevision(result.path,result.sourceRevision);
    register(result);queueAnalysis(result);complete=true;return result;
  }finally{
    if(!complete&&result&&insideDirectory(path.resolve(result.path),path.resolve(derivedDir))&&/-(?:stabilized|reverse)-[a-f0-9-]{36}\.(?:mov|wav)$/i.test(path.basename(result.path)))await fs.unlink(result.path).catch(()=>{});
  }
}
function emit(e:JobEvent){if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed()){try{win.webContents.send('job:progress',e);}catch{/* The renderer may close between the two checks. */}}}
function startJob(type:JobType,task:(signal:AbortSignal,progress:(p:number,message?:string)=>void)=>Promise<Partial<JobEvent>>,metadata:Pick<JobEvent,'preview'>={}):string{
  if(jobs.size>=4)throw new Error('최대 4개 작업까지 동시에 실행할 수 있습니다. 진행 중인 작업을 기다려 주세요.');
  if(type==='export'&&[...jobs.values()].some(j=>j.type==='export'))throw new Error('내보내기가 진행 중입니다. 완료 후 다시 시도하세요.');
  if(type==='model'&&[...jobs.values()].some(j=>j.type==='model'))throw new Error('음성 모델을 설치 중입니다.');
  if((type==='enhance'||type==='enhancement-install')&&[...jobs.values()].some(j=>j.type==='enhance'||j.type==='enhancement-install'))throw new Error('AI 화질 향상 작업이 진행 중입니다. 완료하거나 취소한 뒤 다시 시도하세요.');
  const id=randomUUID(),controller=new AbortController();let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});jobs.set(id,{controller,type,done});
  setTimeout(async()=>{
    const progress=(p:number,message='처리 중')=>emit({id,type,status:'running',progress:Number.isFinite(p)?Math.max(0,Math.min(1,p)):0,message,...metadata});
    try{if(controller.signal.aborted)throw new CancelledError();progress(0,'작업 준비 중');const result=await task(controller.signal,progress);emit({id,type,status:'complete',progress:1,message:'완료',...result,...metadata});}
    catch(e){emit({id,type,status:controller.signal.aborted?'cancelled':'error',progress:0,message:controller.signal.aborted?'작업을 취소했습니다.':(e instanceof Error?e.message:String(e)),...metadata});}
    finally{jobs.delete(id);finish();}
  },80);
  return id;
}
async function enhancementDeviceSupported():Promise<boolean>{
  try{return !!(await execute('nvidia-smi',['--query-gpu=name','--format=csv,noheader'],{windowsHide:true,timeout:10000})).stdout.trim();}
  catch{return false;}
}
async function removeEnhancementDirectory(directory:string,root:string){
  const stat=await fs.lstat(directory).catch(()=>undefined);
  if(!stat||!stat.isDirectory()||stat.isSymbolicLink())return;
  const [canonical,parent]=await Promise.all([fs.realpath(directory),fs.realpath(root)]);
  if(insideDirectory(canonical,parent))await fs.rm(canonical,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
async function discardEnhancementPreview(id:string){
  const pending=enhancementPreviewDiscards.get(id);
  if(pending)return pending;
  const record=enhancementPreviews.get(id);
  if(!record)return;
  for(const file of [record.media.path,record.media.proxyPath,record.media.thumbnail])if(file)allowedFiles.delete(key(file));
  const cleanup=removeEnhancementDirectory(record.directory,enhancementPreviewRoot).then(()=>{enhancementPreviews.delete(id);});
  enhancementPreviewDiscards.set(id,cleanup);
  try{await cleanup;}finally{enhancementPreviewDiscards.delete(id);}
}
async function prepareEnhancedMedia(media:MediaAsset,options:EnhancementOptions,signal:AbortSignal,progress:ProgressCallback):Promise<MediaAsset>{
  const revision=await requireSourceRevision(media.path,media.sourceRevision);
  progress(0,'AI 엔진 확인 중');
  const runtime=await verifyEnhancementRuntime(enhancementInstallation,signal).catch(error=>{
    if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Error('AI 엔진을 먼저 설치하세요.');
    throw error;
  });
  const cacheRoot=options.preview?enhancementPreviewRoot:path.join(cacheDir,'enhancement-proxies');
  await fs.mkdir(cacheRoot,{recursive:true});
  const directory=await fs.mkdtemp(path.join(cacheRoot,'job-'));
  const derivedDir=options.preview?directory:path.join(app.getPath('userData'),'media-derived');
  let result:MediaAsset|undefined,complete=false;
  try{
    result=await enhanceMedia(media,options,{
      ...engine,cacheDir:directory,derivedDir,
      createEnhancement:(config,signal,progress)=>EnhancementProcess.create({
        ...config,...runtime,signal,progress,workerPath:path.join(enhancementResources,'seedvr_worker.py'),
      }),
    },(p,m)=>progress(p*.95,m),signal);
    result=await createProxy(result,{...engine,cacheDir:directory},p=>progress(.95+.05*p,'결과 미리보기 준비 중'),signal);
    if(signal.aborted)throw new CancelledError();
    await requireSourceRevision(media.path,revision);await requireSourceRevision(result.path,result.sourceRevision);
    if(signal.aborted)throw new CancelledError();
    register(result);
    if(options.preview)enhancementPreviews.set(result.id,{media:result,directory});
    else queueAnalysis(result);
    complete=true;return result;
  }finally{
    if(!complete){
      if(result&&!options.preview&&insideDirectory(result.path,derivedDir)&&/^enhanced-[a-f0-9-]{36}\.mov$/i.test(path.basename(result.path)))await fs.unlink(result.path).catch(()=>{});
      await removeEnhancementDirectory(directory,cacheRoot).catch(()=>{});
    }
  }
}
function flushAutosave():Promise<void>{
  if(autoSaveTimer){clearTimeout(autoSaveTimer);autoSaveTimer=undefined;}
  const snapshots=[...latestAutoSaves.values()].sort((a,b)=>a.revision-b.revision);if(!snapshots.length)return autoSaveQueue;
  latestAutoSaves.clear();const revision=snapshots[snapshots.length-1].revision;
  autoSaveQueue=autoSaveQueue.catch(()=>{}).then(async()=>{
    let failure:unknown;
    for(const snapshot of snapshots){try{await saveRecovery(app.getPath('userData'),snapshot.project);}catch(error){failure=error;}}
    for(let i=autoSaveWaiters.length-1;i>=0;i--){const waiter=autoSaveWaiters[i];if(waiter.revision<=revision){autoSaveWaiters.splice(i,1);if(failure)waiter.reject(failure);else waiter.resolve();}}
    if(failure)throw failure;
  });
  return autoSaveQueue;
}
function queueAutosave(project:Project):Promise<void>{
  assertProject(project);for(const media of project.media)checkMedia(media);trackingFiles.approveProject(project);
  const revision=++autoSaveRevision;latestAutoSaves.set(project.id,{revision,project:structuredClone(project)});
  if(autoSaveTimer)clearTimeout(autoSaveTimer);
  autoSaveTimer=setTimeout(()=>{void flushAutosave().catch(()=>{});},600);
  return new Promise((resolve,reject)=>autoSaveWaiters.push({revision,resolve,reject}));
}
async function prepareProject(project:Project,pathsApproved=false){
  assertProject(project);
  for(const m of project.media){
    if(!localFilePath(m.path)||!mediaExtensions.has(path.extname(m.path).toLowerCase()))throw new Error('지원하지 않는 로컬 미디어 파일 경로 또는 형식입니다.');
    if(!pathsApproved&&!allowedFiles.has(key(m.path)))throw new Error('프로젝트의 미디어 파일을 먼저 가져와 주세요.');
    if(m.thumbnail&&(!insideDirectory(m.thumbnail,cacheDir)||!existsSync(m.thumbnail)))delete m.thumbnail;
    if(m.proxyPath&&(!insideDirectory(m.proxyPath,cacheDir)||!existsSync(m.proxyPath)))delete m.proxyPath;
    register(m);
  }
  trackingFiles.approveProject(project,pathsApproved);return pathsApproved?refreshChangedProject(project,await changedProjectSources(project)):project;
}
async function prepareRecoveredProject(project:Project):Promise<Project>{
  const prepared=await prepareProject(project,true);
  for(const media of prepared.media){
    if(existsSync(media.path))queueAnalysis(media);
  }
  return prepared;
}
async function refreshChangedProject(project:Project,changed:ReadonlySet<string>):Promise<Project>{
  if(!changed.size)return project;
  const result=await new Promise<Awaited<ReturnType<typeof refreshProjectSources>>>((resolve,reject)=>{
    startJob('range',async(signal,progress)=>{try{const result=await refreshProjectSources(project,changed,engine,progress,signal);resolve(result);return {message:'프로젝트 원본 확인 완료'};}catch(error){reject(error);throw error;}});
  });
  for(const media of result.project.media)register(media);
  const message=`원본 미디어 ${result.changedSources}개 정보를 다시 확인했습니다.${result.detachedTransitions?` 실제 영상 구간이 부족한 전환 ${result.detachedTransitions}개를 해제했습니다.`:''} 저장된 프로젝트 파일은 변경하지 않았습니다.`;
  if((result.changedSources||result.detachedTransitions)&&win&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('project:warning',message);
  return result.project;
}
function handler(name:string,fn:(...args:any[])=>unknown){ipcMain.handle(name,(event,...args)=>{
  const url=event.senderFrame?.url||'';
  if(event.sender!==win?.webContents||event.senderFrame!==win?.webContents.mainFrame||!(url.startsWith('slu-app://studio/')||(!app.isPackaged&&url.startsWith('http://127.0.0.1:5173/'))))throw new Error('허용되지 않은 요청입니다.');
  return fn(...args);
});}
async function getSystemInfo():Promise<SystemInfo>{
  if(!systemPromise)systemPromise=(async()=>{
    let gpu='하드웨어 정보 확인 불가',ffmpegVersion='사용 불가';
    try{const info=await app.getGPUInfo('basic') as any;gpu=(info.gpuDevice||[]).map((g:any)=>g.deviceString||g.deviceId?.toString(16)).filter(Boolean).join(' · ')||gpu;}catch{}
    try{const r=await execute('nvidia-smi',['--query-gpu=name','--format=csv,noheader'],{windowsHide:true,timeout:10000});gpu=r.stdout.trim()||gpu;}catch{}
    try{const r=await execute(engine.ffmpeg,['-version'],{windowsHide:true,timeout:10000});ffmpegVersion=r.stdout.split('\n')[0].trim();}catch{}
    const encoders=await detectEncoders(engine).catch(()=>['libx264']);
    return {version:app.getVersion(),ffmpegVersion,gpu,encoders,hardwareAcceleration:app.getGPUFeatureStatus().gpu_compositing==='enabled',modelReady:await modelReady(services),modelDirectory:modelDir,cacheDirectory:cacheDir};
  })();
  const result=await systemPromise;return {...result,modelReady:await modelReady(services),speechCuda:await speechCudaReady(services),speechModels:await Promise.all((Object.keys(SPEECH_MODELS) as SpeechModelId[]).map(async id=>({id,name:SPEECH_MODELS[id].name,bytes:SPEECH_MODELS[id].bytes,installed:await modelReady(services,id)})))};
}
async function chooseSave(defaultPath:string,extensions:string[]){if(!win)return null;const r=await dialog.showSaveDialog(win,{defaultPath,filters:[{name:extensions.join(', ').toUpperCase(),extensions}],properties:['createDirectory','showOverwriteConfirmation']});return r.canceled?null:r.filePath||null;}
function setupIPC(){
  handler('system:info',getSystemInfo);
  handler('enhancement:info',async()=>{
    const [state,deviceSupported]=await Promise.all([enhancementInstallState(enhancementInstallation),enhancementDeviceSupported()]);
    return {installed:state.installed,downloadBytes:state.downloadBytes,model:state.model,deviceSupported,...(!deviceSupported?{message:'AI 화질 향상에는 NVIDIA GPU와 CUDA 드라이버가 필요합니다.'}:{})};
  });
  handler('enhancement:install',async()=>({jobId:startJob('enhancement-install',async(signal,progress)=>{
    await installEnhancementRuntime(enhancementInstallation,progress,signal);return {message:'화질 향상 엔진 설치 완료'};
  })}));
  handler('media:enhance',async(media:MediaAsset,options:EnhancementOptions)=>{
    checkMedia(media);validateEnhancementOptions(options);
    const snapshot={...options};
    return {jobId:startJob('enhance',async(signal,progress)=>{
      const result=await prepareEnhancedMedia(media,snapshot,signal,progress);
      return {media:result,path:result.path,message:snapshot.preview?'비교 준비 완료':'AI 화질 향상 완료'};
    },{preview:!!snapshot.preview})};
  });
  handler('enhancement:discard-preview',async(id:string)=>{if(typeof id!=='string')throw new Error('잘못된 미리보기 요청입니다.');await discardEnhancementPreview(id);});
  handler('color:import-lut',async()=>{
    const result=await dialog.showOpenDialog(win!,{title:'3D LUT 가져오기',properties:['openFile'],filters:[{name:'3D LUT',extensions:['cube']}]});if(result.canceled)return null;
    const file=result.filePaths[0];if(!localFilePath(file)||path.extname(file).toLowerCase()!=='.cube')throw new Error('로컬 .cube 파일을 선택하세요.');
    const handle=await fs.open(file,'r');try{const info=await handle.stat();if(!info.isFile()||info.size>MAX_LUT_BYTES)throw new Error('LUT 파일은 16MiB 이하여야 합니다.');const buffer=Buffer.alloc(info.size+1);let offset=0;while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}if(offset!==info.size)throw new Error('LUT 파일을 읽는 중 크기가 바뀌었습니다.');const lut=parseCube(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,offset)),path.basename(file,'.cube'));return {...lut,id:createHash('sha256').update(JSON.stringify(lut)).digest('hex')};}finally{await handle.close();}
  });
  handler('system:help',async()=>{const result=await shell.openPath(path.join(docsRoot,'사용설명서.html'));if(result)throw new Error(result);});
  handler('system:reveal',async(file:string)=>{if(typeof file!=='string'||(!allowedFiles.has(key(file))&&!trackingFiles.has(key(file))))throw new Error('알 수 없는 파일입니다.');shell.showItemInFolder(file);});
  handler('media:import',async(files?:string[])=>{
    if(!files){const result=await dialog.showOpenDialog(win!,{title:'영상 · 오디오 · 이미지 가져오기',properties:['openFile','multiSelections'],filters:[{name:'미디어 파일',extensions:[...mediaExtensions].map(e=>e.slice(1))}]});if(result.canceled)return [];files=result.filePaths;}
    if(!Array.isArray(files)||files.length>100)throw new Error('한 번에 100개 이하의 파일을 가져와 주세요.');
    const assetsByIndex:(MediaAsset|undefined)[]=[],errors:string[]=[],seen=new Set<string>();let cursor=0;
    await Promise.all(Array.from({length:Math.min(3,files.length)},async()=>{while(cursor<files!.length){const index=cursor++,file=files![index];try{if(!localFilePath(file)||!mediaExtensions.has(path.extname(file).toLowerCase()))throw new Error('지원하지 않는 파일 형식');const canonical=await fs.realpath(file);if(!localFilePath(canonical))throw new Error('로컬 파일만 가져올 수 있습니다.');if(seen.has(key(canonical)))continue;seen.add(key(canonical));assetsByIndex[index]=register(await probeMedia(canonical,engine,undefined,{derivatives:false}));}catch(e){errors.push(`${typeof file==='string'?path.basename(file):'알 수 없는 파일'}: ${e instanceof Error?e.message:String(e)}`);}}}));
    const assets=assetsByIndex.filter((m):m is MediaAsset=>!!m);for(const media of assets)queueAnalysis(media);
    if(errors.length){if(!assets.length)throw new Error(errors.join('\n'));await dialog.showMessageBox(win!,{type:'warning',message:'일부 파일을 가져오지 못했습니다.',detail:errors.join('\n')});}
    return assets;
  });
  handler('project:save',(project:Project,file?:string,saveAs?:boolean)=>manualSaves.run(async()=>{
    await prepareProject(project);
    if(file!==undefined&&(!localFilePath(file)||!allowedFiles.has(key(file))))throw new Error('열거나 저장한 프로젝트 경로만 다시 저장할 수 있습니다. 다른 이름으로 저장을 사용해 주세요.');
    if(!file||saveAs)file=await chooseSave(`${project.name.replace(/[<>:"/\\|?*]/g,'_')}.sluproj`,['sluproj'])||undefined;
    if(!file)return null;if(path.extname(file).toLowerCase()!=='.sluproj')file+='.sluproj';
    await assertOutputNotSource(file,[...project.media.map(m=>m.path),...(project.motionPaths||[]).map(a=>a.path)]);
    await saveProjectWithAssets(project,file,{registry:trackingFiles,warning:message=>{if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('project:warning',message);}});allow(file);return file;
  }));
  handler('project:collect',(project:Project)=>new Promise<{jobId:string;path:string}|null>((resolve,reject)=>{
    // Hold the same queue as ordinary saves until copying AND publication have
    // finished. The response exposes cancellation while the queue stays held.
    void manualSaves.run(async()=>{
      await prepareProject(project);
      let file=await chooseSave(`${project.name.replace(/[<>:"/\\|?*]/g,'_')}.sluproj`,['sluproj']);if(!file){resolve(null);return;}
      if(path.extname(file).toLowerCase()!=='.sluproj')file+='.sluproj';const destination=file;
      await assertOutputNotSource(destination,[...project.media.map(m=>m.path),...(project.motionPaths||[]).map(a=>a.path)]);
      const jobId=startJob('collect',async(signal,progress)=>{await saveProjectWithAssets(project,destination,{collect:true,registry:trackingFiles,signal,progress});allow(destination);return {path:destination,message:'프로젝트와 원본 파일을 모아 저장했습니다.'};});
      resolve({jobId,path:destination});await jobs.get(jobId)!.done;
    }).catch(reject);
  }));
  handler('project:open',async()=>{
    const r=await dialog.showOpenDialog(win!,{filters:[{name:'SLU Studio 프로젝트',extensions:['sluproj']}],properties:['openFile']});if(r.canceled)return null;
    const file=r.filePaths[0],stat=await fs.stat(file);if(stat.size>50*1024*1024)throw new Error('프로젝트 파일이 너무 큽니다.');
    const saved=await readProject(file),serialized=JSON.stringify(saved);let project=await prepareProject(await resolveProjectAssets(saved,file,path.join(app.getPath('userData'),'tracking-derived')),true);const relinked=new Set<string>();
    const reconnect=async(id:string,replacement:string)=>{
      const candidate=await relocateProjectSources(project,new Map([[id,replacement]]),path.join(app.getPath('userData'),'tracking-derived'));
      const index=candidate.media.findIndex(m=>m.id===id),media=candidate.media[index];
      if(media.sourceRevision!==await readSourceRevision(replacement)){const refreshed=await probeMedia(replacement,engine,undefined,{derivatives:false});candidate.media[index]=register({...refreshed,id});relinked.add(replacement);}else register(media);project=candidate;
    };
    for(let i=0;i<project.media.length;i++){const m=project.media[i];if(!existsSync(m.path)){
      const replacement=path.join(path.dirname(file),path.basename(m.path));if(existsSync(replacement)){try{await reconnect(m.id,replacement);continue;}catch{/* Offer manual relinking when the nearby file is not valid media. */}}
      const choice=await dialog.showMessageBox(win!,{type:'warning',message:`원본 파일을 찾을 수 없습니다: ${m.name}`,detail:m.path,buttons:['파일 다시 연결','건너뛰기'],defaultId:0,cancelId:1});
      if(choice.response===0){const pick=await dialog.showOpenDialog(win!,{title:`${m.name} 다시 연결`,properties:['openFile'],filters:[{name:'미디어',extensions:[...mediaExtensions].map(e=>e.slice(1))}]});if(!pick.canceled)await reconnect(m.id,pick.filePaths[0]);}
    }else{if(m.proxyPath&&!existsSync(m.proxyPath))delete m.proxyPath;if(m.thumbnail&&!existsSync(m.thumbnail))delete m.thumbnail;register(m);}}
    project=await refreshChangedProject(project,relinked);trackingFiles.approveProject(project,true);for(const media of project.media)if(existsSync(media.path))queueAnalysis(media);
    allow(file);return {project,path:file,missing:project.media.filter(m=>!existsSync(m.path)).map(m=>m.path),modified:JSON.stringify(project)!==serialized};
  });
  handler('project:autosave',queueAutosave);
  handler('project:recoveries',async()=>{await flushAutosave();return listRecoveries(app.getPath('userData'));});
  handler('project:load-recovery',async(id:string)=>{
    await flushAutosave();
    const project=await loadRecovery(app.getPath('userData'),id);
    return project?prepareRecoveredProject(project):null;
  });
  handler('project:recover',async()=>{
    try{
      const file=path.join(app.getPath('userData'),'recovery.sluproj');
      if((await fs.stat(file)).size>50*1024*1024)return null;
      return await prepareRecoveredProject(JSON.parse(await fs.readFile(file,'utf8')));
    }catch{return null;}
  });
  handler('project:export',async(project:Project,settings:ExportSettings)=>{
    await prepareProject(project);if(!project.clips.length)throw new Error('타임라인에 클립을 추가해 주세요.');
    if(!settings||!['mp4','webm','gif','wav'].includes(settings.format))throw new Error('지원하지 않는 출력 형식');
    const output=await chooseSave(`${project.name.replace(/[<>:"/\\|?*]/g,'_')}.${settings.format}`,[settings.format]);if(!output)return null;
    const finalPath=path.extname(output).toLowerCase()===`.${settings.format}`?output:`${output}.${settings.format}`;
    await assertOutputNotSource(finalPath,[...project.media.map(m=>m.path),...(project.motionPaths||[]).map(a=>a.path)]);
    const jobId=startJob('export',async(signal,progress)=>{const result=await renderProject(project,{...settings,outputPath:finalPath},engine,progress,signal);allow(result);return {path:result,message:'내보내기가 완료되었습니다.'};});return {jobId,path:finalPath};
  });
  handler('job:cancel',async(id:string)=>{jobs.get(id)?.controller.abort();});
  handler('media:proxy',async(media:MediaAsset)=>{
    checkMedia(media);
    return {jobId:startJob('proxy',async(signal,progress)=>{
      const attemptId=media.codec?.toLowerCase()==='ffv1'?beginPreviewPreparation(media):undefined;
      try{
        const result=await createProxy(media,engine,progress,signal);
        if(await readSourceRevision(result.path)!==result.sourceRevision)throw new Error('프록시 생성 후 원본 파일이 변경되었습니다. 다시 가져와 주세요.');
        register(result);
        return {media:result,path:result.proxyPath,message:'프록시 생성 완료. 미리보기에 자동 적용됩니다.'};
      }catch(error){if(attemptId)failPreviewPreparation(media,attemptId,error);throw error;}
    })};
  });
  handler('media:cutout',async(media:MediaAsset,options:PersonCutoutOptions)=>{checkMedia(media);return {jobId:startJob('cutout',async(signal,progress)=>{
    const revision=await requireSourceRevision(media.path,media.sourceRevision),derivedDir=path.join(app.getPath('userData'),'media-derived');let result:MediaAsset|undefined,complete=false;
    try{
      result=await removePersonBackground(media,options,{...engine,derivedDir,createMatting:(config,signal)=>MattingProcess.create({...config,signal,modelPath:path.join(resourceRoot,'models',config.quality==='precision'?'person-matting-rvm-resnet50.onnx':'person-matting-rvm.onnx')})},(p,m)=>progress(p*.9,m),signal);
      result=await createProxy(result,engine,(p)=>progress(.9+.1*p,'투명 영상 미리보기 준비 중'),signal);
      if(signal.aborted)throw new CancelledError();await requireSourceRevision(media.path,revision);await requireSourceRevision(result.path,result.sourceRevision);
      register(result);queueAnalysis(result);complete=true;return {media:result,path:result.path,message:'배경 제거 완료'};
    }finally{if(!complete&&result&&insideDirectory(path.resolve(result.path),path.resolve(derivedDir))&&path.basename(result.path).startsWith('cutout-'))await fs.unlink(result.path).catch(()=>{});}
  })};});
  handler('media:stabilize',async(media:MediaAsset,options:StabilizationOptions)=>{checkMedia(media);return {jobId:startJob('stabilize',async(signal,progress)=>{const result=await playableDerived(media,signal,progress,(ctx,p)=>stabilizeMedia(media,options,ctx,p,signal));return {media:result,path:result.path,message:'흔들림 보정 완료'};})};});
  handler('media:freeze',async(media:MediaAsset,time:number)=>{checkMedia(media);return {jobId:startJob('freeze',async(signal,progress)=>{const result=await freezeFrame(media,time,{...engine,derivedDir:path.join(app.getPath('userData'),'media-derived')},progress,signal);register(result);queueAnalysis(result);return {media:result,path:result.path,message:'정지 프레임 준비 완료'};})};});
  handler('media:reverse',async(media:MediaAsset,options:ReverseOptions)=>{checkMedia(media);return {jobId:startJob('reverse',async(signal,progress)=>{const result=await playableDerived(media,signal,progress,(ctx,p)=>reverseMedia(media,options,ctx,p,signal));return {media:result,path:result.path,message:'역재생 완료'};})};});
  handler('media:track',async(media:MediaAsset,options:TrackingOptions)=>{checkMedia(media);return {jobId:startJob('track',async(signal,progress)=>{
    const revision=await requireSourceRevision(media.path,media.sourceRevision),tracking=await trackMedia(media,options,{...engine,derivedDir:path.join(app.getPath('userData'),'tracking-derived'),createTracker:(backend,signal)=>TrackingProcess.create({modelPath:path.join(resourceRoot,'models','object-tracking-vit.onnx'),backend,signal})},progress,signal);
    try{
      await requireSourceRevision(media.path,revision);await trackingFiles.register(tracking,media.path,signal);if(signal.aborted)throw new CancelledError();
      return {tracking,path:tracking.path,message:'객체 추적 완료'};
    }catch(error){trackingFiles.forget(tracking.path);if(insideDirectory(tracking.path,path.join(app.getPath('userData'),'tracking-derived')))await fs.rm(tracking.path,{force:true}).catch(()=>{});throw error;}
  })};});
  handler('tracking:still',(id:string,media:MediaAsset,time:number,maxDimension=1280)=>{checkMedia(media);return trackingStills.request(id,media,time,maxDimension);});
  handler('tracking:cancel-still',(id:string)=>trackingStills.cancel(id));
  handler('tracking:read',(file:string,time:number,limit=256)=>trackingFiles.read(file,time,limit));
  handler('tracking:reconnect',async(project:Project,id:string)=>{
    await prepareProject(project);const analysis=project.motionPaths?.find(a=>a.id===id);if(!analysis)throw new Error('추적 경로가 프로젝트에 없습니다.');
    const expected=trackingFiles.referenceFor(analysis);
    if(!expected)throw new Error('이 프로젝트에는 추적 파일 확인 정보가 없습니다. 원본 영상에서 다시 분석하세요.');
    // Pin trusted identity before the dialog/async job; opening another project
    // while it runs must not replace this operation's source/hash proof.
    const snapshot=structuredClone(project);snapshot.fileReferences=[...(snapshot.fileReferences||[]).filter(r=>r.kind!=='tracking'||r.id!==id),structuredClone(expected)];
    const pick=await dialog.showOpenDialog(win!,{title:'추적 파일 다시 연결',properties:['openFile'],filters:[{name:'SLU 추적 파일',extensions:['slutrack']}]});if(pick.canceled)return null;
    return {jobId:startJob('relink',async(signal,progress)=>{
      const result=await reconnectTrackingFile(snapshot,id,pick.filePaths[0],path.join(app.getPath('userData'),'tracking-derived'),{signal,progress});
      trackingFiles.approveProject({...snapshot,motionPaths:[result.analysis],fileReferences:[result.reference]},true);allow(result.analysis.path);
      return {trackingReconnect:result,path:result.analysis.path,message:'추적 파일을 다시 연결했습니다.'};
    })};
  });
  handler('media:video-range',async(media:MediaAsset)=>{
    checkMedia(media);
    return new Promise<MediaAsset>((resolve,reject)=>{
      startJob('range',async(signal,progress)=>{
        try{
          const before=await readSourceRevision(media.path),source=await probeMedia(media.path,engine,signal,{derivatives:false});
          if(source.kind!=='video')throw new Error('영상 파일의 프레임 범위만 분석할 수 있습니다.');
          const range=await probeVideoRange(media.path,engine,signal,{progress});
          if(!range)throw new Error('실제 영상의 마지막 프레임 시각을 확인할 수 없어 전환 핸들을 사용할 수 없습니다.');
          const after=await readSourceRevision(media.path);
          if(signal.aborted)throw new CancelledError();
          if(before!==after||source.sourceRevision!==after)throw new Error('분석 중 원본 파일이 변경되었습니다. 다시 확인해 주세요.');
          const result=register({...source,id:media.id,...range,duration:Math.max(source.duration,range.videoEnd)});
          resolve(result);return {media:result,message:'영상 프레임 범위 확인 완료'};
        }catch(error){reject(error);throw error;}
      });
    });
  });
  handler('model:install',async(model:SpeechModelId='base')=>({jobId:startJob('model',async(signal,progress)=>{await installSpeechModel(services,progress,signal,model);return {message:'음성 모델 설치 완료'};})}));
  handler('speech:install',async()=>({jobId:startJob('model',async(signal,progress)=>{await installSpeechEngine(services,progress,signal);return {message:'CUDA 음성 엔진 설치 완료'};})}));
  handler('media:transcribe',async(media:MediaAsset,language:string,options:SpeechOptions={})=>{checkMedia(media);if(!media.hasAudio&&media.kind!=='audio')throw new Error('오디오가 없는 미디어입니다.');return {jobId:startJob('transcribe',async(signal,progress)=>{const revision=await requireSourceRevision(media.path,media.sourceRevision),cues=await transcribeMedia(media,language,services,progress,signal,options);await requireSourceRevision(media.path,revision);return {cues,message:'자막 생성 완료'};})};});
  handler('subtitles:import',async()=>{const r=await dialog.showOpenDialog(win!,{title:'자막 가져오기',filters:[{name:'자막',extensions:['srt','vtt']}],properties:['openFile']});if(r.canceled)return null;const stat=await fs.stat(r.filePaths[0]);if(stat.size>10*1024*1024)throw new Error('자막 파일이 너무 큽니다.');return parseSrt(await fs.readFile(r.filePaths[0],'utf8'));});
  handler('subtitles:export',async(cues:SubtitleCue[])=>{if(!Array.isArray(cues)||cues.length>50000||cues.some(c=>!c||typeof c.text!=='string'||c.text.length>20000||!Number.isFinite(c.start)||!Number.isFinite(c.end)))throw new Error('잘못된 자막 정보입니다.');let file=await chooseSave('자막.srt',['srt']);if(!file)return null;if(path.extname(file).toLowerCase()!=='.srt')file+='.srt';await atomicWrite(file,formatSrt(cues));allow(file);return file;});
}
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.mp4':'video/mp4','.m4v':'video/mp4','.mov':'video/quicktime','.mkv':'video/x-matroska','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.flac':'audio/flac','.m4a':'audio/mp4','.ogg':'audio/ogg','.opus':'audio/ogg'};
function setupProtocols(){
  const dist=path.resolve(__dirname,'../dist');
  protocol.handle('slu-app',request=>{try{if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});const url=new URL(request.url);const relative=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);const file=path.resolve(dist,'.'+relative);if(url.hostname!=='studio'||!insideDirectory(file,dist))return new Response('Not found',{status:404});return net.fetch(pathToFileURL(file).toString(),{method:request.method});}catch{return new Response('Not found',{status:404});}});
  protocol.handle('slu-media',async request=>{
    try{
      if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405});
      const url=new URL(request.url);let file=decodeURIComponent(url.pathname.slice(1));if(url.hostname!=='file'||!localFilePath(file)||!allowedFiles.has(key(file)))return new Response('Forbidden',{status:403});
      if(mp3PreviewFiles.has(key(file)))file=await audioPreviews.prepare(file,url.searchParams.get('revision')||undefined);
      if(request.signal.aborted)return new Response(null,{status:499});
      const stat=await fs.stat(file);if(!stat.isFile())return new Response('Not found',{status:404});
      const headers:Record<string,string>={'Content-Type':mime[path.extname(file).toLowerCase()]||'application/octet-stream','Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*','Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff'};
      const range=parseByteRange(request.headers.get('range'),stat.size);if(!range)return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${stat.size}`}});
      const {start,end,partial}=range,status=partial?206:200;
      if(partial)headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length']=String(Math.max(0,end-start+1));if(request.method==='HEAD'||stat.size===0)return new Response(null,{status,headers});
      return new Response(Readable.toWeb(createReadStream(file,{start,end})) as ReadableStream<Uint8Array>,{status,headers});
    }catch{return new Response('Not found',{status:404});}
  });
}
const single=app.requestSingleInstanceLock();
if(!single)app.quit();else{
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
  app.whenReady().then(async()=>{
    await fs.mkdir(cacheDir,{recursive:true});await fs.mkdir(modelDir,{recursive:true});setupProtocols();setupIPC();
    session.defaultSession.setPermissionRequestHandler((_w,_p,cb)=>cb(false));session.defaultSession.setPermissionCheckHandler(()=>false);
    Menu.setApplicationMenu(null);
    win=new BrowserWindow({width:1600,height:1000,minWidth:1100,minHeight:720,backgroundColor:'#0d0d0d',title:`SLU Studio v${app.getVersion()}`,icon:path.join(resourceRoot,'icon.png'),show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:false,backgroundThrottling:!backgroundTest}});
    win.on('page-title-updated',event=>event.preventDefault());
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
    win.once('ready-to-show',()=>{if(!backgroundTest)win?.show();});
    win.on('close',event=>{if(jobs.size){const result=dialog.showMessageBoxSync(win!,{type:'question',buttons:['계속 작업','작업 취소 후 종료'],defaultId:0,cancelId:0,message:'진행 중인 작업이 있습니다. 종료할까요?'});if(result===0){event.preventDefault();return;}for(const j of jobs.values())j.controller.abort();}});
    win.on('closed',()=>{win=null;analysisQueue.length=0;for(const controller of analysisControllers)controller.abort();});
    if(!app.isPackaged&&process.env.SLU_DEV_URL)await win.loadURL('http://127.0.0.1:5173');else await win.loadURL('slu-app://studio/index.html');
    void getSystemInfo();
  }).catch(async error=>{if(backgroundTest)await fs.writeFile(path.join(app.getPath('userData'),'startup-error.log'),String(error)).catch(()=>{});else dialog.showErrorBox('SLU Studio 시작 실패',String(error));app.quit();});
  app.on('window-all-closed',()=>app.quit());
  let quitting=false;
  app.on('before-quit',event=>{
    if(quitting)return;
    event.preventDefault();quitting=true;
    const pending=[...jobs.values()];for(const job of pending)job.controller.abort();
    // Give child processes and queued recovery writes time to close cleanly before exit.
    const timeout=setTimeout(()=>app.quit(),15000);
    void Promise.allSettled([flushAutosave(),manualSaves.flush(),audioPreviews.close(),trackingStills.close(),...pending.map(job=>job.done)])
      .then(()=>Promise.allSettled([...enhancementPreviews.keys()].map(discardEnhancementPreview)))
      .finally(()=>{clearTimeout(timeout);app.quit();});
  });
}
