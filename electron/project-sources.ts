import type {Project,MediaAsset} from '../shared/types';
import {reconcileTransitions} from '../shared/transition-edits';
import {CancelledError,probeMedia,type EngineContext,type ProgressCallback} from './media';
import {probeVideoRange} from './video-range';
import {readSourceRevision} from './source-revision';
import {previewProxyPath} from '../shared/media-clock';
import {hasLegacyProxyTiming} from './proxy-cache';

const abort=(signal?:AbortSignal)=>{if(signal?.aborted)throw new CancelledError();};
/** Find changed sources and unchanged legacy assets needing current preview metadata.
 * Missing paths remain available to the existing relink dialog. */
export async function changedProjectSources(project:Project):Promise<Set<string>> {
  const assets=new Map<string,MediaAsset[]>();for(const asset of project.media){const list=assets.get(asset.path)||[];list.push(asset);assets.set(asset.path,list);}
  const paths=[...assets.keys()],changed=new Set<string>();let cursor=0;
  await Promise.all(Array.from({length:Math.min(3,paths.length)},async()=>{while(cursor<paths.length){
    const file=paths[cursor++];let revision:string;
    try{revision=await readSourceRevision(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(assets.get(file)!.some(asset=>asset.sourceRevision!==revision||(asset.kind!=='image'&&!asset.timing)||(asset.kind==='video'&&asset.hasAlpha===undefined)||(asset.proxyPath&&!previewProxyPath(asset))||hasLegacyProxyTiming(asset)))changed.add(file);
  }}));
  return changed;
}

/** Called inside one cancellable range job. Probe changed originals only, scan
 * their transition participants when needed, then publish one complete snapshot.
 * The saved project and the input object are never modified. */
export async function refreshProjectSources(project:Project,changed:ReadonlySet<string>,ctx:EngineContext,progress?:ProgressCallback,signal?:AbortSignal):Promise<{project:Project;changedSources:number;detachedTransitions:number}> {
  abort(signal);if(!changed.size)return {project,changedSources:0,detachedTransitions:0};
  const control=new AbortController(),combined=signal?AbortSignal.any([signal,control.signal]):control.signal;
  const paths=[...changed],fresh=new Map<string,MediaAsset>();let cursor=0,completed=0,failure:unknown;
  const workers=Array.from({length:Math.min(3,paths.length)},async()=>{
    try{while(cursor<paths.length){abort(combined);const file=paths[cursor++],asset=await probeMedia(file,ctx,combined,{derivatives:false});fresh.set(file,asset);progress?.(++completed/paths.length*.4,'변경된 원본 미디어 확인 중');}}
    catch(error){failure??=error;control.abort();}
  });
  await Promise.all(workers);if(failure)throw failure;abort(combined);
  const clipAssets=new Map(project.clips.map(clip=>[clip.id,clip.mediaId]));
  const participantIds=new Set((project.transitions||[]).flatMap(transition=>[clipAssets.get(transition.fromClipId),clipAssets.get(transition.toClipId)]));
  const participantPaths=new Set(project.media.filter(asset=>participantIds.has(asset.id)&&changed.has(asset.path)&&fresh.get(asset.path)?.kind==='video').map(asset=>asset.path));
  let scanned=0;
  for(const file of participantPaths){
    const range=await probeVideoRange(file,ctx,combined,{progress:value=>progress?.(.4+.55*(scanned+value)/participantPaths.size,'전환에 사용할 실제 영상 프레임 확인 중')});
    if(!range)throw new Error('변경된 원본 영상의 프레임 범위를 확인할 수 없습니다. 프로젝트를 열지 않았습니다.');
    const asset=fresh.get(file)!;fresh.set(file,{...asset,...range,duration:Math.max(asset.duration,range.videoEnd)});scanned++;
  }
  for(const [file,asset] of fresh){abort(combined);if(await readSourceRevision(file)!==asset.sourceRevision)throw new Error('프로젝트를 여는 중 원본 파일이 다시 변경되었습니다. 다시 열어 주세요.');}
  const changedSources=new Set(project.media.filter(asset=>fresh.has(asset.path)&&asset.sourceRevision!==fresh.get(asset.path)!.sourceRevision).map(asset=>asset.path)).size;
  const media=project.media.map(asset=>{
    const update=fresh.get(asset.path);if(!update)return asset;
    if(asset.sourceRevision!==update.sourceRevision)return {...update,id:asset.id};
    // Metadata migration must not discard still-valid original/proxy references
    // or user asset names. A corrected duration does invalidate waveform bins.
    const retained={...asset};if(Math.abs(asset.duration-update.duration)>.001)delete retained.waveform;
    const result={...retained,...update,id:asset.id,name:asset.name};if(hasLegacyProxyTiming(asset)||!previewProxyPath(result))delete result.proxyPath;return result;
  });
  const result=reconcileTransitions(project,{...project,media});abort(combined);progress?.(1,'원본 미디어 확인 완료');
  return {project:result.project,changedSources,detachedTransitions:result.detached.length};
}
