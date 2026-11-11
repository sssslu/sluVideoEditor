import {version as buildVersion} from '../package.json';
import {copyMotionBindings,restoreMotionPaths,splitMotionSources} from '../shared/motion';
import {applyCaptionAppearance,type CaptionAppearance} from './captions/presets';
import {editCaptionText,assertCaptionWords,textCaptionStyle} from '../shared/captions';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Check, ChevronDown, CircleHelp, FilePlus2, FolderOpen, Keyboard, LoaderCircle, Redo2, Save, Undo2, X } from 'lucide-react';
import type { Clip, ExportSettings, JobEvent, MediaAsset, Project, SystemInfo, TextStyle, Track,SpeechModelId,SpeechOptions,PreviewStatusEvent } from '../shared/types';
import {previewProxyPath,previewSourceKey} from '../shared/media-clock';
import { interpolate, keyframeBase, newClip, newProject, projectDuration, splitClip, uid } from '../shared/project';
import {clipSourceSpan,clipSourceTime} from '../shared/speed';
import {applyEnhancement,restoreEnhancement,enhancementSource,applyCutout,restoreCutout,cutoutSource,applyReversal,restoreReversal,reversalSource,clipMediaIds,applyStabilization,clipMediaAvailable,restoreStabilization,sameSourceInterval,sourceCuesToTimeline,stabilizationSource} from '../shared/processing';
import type {StabilizationOptions,PersonCutoutOptions} from '../shared/types';
import type {Transition} from '../shared/types';
import {compileTransitions,transitionBounds} from '../shared/transitions';
import {copyTransitions} from '../shared/transition-edits';
import {restoreColorLuts} from '../shared/color-edits';
import { clamp, cuesToClips, inputTarget, toCues, useHistory,mergeAsset,minClipDuration,placeDroppedMedia } from './editor';
import {planCombination,applyCombination,uncombineClip,type CombinePlan} from '../shared/combine';
import Preview,{type TransformPatch} from './Preview';
import SourceMonitor from './SourceMonitor';
import {frameTime,insertClip,boundedNudgeDelta} from './timeline-model';
import Timeline from './Timeline';
import Inspector from './Inspector';
import CutoutDialog from './CutoutDialog';
import EnhancementDialog from './EnhancementDialog';
import StabilizationDialog from './StabilizationDialog';
import FreezeDialog from './FreezeDialog';
import TrackingDialog from './TrackingDialog';
import {planTracking,validateTrackingTarget,applyTracking,detachMotion,type TrackingApply} from './tracking-edits';
import {bindingTime} from '../shared/motion';
import {planTrackingReconnect,applyTrackingReconnect,type TrackingReconnectTarget} from '../shared/tracking-reconnect';
import {planFreeze,insertFreeze} from './freeze';
import Library, {type LibraryTab} from './Library';
import { ExportDialog, JobsPanel, Modal, ShortcutDialog, TranscribeDialog } from './Dialogs';

interface Toast {id:number;text:string;kind:'info'|'error';previewSource?:string;previewPath?:string}
interface EditorJobContext {projectId:string;session:number;combine?:{plan:CombinePlan;clips:Clip[]};source?:MediaAsset;clipMedia?:MediaAsset;clip?:Clip;stabilize?:{source:MediaAsset;start:number;options:StabilizationOptions};freeze?:{at:number;duration:number};reverse?:boolean;cutout?:Pick<PersonCutoutOptions,'quality'>;enhancement?:{scale:2|4};reconnect?:TrackingReconnectTarget}
const matchesMediaSource=(project:Project,source:MediaAsset|undefined)=>{if(!source)return true;const current=project.media.find(m=>m.id===source.id);return !!current&&current.path===source.path&&current.sourceRevision===source.sourceRevision;};
const editSnapshot=(p:Project)=>JSON.stringify({...p,updatedAt:undefined,media:p.media.map(m=>({id:m.id,path:m.path,name:m.name,sourceRevision:m.sourceRevision}))});
const humanError=(error:unknown)=>error instanceof Error?error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''):String(error);
function selectedCut(project:Project,selected:string[]):[Clip,Clip]|null {
  const tracks=new Map(project.tracks.map(t=>[t.id,t])),media=new Map(project.media.map(m=>[m.id,m])),ids=new Set(selected);
  const visual=(c:Clip)=>c.text===undefined&&tracks.get(c.trackId)?.type==='video'&&['video','image'].includes(media.get(c.mediaId||'')?.kind||'');
  const clips=project.clips.filter(c=>ids.has(c.id)&&visual(c));
  const adjacent=(a:Clip,b:Clip)=>a.trackId===b.trackId&&Math.abs(a.start+a.duration-b.start)<1e-7;
  if(clips.length===2&&selected.length===2){clips.sort((a,b)=>a.start-b.start);return adjacent(clips[0],clips[1])?[clips[0],clips[1]]:null;}
  if(clips.length!==1||selected.length!==1)return null;const clip=clips[0],after=project.clips.find(c=>visual(c)&&c.id!==clip.id&&adjacent(clip,c)),before=project.clips.find(c=>visual(c)&&c.id!==clip.id&&adjacent(c,clip));
  return after?[clip,after]:before?[before,clip]:null;
}

export default function App() {
  const history=useHistory(),{project,current,change,reset:resetHistory,checkpoint,undo,redo,canUndo,canRedo}=history;
  const projectSession=useRef(0),loadIntent=useRef(0),saveIntent=useRef(0),transitionBusyRef=useRef(false);
  const mediaUpdates=useRef(new Map<string,MediaAsset>());
  const previewAttempts=useRef(new Map<string,PreviewStatusEvent>()),preparedPreviews=useRef(new Set<string>());
  const [previewFailures,setPreviewFailures]=useState<Record<string,Extract<PreviewStatusEvent,{status:'failed'}>>>({});
  const reset=useCallback((p:Project)=>{
    projectSession.current++;
    loadIntent.current++;
    // Preview preparation can finish while the recovery confirmation is open.
    // Fill missing derivatives only for the exact source revision being loaded.
    const media=p.media.map(asset=>{
      const update=mediaUpdates.current.get(asset.path);
      if(!asset.sourceRevision||update?.sourceRevision!==asset.sourceRevision)return asset;
      return mergeAsset(asset,{
        proxyPath:asset.proxyPath??update.proxyPath,
        thumbnail:asset.thumbnail??update.thumbnail,
        waveform:asset.waveform??(Math.abs(asset.duration-update.duration)<.001?update.waveform:undefined),
      });
    });
    resetHistory({...p,media});
  },[resetHistory]);
  const [selected,setSelectedState]=useState<string[]>([]),[time,setTime]=useState(0),[playing,setPlaying]=useState(false),[tab,setTab]=useState<LibraryTab>('media');
  const [selectedTransitionId,setSelectedTransitionId]=useState<string>(),[transitionBusy,setTransitionBusy]=useState(false);
  const setSelected=useCallback((ids:string[])=>{setSelectedState(ids);setSelectedTransitionId(undefined);},[]);
  const [system,setSystem]=useState<SystemInfo|null>(null),[projectPath,setProjectPath]=useState<string>(),[savedStamp,setSavedStamp]=useState(project.updatedAt);
  const [modal,setModal]=useState<'export'|'transcribe'|'shortcuts'|'recoveries'|'stabilize'|'freeze'|'track'|'cutout'|'enhance'|null>(null),[fileMenu,setFileMenu]=useState(false);
  const [cutoutTarget,setCutoutTarget]=useState<({clip:Clip;session:number}&ReturnType<typeof cutoutSource>)|null>(null);
  const cutoutStarting=useRef(new Set<string>());
  const [enhancementTarget,setEnhancementTarget]=useState<({clip:Clip;session:number;previewStart:number}&ReturnType<typeof enhancementSource>)|null>(null);
  const enhancementStarting=useRef(new Set<string>()),earlyEnhancementEvents=useRef(new Map<string,JobEvent>()),handleJob=useRef<(event:JobEvent)=>void>(()=>{});
  const [freezeTarget,setFreezeTarget]=useState<ReturnType<typeof planFreeze>|null>(null);
  const [trackingTarget,setTrackingTarget]=useState<{target:ReturnType<typeof planTracking>;session:number;id:string}>();
  const trackingDialogJobs=useRef(new Set<string>());
  const reconnectPicker=useRef(false);const [reconnectStarting,setReconnectStarting]=useState(false);
  const [recoveries,setRecoveries]=useState<{id:string;name:string;updatedAt:string;clips:number}[]>([]);
  const [jobs,setJobs]=useState<JobEvent[]>([]),[jobsOpen,setJobsOpen]=useState(false),[toasts,setToasts]=useState<Toast[]>([]),[importing,setImporting]=useState(false);
  const [proxy,setProxy]=useState(()=>localStorage.getItem('slu-proxy')!=='false'),[ripple,setRipple]=useState(false),[zoom,setZoom]=useState(48);
  const [sourceMedia,setSourceMedia]=useState<MediaAsset|null>(null),[monitorMode,setMonitorMode]=useState<'timeline'|'source'>('timeline'),[seekId,setSeekId]=useState(0);
  const [timelineHeight,setTimelineHeight]=useState(()=>Number(localStorage.getItem('slu-timeline-height'))||290);
  const [draggingFiles,setDraggingFiles]=useState(false),[recovery,setRecovery]=useState<Project|null>(null),[recoveryChecked,setRecoveryChecked]=useState(false),[autoSaved,setAutoSaved]=useState(false);
  const timeRef=useRef(time),clipboard=useRef<{clips:Clip[];transitions:Transition[];fps:number;colorLuts:NonNullable<Project['colorLuts']>;motionPaths:NonNullable<Project['motionPaths']>}>({clips:[],transitions:[],fps:project.fps,colorLuts:[],motionPaths:[]}),toastId=useRef(0),jobContexts=useRef(new Map<string,EditorJobContext>()) ,handledJobs=useRef(new Set<string>());
  const rangePanelTimers=useRef(new Map<string,number>());
  useEffect(()=>()=>{for(const timer of rangePanelTimers.current.values())window.clearTimeout(timer);rangePanelTimers.current.clear();},[]);
  const [transcribeTarget,setTranscribeTarget]=useState<{clip:Clip;media:MediaAsset}|null>(null);
  const [stabilizeTarget,setStabilizeTarget]=useState<{clip:Clip;media:MediaAsset;start:number;duration:number}|null>(null);
  const appVersion=system?.version||buildVersion;
  useEffect(()=>{document.title=`SLU Studio v${appVersion}`;},[appVersion]);
  const dirty=project.updatedAt!==savedStamp;
  const notify=useCallback((text:string,kind:'info'|'error'='info',media?:Pick<MediaAsset,'path'|'sourceRevision'>)=>{const id=++toastId.current;setToasts(items=>[...items.slice(-2),{id,text,kind,previewSource:media?previewSourceKey(media):undefined,previewPath:media?.path}]);window.setTimeout(()=>setToasts(items=>items.filter(t=>t.id!==id)),kind==='error'?12000:4500);},[]);
  const clearPreviewIssue=useCallback((media:Pick<MediaAsset,'path'|'sourceRevision'>)=>{
    const key=previewSourceKey(media);
    setPreviewFailures(previous=>{if(!previous[key])return previous;const next={...previous};delete next[key];return next;});
    setToasts(previous=>previous.some(toast=>toast.previewSource===key)?previous.filter(toast=>toast.previewSource!==key):previous);
  },[]);
  const previewReady=useCallback((media:MediaAsset)=>{preparedPreviews.current.add(previewSourceKey(media));clearPreviewIssue(media);},[clearPreviewIssue]);
  useEffect(()=>{
    const replaced=(media:Pick<MediaAsset,'path'|'sourceRevision'>)=>project.media.some(asset=>asset.path===media.path&&asset.sourceRevision!==media.sourceRevision);
    for(const [key,event] of previewAttempts.current)if(replaced(event.media)){previewAttempts.current.delete(key);preparedPreviews.current.delete(key);}
    setPreviewFailures(previous=>{const remaining=Object.entries(previous).filter(([,event])=>!replaced(event.media));return remaining.length===Object.keys(previous).length?previous:Object.fromEntries(remaining);});
    setToasts(previous=>{const remaining=previous.filter(toast=>!toast.previewPath||!project.media.some(asset=>asset.path===toast.previewPath&&previewSourceKey(asset)!==toast.previewSource));return remaining.length===previous.length?previous:remaining;});
  },[project.media]);
  const cut=useMemo(()=>selectedCut(project,selected),[project,selected]);
  useEffect(()=>{if(history.transitionNotice){notify(`컷 또는 원본 구간이 바뀌어 전환 ${history.transitionNotice.count}개를 해제했습니다.`);history.clearTransitionNotice();}},[history.transitionNotice,history.clearTransitionNotice,notify]);
  useEffect(()=>{if(selectedTransitionId&&!project.transitions?.some(t=>t.id===selectedTransitionId))setSelectedTransitionId(undefined);},[project.transitions,selectedTransitionId]);
  const fail=useCallback((e:unknown)=>notify(humanError(e),'error'),[notify]);
  useEffect(()=>{if(modal==='track'&&trackingTarget&&(trackingTarget.session!==projectSession.current||trackingTarget.target.projectId!==project.id))setModal(null);},[project,modal,trackingTarget]);
  const seek=useCallback((value:number)=>{setPlaying(false);setMonitorMode('timeline');timeRef.current=clamp(value,0,86400);setTime(timeRef.current);setSeekId(v=>v+1);},[]);
  const selectTransition=(id:string|null)=>{setSelectedState([]);setSelectedTransitionId(id||undefined);setPlaying(false);if(id){const t=current.current.transitions?.find(t=>t.id===id),clip=current.current.clips.find(c=>c.id===t?.toClipId);if(clip)seek(clip.start);}};
  const updateTransition=(id:string,patch:Partial<Transition>):boolean=>{try{const p=current.current,t=p.transitions?.find(t=>t.id===id),from=p.clips.find(c=>c.id===t?.fromClipId);if(!t||!from||p.tracks.find(track=>track.id===from.trackId)?.locked)return false;const allowed=Object.fromEntries(Object.entries(patch).filter(([key])=>['kind','durationFrames','easing','direction','audio'].includes(key)));const next={...p,transitions:p.transitions!.map(value=>value.id===id?{...value,...allowed}:value)};compileTransitions(next);change(next);return true;}catch(error){fail(error);return false;}};
  const removeTransition=(id:string)=>{const p=current.current,t=p.transitions?.find(t=>t.id===id),clip=p.clips.find(c=>c.id===t?.fromClipId);if(!t||!clip||p.tracks.find(track=>track.id===clip.trackId)?.locked)return;const transitions=p.transitions!.filter(t=>t.id!==id);change({...p,transitions:transitions.length?transitions:undefined});setSelectedTransitionId(undefined);};
  const addTransition=async(kind:Transition['kind'],fromId?:string,toId?:string)=>{
    if(transitionBusyRef.current)return;const p=current.current,session=projectSession.current,chosen=fromId&&toId?[p.clips.find(c=>c.id===fromId),p.clips.find(c=>c.id===toId)]:selectedCut(p,selected);
    const a=chosen?.[0],b=chosen?.[1];if(!a||!b){notify('같은 영상 트랙에서 맞닿은 두 클립을 선택하세요.');return;}
    if(p.tracks.find(track=>track.id===a.trackId)?.locked)return;
    const existing=p.transitions?.find(t=>t.fromClipId===a.id&&t.toClipId===b.id);if(existing){if(updateTransition(existing.id,{kind}))selectTransition(existing.id);return;}
    transitionBusyRef.current=true;setTransitionBusy(true);try{
      const beforeA=structuredClone(a),beforeB=structuredClone(b),limits=transitionBounds(p,a.id,b.id),ranges:MediaAsset[]=[];
      if(limits.pendingMediaIds.length)setJobsOpen(true);
      for(const id of limits.pendingMediaIds){const media=p.media.find(m=>m.id===id)!;ranges.push(await window.studio.analyzeVideoRange(media));}
      const currentProject=current.current;if(currentProject.id!==p.id||projectSession.current!==session)return;
      const from=currentProject.clips.find(c=>c.id===a.id),to=currentProject.clips.find(c=>c.id===b.id);
      const sameSource=(clip:Clip)=>{const before=p.media.find(m=>m.id===clip.mediaId),now=currentProject.media.find(m=>m.id===clip.mediaId);return before?.path===now?.path&&before?.sourceRevision===now?.sourceRevision;};
      if(!from||!to||!sameSourceInterval(from,beforeA)||!sameSourceInterval(to,beforeB)||!sameSource(from)||!sameSource(to)||currentProject.tracks.find(t=>t.id===from.trackId)?.locked){notify('분석 중 클립 구간·원본이 변경되었거나 잠겨 전환을 적용하지 않았습니다.');return;}
      if(ranges.some(range=>{const asset=currentProject.media.find(m=>m.id===range.id);return !!asset?.sourceRevision&&asset.sourceRevision!==range.sourceRevision;}))throw new Error('원본 파일이 변경되었습니다. 프로젝트를 다시 열어 미디어를 갱신하세요.');
      const media=currentProject.media.map(asset=>{const range=ranges.find(m=>m.id===asset.id&&m.path===asset.path);return range?{...asset,sourceRevision:range.sourceRevision,videoStart:range.videoStart,videoEnd:range.videoEnd,duration:Math.max(asset.duration,range.duration)}:asset;}),next={...currentProject,media},limit=transitionBounds(next,from.id,to.id);
      if(!limit.maxFrames)throw new Error(limit.reason||'전환에 필요한 원본 여유 구간이 부족합니다.');
      const transition:Transition={id:uid(),fromClipId:from.id,toClipId:to.id,kind,durationFrames:Math.min(Math.max(1,Math.round(next.fps*.5)),limit.maxFrames),easing:'linear',direction:'left',audio:'linear'};
      const applied={...next,version:10 as const,transitions:[...(next.transitions||[]),transition]};compileTransitions(applied);change(applied);setTab('transitions');selectTransition(transition.id);
    }catch(error){if(projectSession.current===session)fail(error);}finally{transitionBusyRef.current=false;setTransitionBusy(false);}
  };
  const refreshSystem=useCallback(()=>{window.studio.getSystemInfo().then(setSystem).catch(fail);},[fail]);
  const runHelp=useCallback(()=>{void window.studio.openHelp().catch(fail);},[fail]);
  useEffect(()=>window.studio?.onProjectWarning?.(message=>notify(message,'error')),[notify]);
  useEffect(()=>window.studio?.onPreviewStatus?.(event=>{
    const key=previewSourceKey(event.media);
    if(event.status==='preparing'){
      previewAttempts.current.set(key,event);
      preparedPreviews.current.delete(key);
      clearPreviewIssue(event.media);
      const cached=mediaUpdates.current.get(event.media.path);
      if(cached&&previewSourceKey(cached)===key){const next={...cached};delete next.proxyPath;mediaUpdates.current.set(event.media.path,next);}
    }else if(previewAttempts.current.get(key)?.attemptId===event.attemptId&&!preparedPreviews.current.has(key)){
      setPreviewFailures(previous=>({...previous,[key]:event}));
      notify(event.message,'error',event.media);
    }
  }),[clearPreviewIssue,notify]);

  useEffect(()=>{if(!window.studio)return;refreshSystem();window.studio.recoverProject().then(saved=>{if(saved&&(saved.clips.length||saved.media.length))setRecovery(saved);setRecoveryChecked(true);}).catch(e=>{fail(e);setRecoveryChecked(true);});},[refreshSystem,fail]);
  useEffect(()=>{localStorage.setItem('slu-proxy',String(proxy));},[proxy]);
  useEffect(()=>{const ids=new Set(project.clips.map(c=>c.id));setSelectedState(previous=>previous.every(id=>ids.has(id))?previous:previous.filter(id=>ids.has(id)));},[project.clips]);
  useEffect(()=>window.studio?.onMediaUpdated?.(media=>{mediaUpdates.current.set(media.path,media);if(previewProxyPath(media))previewReady(media);change(p=>{const matches=(m:MediaAsset)=>(m.path===media.path||m.id===media.id)&&(!m.sourceRevision||!media.sourceRevision||m.sourceRevision===media.sourceRevision);return p.media.some(matches)?{...p,media:p.media.map(m=>matches(m)?mergeAsset(m,media):m)}:p;},false);}),[change,previewReady]);
  useLayoutEffect(()=>{if(!window.studio||!recoveryChecked||recovery)return;let active=true;setAutoSaved(false);void window.studio.autosave(project).then(()=>{if(active)setAutoSaved(true);}).catch(e=>{if(active)fail(e);});return()=>{active=false;};},[project,recoveryChecked,recovery,fail]);
  const play=useCallback(()=>{if(!projectDuration(current.current))return;setPlaying(v=>{if(!v&&timeRef.current>=projectDuration(current.current)-.01){timeRef.current=0;setTime(0);setSeekId(n=>n+1);}return !v;});},[current]);
  const transportTime=useCallback((value:number)=>{timeRef.current=value;setTime(value);},[]);
  const sourceSelect=(media:MediaAsset)=>{setPlaying(false);setSourceMedia(media);setMonitorMode('source');};
  // Removing (or undoing the import of) the source monitor's media closes it.
  useEffect(()=>{if(sourceMedia&&!project.media.some(m=>m.id===sourceMedia.id)){setSourceMedia(null);setMonitorMode('timeline');}},[project.media,sourceMedia]);
  // A press elsewhere commits a focused number field before the press can change the clip or time it edits.
  useEffect(()=>{const down=(event:PointerEvent)=>{const field=document.activeElement instanceof HTMLInputElement&&document.activeElement.type==='number'?document.activeElement.closest('.number-field'):null;if(field&&!(event.target instanceof Node&&field.contains(event.target)))(document.activeElement as HTMLInputElement).blur();};window.addEventListener('pointerdown',down,true);return()=>window.removeEventListener('pointerdown',down,true);},[]);
  const resizeTimeline=(e:React.PointerEvent)=>{e.preventDefault();const y=e.clientY,initial=timelineHeight;const move=(v:PointerEvent)=>setTimelineHeight(clamp(initial+y-v.clientY,180,Math.max(200,innerHeight-300)));const end=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);};window.addEventListener('pointermove',move);window.addEventListener('pointerup',end,{once:true});};
  useEffect(()=>{localStorage.setItem('slu-timeline-height',String(timelineHeight));},[timelineHeight]);

  const importAssets=useCallback(async(paths?:string[],place?:{trackId:string;at:number})=>{
    const session=projectSession.current;setImporting(true);
    try{
      const assets=(await window.studio.importMedia(paths)).map(m=>{const cached=mediaUpdates.current.get(m.path);return mergeAsset(m,cached?.sourceRevision===m.sourceRevision?cached:undefined);});
      if(projectSession.current!==session)return;
      const p=current.current,transitionClips=new Set((p.transitions||[]).flatMap(t=>[t.fromClipId,t.toClipId])),participants=new Set(p.clips.filter(c=>transitionClips.has(c.id)).map(c=>c.mediaId));
      for(let i=0;i<assets.length;i++){const old=p.media.find(m=>m.path===assets[i].path);if(old&&old.sourceRevision!==assets[i].sourceRevision&&assets[i].kind==='video'&&participants.has(old.id)&&assets[i].videoStart===undefined)assets[i]=await window.studio.analyzeVideoRange({...assets[i],id:old.id});}
      if(projectSession.current!==session)return;
      if(assets.length){let placed:Clip[]=[],placeError:unknown;change(next=>{const byPath=new Map(assets.map(m=>[m.path,m])),media=[...next.media.map(m=>mergeAsset(m,byPath.get(m.path))),...assets.filter(m=>!next.media.some(old=>old.path===m.path))],imported={...next,media};if(!place)return imported;try{const result=placeDroppedMedia(imported,assets.map(asset=>media.find(m=>m.path===asset.path)!),place.trackId,place.at);placed=result.clips;return result.project;}catch(error){placeError=error;return imported;}},true,{authoritativeSources:assets});setTab('media');if(placed.length){setSelected(placed.map(c=>c.id));seek(placed[0].start);notify(`${assets.length}개 미디어를 가져와 타임라인에 놓았습니다.`);}else notify(`${assets.length}개 미디어를 가져왔습니다.`);if(placeError)fail(placeError);}
    }catch(e){if(projectSession.current===session)fail(e);}finally{setImporting(false);}
  },[change,notify,fail,current,setSelected,seek]);
  const dropFiles=(files:File[],trackId:string,at:number)=>{setDraggingFiles(false);const paths=files.map(f=>window.studio.getPathForFile(f)).filter(Boolean);if(paths.length)void importAssets(paths,{trackId,at});};
  const addTrack=(type:Track['type'])=>{if(current.current.tracks.length>=100){notify('프로젝트당 최대 100개 트랙을 지원합니다.','error');return;}const id=uid();change(p=>({...p,tracks:[...p.tracks,{id,type,name:`${type==='video'?'영상':type==='audio'?'오디오':'텍스트'} ${p.tracks.filter(t=>t.type===type).length+1}`,muted:false,hidden:false,locked:false}]}));return id;};
  const addMedia=(media:MediaAsset,trackId?:string,start?:number)=>{
    const p=current.current,type=media.kind==='audio'?'audio':'video';let track=p.tracks.find(t=>t.id===trackId)||p.tracks.find(t=>t.type===type&&!t.locked);
    if(p.clips.length>=10000){notify('프로젝트당 최대 10,000개 클립을 지원합니다.','error');return;}
    if(track?.locked)return;
    if(!track){
      if(p.tracks.length>=100){notify('프로젝트당 최대 100개 트랙을 지원합니다.','error');return;}
      track={id:uid(),type,name:type==='audio'?'오디오':'영상',muted:false,hidden:false,locked:false};
    }
    const at=start??Math.max(0,...p.clips.filter(c=>c.trackId===track!.id).map(c=>c.start+c.duration));
    const clip=newClip(track.id,media,at);clip.duration=Math.min(clip.duration,86400-at);if(clip.duration<minClipDuration(p.fps)){notify('타임라인 길이는 최대 24시간입니다.','error');return;}
    change(v=>({...v,tracks:v.tracks.some(t=>t.id===track!.id)?v.tracks:[...v.tracks,track!],clips:[...v.clips,clip]}));setSelected([clip.id]);seek(at);
  };
  const addSourceRange=(media:MediaAsset,sourceIn:number,sourceOut:number,mode:'insert'|'overwrite'|'append')=>{const p=current.current;if(!p.media.some(m=>m.id===media.id)){notify('원본 미디어가 프로젝트에 없습니다.','error');return;}const type=media.kind==='audio'?'audio':'video';let track=p.tracks.find(t=>t.id===p.clips.find(c=>selected.includes(c.id))?.trackId&&t.type===type&&!t.locked)||p.tracks.find(t=>t.type===type&&!t.locked);
    if(!track){
      if(p.tracks.length>=100){notify('프로젝트당 최대 100개 트랙을 지원합니다.','error');return;}
      track={id:uid(),type,name:type==='audio'?'오디오':'영상',muted:false,hidden:false,locked:false};
    }
    const at=mode==='append'?Math.max(0,...p.clips.filter(c=>c.trackId===track!.id).map(c=>c.start+c.duration)):frameTime(timeRef.current,p.fps),clip={...newClip(track.id,media,at),in:sourceIn,duration:sourceOut-sourceIn};const clips=insertClip(p,clip,mode);if(clips.length>10000){notify('프로젝트당 최대 10,000개 클립을 지원합니다.','error');return;}if(clips.some(c=>c.start+c.duration>86400)){notify('타임라인 최대 길이 24시간을 넘을 수 없습니다.','error');return;}change({...p,tracks:p.tracks.some(t=>t.id===track!.id)?p.tracks:[...p.tracks,track],clips});setSelected([clip.id]);seek(at);};
  const addText=(style:TextStyle)=>{
    const p=current.current;if(p.clips.length>=10000||timeRef.current+3>86400){notify('클립 수 또는 타임라인 길이 제한에 도달했습니다.','error');return;}let track=p.tracks.find(t=>t.type==='text'&&!t.locked);
    if(!track){
      if(p.tracks.length>=100){notify('프로젝트당 최대 100개 트랙을 지원합니다.','error');return;}
      track={id:uid(),type:'text',name:'자막 · 텍스트',muted:false,hidden:false,locked:false};
    }
    const clip={...newClip(track.id),start:frameTime(timeRef.current,p.fps),textStyle:style,captionStyle:textCaptionStyle(style),y:style==='title'||style==='neon'?0:p.height*.32,fontSize:clamp(Math.round(p.height*(style==='title'?.08:.052)),4,1000),text:'텍스트',animation:'none',color:style==='neon'?'#76fbe0':'#ffffff'} as Clip;
    clip.name=clip.text!;change(v=>({...v,tracks:v.tracks.some(t=>t.id===track!.id)?v.tracks:[...v.tracks,track!],clips:[...v.clips,clip]}));setSelected([clip.id]);setTab('text');
  };
  const insertCaptionAppearance=(appearance:CaptionAppearance)=>{
    const p=current.current,at=frameTime(timeRef.current,p.fps);if(p.clips.length>=10000||at+3>86400){notify('클립 수 또는 타임라인 길이 제한에 도달했습니다.','error');return;}
    let track=p.tracks.find(t=>t.type==='text'&&!t.locked);if(!track){if(p.tracks.length>=100){notify('트랙은 최대 100개입니다.','error');return;}track={id:uid(),type:'text',name:'자막 · 텍스트',muted:false,hidden:false,locked:false};}
    const clip=applyCaptionAppearance({...newClip(track.id),start:at,y:p.height*.32},appearance);
    change({...p,tracks:p.tracks.some(t=>t.id===track!.id)?p.tracks:[...p.tracks,track],clips:[...p.clips,clip]});setSelected([clip.id]);setTab('text');
  };
  const applyCaptionAppearanceToSelected=(appearance:CaptionAppearance)=>{const p=current.current,ids=new Set(selected),locked=new Set(p.tracks.filter(t=>t.locked).map(t=>t.id));if(!p.clips.some(c=>ids.has(c.id)&&c.text!==undefined&&!locked.has(c.trackId)))return;change({...p,clips:p.clips.map(c=>ids.has(c.id)&&c.text!==undefined&&!locked.has(c.trackId)?applyCaptionAppearance(c,appearance):c)});};
  const split=()=>{
    const p=current.current;const targets=p.clips.filter(c=>(selected.length?selected.includes(c.id):timeRef.current>c.start&&timeRef.current<c.start+c.duration)&&!p.tracks.find(t=>t.id===c.trackId)?.locked);
    const nextSelected:string[]=[],splits=new Map<string,Clip[]>();let count=0;
    const clips=p.clips.flatMap(c=>{if(!targets.includes(c))return [c];const pieces=splitClip(c,timeRef.current);if(!pieces)return [c];count++;splits.set(c.id,pieces);nextSelected.push(pieces[1].id);return pieces;});
    if(clips.length>10000){notify('프로젝트당 최대 10,000개 클립을 지원합니다.','error');return;}if(count){try{change(splitMotionSources(p,clips,splits));setSelected(nextSelected);}catch(e){fail(e);}}else notify('클립 안쪽에 플레이헤드를 놓고 분할하세요.');
  };
  const remove=(useRipple=false)=>{
    const p=current.current,ids=new Set(selected),removed=p.clips.filter(c=>ids.has(c.id)&&!p.tracks.find(t=>t.id===c.trackId)?.locked);
    if(!removed.length)return;
    const removedIds=new Set(removed.map(c=>c.id)),intervalsByTrack=new Map<string,number[][]>();
    if(useRipple){for(const c of removed){const list=intervalsByTrack.get(c.trackId)||[];list.push([c.start,c.start+c.duration]);intervalsByTrack.set(c.trackId,list);}for(const [id,ranges] of intervalsByTrack){ranges.sort((a,b)=>a[0]-b[0]);const merged:number[][]=[];for(const range of ranges){const last=merged.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else merged.push([...range]);}let total=0;for(const range of merged){total+=range[1]-range[0];range[2]=total;}intervalsByTrack.set(id,merged);}}
    const clips=p.clips.filter(c=>!removedIds.has(c.id)).map(c=>{
      if(!useRipple||p.tracks.find(t=>t.id===c.trackId)?.locked)return c;
      const ranges=intervalsByTrack.get(c.trackId)||[];let lo=0,hi=ranges.length;while(lo<hi){const mid=(lo+hi)>>>1;if(ranges[mid][1]<=c.start+.0001)lo=mid+1;else hi=mid;}const shift=lo?ranges[lo-1][2]:0;return shift?{...c,start:Math.max(0,c.start-shift)}:c;
    });change({...p,clips});setSelected([]);
  };
  const duplicate=()=>{try{const p=current.current,source=p.clips.filter(c=>selected.includes(c.id)&&!p.tracks.find(t=>t.id===c.trackId)?.locked);if(!source.length)return;const span=Math.max(...source.map(c=>c.start+c.duration))-Math.min(...source.map(c=>c.start)),ids=new Map(source.map(c=>[c.id,uid()])),added=copyMotionBindings(p,source.map(c=>({...structuredClone(c),id:ids.get(c.id)!,start:c.start+span})),ids,span);if(added.length+p.clips.length>10000||added.some(c=>c.start+c.duration>86400)){notify('클립 수 또는 타임라인 길이 제한을 넘을 수 없습니다.','error');return;}change({...p,clips:[...p.clips,...added],transitions:[...(p.transitions||[]),...copyTransitions(p.transitions,ids,uid)]});setSelected(added.map(c=>c.id));}catch(error){fail(error);}};
  const copyClips=(verb='복사했습니다'):boolean=>{const p=current.current,clips=p.clips.filter(c=>selected.includes(c.id)).map(c=>structuredClone(c));if(!clips.length)return false;const ids=new Set(clips.map(c=>c.id));clipboard.current={clips:copyMotionBindings(p,clips,new Map(),0),fps:p.fps,motionPaths:structuredClone((p.motionPaths||[]).filter(a=>clips.some(c=>c.motionBinding?.analysisId===a.id))),colorLuts:(p.colorLuts||[]).filter(l=>clips.some(c=>c.colorGrade?.lutId===l.id)),transitions:structuredClone((p.transitions||[]).filter(t=>ids.has(t.fromClipId)&&ids.has(t.toClipId)))};notify(`${clips.length}개 클립을 ${verb}.`);return true;};
  const copy=()=>{copyClips();};
  const cutClips=()=>{if(copyClips('잘라냈습니다'))remove(ripple);};
  const paste=()=>{try{const p=current.current,source=clipboard.current.clips.filter(c=>p.tracks.some(t=>t.id===c.trackId&&!t.locked));if(!source.length)return;if(source.some(c=>!clipMediaAvailable(c,p.media))){notify('복사한 클립의 원본 미디어가 없습니다. 미디어 삭제를 취소한 뒤 붙여넣으세요.','error');return;}const first=Math.min(...source.map(c=>c.start)),ids=new Map(source.map(c=>[c.id,uid()])),clips=copyMotionBindings(p,source.map(c=>({...structuredClone(c),id:ids.get(c.id)!,start:timeRef.current+c.start-first})),ids,timeRef.current-first);if(clips.length+p.clips.length>10000||clips.some(c=>c.start+c.duration>86400)){notify('클립 수 또는 타임라인 길이 제한을 넘을 수 없습니다.','error');return;}change({...restoreMotionPaths(restoreColorLuts(p,clips,clipboard.current.colorLuts),clips,clipboard.current.motionPaths),clips:[...p.clips,...clips],transitions:[...(p.transitions||[]),...copyTransitions(clipboard.current.transitions,ids,uid,clipboard.current.fps,p.fps)]});setSelected(clips.map(c=>c.id));}catch(error){fail(error);}};
  const detachAudio=()=>{if(current.current.clips.length>=10000){notify('프로젝트당 최대 10,000개 클립을 지원합니다.','error');return;}const p=current.current,c=p.clips.find(v=>v.id===selected[0]),m=p.media.find(v=>v.id===c?.mediaId);if(!c||!m?.hasAudio||p.tracks.find(t=>t.id===c.trackId)?.locked)return;let track=p.tracks.find(t=>t.type==='audio'&&!t.locked);
    if(!track){
      if(p.tracks.length>=100){notify('프로젝트당 최대 100개 트랙을 지원합니다.','error');return;}
      track={id:uid(),type:'audio',name:'분리한 오디오',muted:false,hidden:false,locked:false};
    }
    const audio={...c,id:uid(),trackId:track.id,name:`${c.name} · 오디오`};change({...p,tracks:p.tracks.some(t=>t.id===track!.id)?p.tracks:[...p.tracks,track],clips:[...p.clips.map(v=>v.id===c.id?{...v,volume:0}:v),audio]});setSelected([audio.id]);notify('오디오를 독립 트랙으로 분리했습니다.');};
  const applyEffect=(preset:Clip['preset'])=>{const p=current.current,targets=p.clips.filter(c=>selected.includes(c.id)&&c.text===undefined&&p.media.find(m=>m.id===c.mediaId)?.kind!=='audio'&&!p.tracks.find(t=>t.id===c.trackId)?.locked);if(!targets.length){notify('먼저 타임라인의 영상 클립을 선택하세요.');return;}change({...p,clips:p.clips.map(c=>targets.includes(c)?{...c,preset}:c)});};
  const transformClip=(id:string,values:TransformPatch,time=timeRef.current)=>{const p=current.current,c=p.clips.find(v=>v.id===id);if(!c||p.tracks.find(t=>t.id===c.trackId)?.locked)return;const limits:Record<string,[number,number]>={x:[-16384,16384],y:[-16384,16384],scale:[.01,8],rotation:[-3600,3600]},next=Object.fromEntries(Object.entries(values).filter(([key,v])=>limits[key]&&Number.isFinite(v)).map(([key,v])=>[key,clamp(v as number,limits[key][0],limits[key][1])])) as TransformPatch;if(!Object.keys(next).length)return;const local=clamp(frameTime(time-c.start,p.fps),0,c.duration),patch=c.keyframes.length?{keyframes:[...c.keyframes.filter(k=>Math.abs(k.time-local)>.5/p.fps),{...keyframeBase(c,local,.5/p.fps),...next}].sort((a,b)=>a.time-b.time)}:next;change({...p,clips:p.clips.map(v=>v.id===id?{...v,...patch}:v)},false);};
  /** CapCut Q / W: delete the part of the selected clips (or of every clip under the playhead)
   * before or after the playhead. With ripple on, the track closes the space. */
  const trimAtPlayhead=(side:'left'|'right')=>{
    const p=current.current,t=timeRef.current,splits=new Map<string,Clip[]>(),shifts:{trackId:string;from:number;by:number}[]=[];
    for(const c of p.clips){
      if((selected.length&&!selected.includes(c.id))||p.tracks.find(track=>track.id===c.trackId)?.locked)continue;
      const pieces=splitClip(c,t);if(!pieces)continue;
      const kept=side==='left'?{...pieces[1],id:c.id,...(ripple?{start:c.start}:{})}:pieces[0];splits.set(c.id,[kept]);
      if(ripple)shifts.push({trackId:c.trackId,from:c.start+c.duration,by:side==='left'?t-c.start:c.start+c.duration-t});
    }
    if(!splits.size){notify('클립 안쪽에 플레이헤드를 놓으세요.');return;}
    const clips=p.clips.map(c=>{const kept=splits.get(c.id)?.[0];if(kept)return kept;const by=shifts.filter(s=>s.trackId===c.trackId&&c.start>=s.from-1e-6).reduce((sum,s)=>sum+s.by,0);return by?{...c,start:Math.max(0,c.start-by)}:c;});
    try{change(splitMotionSources(p,clips,splits));if(side==='left'&&ripple)seek(Math.min(...[...splits.values()].map(([c])=>c.start)));}catch(error){fail(error);}
  };
  /** ↑ / ↓: the previous or next clip boundary. */
  const editPoint=(direction:-1|1)=>{const p=current.current,t=timeRef.current,points=[0,projectDuration(p),...p.clips.flatMap(c=>[c.start,c.start+c.duration])];const target=direction<0?Math.max(...points.filter(x=>x<t-1e-6)):Math.min(...points.filter(x=>x>t+1e-6));if(Number.isFinite(target))seek(target);};
  const nudge=(frames:number)=>{const p=current.current,movable=p.clips.filter(c=>selected.includes(c.id)&&!p.tracks.find(t=>t.id===c.trackId)?.locked);if(!movable.length)return;const delta=boundedNudgeDelta(movable,frames,p.fps);if(!delta)return;change({...p,clips:p.clips.map(c=>movable.includes(c)?{...c,start:c.start+delta}:c)});};

  const save=async(saveAs=false)=>{const session=projectSession.current,intent=++saveIntent.current;try{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();const snapshot=current.current;const path=await window.studio.saveProject(snapshot,projectPath,saveAs);if(path&&session===projectSession.current&&intent===saveIntent.current){setProjectPath(path);setSavedStamp(snapshot.updatedAt);notify('프로젝트를 저장했습니다.');}}catch(e){if(session===projectSession.current&&intent===saveIntent.current)fail(e);}};
  const collect=async()=>{try{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();const result=await window.studio.collectProject(current.current);if(result)setJobsOpen(true);}catch(error){fail(error);}};
  const leaveAllowed=()=>!dirty||!(project.clips.length||project.media.length)||window.confirm('저장하지 않은 변경 사항이 있습니다. 현재 프로젝트를 닫고 계속할까요? 프로젝트 파일로 보관하려면 취소한 뒤 Ctrl+S로 저장하세요.');
  const open=async()=>{if(!leaveAllowed())return;const intent=++loadIntent.current,snapshot=editSnapshot(current.current);try{const result=await window.studio.openProject();if(intent!==loadIntent.current)return;if(result){if(editSnapshot(current.current)!==snapshot){notify('프로젝트를 여는 동안 현재 작업이 변경되어 열기를 적용하지 않았습니다.');return;}reset(result.project);setProjectPath(result.path);setSavedStamp(result.modified?'':result.project.updatedAt);setSourceMedia(null);setSelected([]);seek(0);if(result.missing.length)notify(`원본 미디어 ${result.missing.length}개를 찾지 못했습니다. 경로를 확인하세요.`,'error');else notify('프로젝트를 열었습니다.');}}catch(e){if(intent===loadIntent.current)fail(e);}};
  const create=()=>{if(!leaveAllowed())return;const p=newProject();reset(p);setProjectPath(undefined);setSavedStamp(p.updatedAt);setSourceMedia(null);setSelected([]);seek(0);setTab('media');};
  const showRecoveries=async()=>{try{setRecoveries(await window.studio.listRecoveries());setModal('recoveries');}catch(e){fail(e);}};
  const loadArchived=async(id:string)=>{if(!leaveAllowed())return;const intent=++loadIntent.current,snapshot=editSnapshot(current.current);try{const p=await window.studio.loadRecovery(id);if(intent!==loadIntent.current)return;if(p){if(editSnapshot(current.current)!==snapshot){notify('복구본을 여는 동안 현재 작업이 변경되어 열기를 적용하지 않았습니다.');return;}reset(p);setProjectPath(undefined);setSavedStamp('');setSourceMedia(null);setSelected([]);seek(0);setModal(null);}}catch(e){if(intent===loadIntent.current)fail(e);}};
  const importSubtitles=async()=>{try{const cues=await window.studio.importSubtitles();if(!cues?.length)return;const p=current.current,track:Track={id:uid(),name:'가져온 자막',type:'text',muted:false,hidden:false,locked:false},clips=cuesToClips(cues,track.id,p);if(p.clips.length+clips.length>10000||p.tracks.length>=100)throw new Error('자막을 추가하면 최대 클립 수(10,000개) 또는 트랙 수(100개)를 넘습니다.');if(clips.some(c=>c.start+c.duration>86400))throw new Error('자막 시간은 24시간 이내여야 합니다.');change({...p,tracks:[...p.tracks,track],clips:[...p.clips,...clips]});setSelected(clips.length?[clips[0].id]:[]);setTab('captions');notify(`${clips.length}개 자막을 가져왔습니다.`);}catch(e){fail(e);}};
  const exportSubtitles=async()=>{try{const path=await window.studio.exportSubtitles(toCues(current.current));if(path)notify('SRT 자막을 저장했습니다.');}catch(e){fail(e);}};
  const captureJob=(source?:MediaAsset,clip?:Clip):EditorJobContext=>{const p=current.current;if(!matchesMediaSource(p,source))throw new Error('원본이 변경되었습니다. 클립을 다시 선택해 실행하세요.');return {projectId:p.id,session:projectSession.current,source:source?structuredClone(source):undefined,clip:clip?structuredClone(clip):undefined,clipMedia:clip?structuredClone(p.media.find(m=>m.id===clip.mediaId)):undefined};};
  const startProxy=async(media?:MediaAsset)=>{const p=current.current,m=media?p.media.find(m=>m.id===media.id):p.media.find(m=>m.id===p.clips.find(c=>c.id===selected[0])?.mediaId);if(!m||m.kind!=='video')return;try{const context=captureJob(m),result=await window.studio.generateProxy(m);jobContexts.current.set(result.jobId,context);setJobsOpen(true);}catch(e){fail(e);}};
  const showTranscribe=()=>{const p=current.current,c=p.clips.find(c=>selected.includes(c.id)),media=p.media.find(m=>m.id===c?.mediaId);if(!c||!media||(!media.hasAudio&&media.kind!=='audio')){notify('먼저 음성이 있는 영상 또는 오디오 클립을 선택하세요.');return;}setTranscribeTarget({clip:c,media});setModal('transcribe');};
  const showStabilize=()=>{try{const p=current.current,clip=p.clips.find(c=>c.id===selected[0]);if(!clip||p.tracks.find(t=>t.id===clip.trackId)?.locked)return;setStabilizeTarget({clip:structuredClone(clip),...stabilizationSource(p,clip)});setModal('stabilize');}catch(error){fail(error);}};
  const showCutout=()=>{try{const p=current.current,clip=p.clips.find(c=>c.id===selected[0]);if(!clip||p.tracks.find(t=>t.id===clip.trackId)?.locked)return;setPlaying(false);setCutoutTarget({clip:structuredClone(clip),session:projectSession.current,...cutoutSource(p,clip)});setModal('cutout');}catch(error){fail(error);}};
  const startCutout=async(options:Pick<PersonCutoutOptions,'device'|'quality'>)=>{
    const target=cutoutTarget;if(!target||cutoutStarting.current.has(target.clip.id))return;
    try{
      const p=current.current,clip=p.clips.find(c=>c.id===target.clip.id);
      if(target.session!==projectSession.current||!clip||!sameSourceInterval(clip,target.clip)||!matchesMediaSource(p,target.media)||p.tracks.find(t=>t.id===clip.trackId)?.locked)throw new Error('프로젝트 또는 클립이 변경되었습니다. 배경 제거를 다시 여세요.');
      if([...jobContexts.current.values()].some(c=>c.cutout&&c.session===projectSession.current&&c.clip?.id===clip.id))return;
      cutoutStarting.current.add(clip.id);const request=cutoutSource(p,clip),context={...captureJob(request.media,clip),cutout:{quality:options.quality??'portrait'}};
      const result=await window.studio.removePersonBackground(request.media,{...options,start:request.start,duration:request.duration});jobContexts.current.set(result.jobId,context);
      if(context.session===projectSession.current)setModal(null);setJobsOpen(true);
    }catch(error){fail(error);}finally{cutoutStarting.current.delete(target.clip.id);}
  };
  const undoCutout=()=>{try{change(p=>({...p,clips:p.clips.map(c=>c.id===selected[0]&&!p.tracks.find(t=>t.id===c.trackId)?.locked?restoreCutout(c):c)}));}catch(error){fail(error);}};
  const showEnhancement=()=>{try{
    const p=current.current,clip=p.clips.find(c=>c.id===selected[0]);if(!clip||p.tracks.find(t=>t.id===clip.trackId)?.locked)return;
    const source=enhancementSource(p,clip);setPlaying(false);setEnhancementTarget({clip:structuredClone(clip),session:projectSession.current,previewStart:clipSourceTime(clip,clamp(timeRef.current-clip.start,0,clip.duration)),...source});setModal('enhance');
  }catch(error){fail(error);}};
  const validateEnhancement=()=>{
    const target=enhancementTarget,p=current.current,clip=p.clips.find(c=>c.id===target?.clip.id);
    if(!target||target.session!==projectSession.current||!clip||!sameSourceInterval(clip,target.clip)||!matchesMediaSource(p,target.media)||p.tracks.find(t=>t.id===clip.trackId)?.locked)throw new Error('프로젝트 또는 클립이 변경되었습니다. 화질 향상을 다시 여세요.');
    return clip;
  };
  const startEnhancement=async(scale:2|4)=>{
    const clip=validateEnhancement();if(enhancementStarting.current.has(clip.id))return;
    if([...jobContexts.current.values()].some(c=>c.enhancement&&c.session===projectSession.current&&c.clip?.id===clip.id))throw new Error('이 클립의 화질 향상이 진행 중입니다.');
    enhancementStarting.current.add(clip.id);
    try{
      const request=enhancementSource(current.current,clip),context={...captureJob(request.media,clip),enhancement:{scale}};
      const result=await window.studio.enhanceMedia(request.media,{start:request.start,duration:request.duration,scale});
      jobContexts.current.set(result.jobId,context);
      setJobsOpen(true);
      const early=earlyEnhancementEvents.current.get(result.jobId);earlyEnhancementEvents.current.delete(result.jobId);
      if(early)handleJob.current(early);
    }finally{enhancementStarting.current.delete(clip.id);if(!enhancementStarting.current.size)earlyEnhancementEvents.current.clear();}
  };
  const undoEnhancement=()=>{try{change(p=>({...p,clips:p.clips.map(c=>c.id===selected[0]&&!p.tracks.find(t=>t.id===c.trackId)?.locked?restoreEnhancement(c):c)}));}catch(error){fail(error);}};
  const showFreeze=()=>{try{const p=current.current,target=planFreeze(p,selected[0],frameTime(timeRef.current,p.fps),Math.round(3*p.fps)/p.fps);setPlaying(false);seek(target.at);setFreezeTarget(structuredClone(target));setModal('freeze');}catch(error){fail(error);}};
  const startCombine=async()=>{try{const p=current.current,plan=planCombination(p,selected),clips=structuredClone(p.clips.filter(c=>plan.ids.includes(c.id)));setPlaying(false);const context={...captureJob(),combine:{plan,clips}},result=await window.studio.combineClips(p,plan.ids);jobContexts.current.set(result.jobId,context);setJobsOpen(true);}catch(error){fail(error);}};
  const uncombine=(clipId=selected[0])=>{try{const result=uncombineClip(current.current,clipId);change(result.project);setSelected(result.ids);notify('합친 클립을 원래 클립으로 풀었습니다.');}catch(error){fail(error);}};
  const combineBusy=jobs.some(job=>job.type==='combine'&&job.status==='running');
  const reverseStarting=useRef(new Set<string>());
  const startReverse=async()=>{const p=current.current,clip=p.clips.find(c=>c.id===selected[0]);if(!clip||p.tracks.find(t=>t.id===clip.trackId)?.locked)return;try{
    if(reverseStarting.current.has(clip.id)||[...jobContexts.current.values()].some(c=>c.reverse&&c.session===projectSession.current&&c.clip?.id===clip.id))return;
    reverseStarting.current.add(clip.id);const request=reversalSource(p,clip),context={...captureJob(request.media,clip),reverse:true};setPlaying(false);
    const result=await window.studio.reverseMedia(request.media,{start:request.start,duration:request.duration});jobContexts.current.set(result.jobId,context);setJobsOpen(true);
  }catch(error){fail(error);}finally{reverseStarting.current.delete(clip.id);}};
  const undoReversal=()=>{try{change(p=>({...p,clips:p.clips.map(c=>c.id===selected[0]&&!p.tracks.find(t=>t.id===c.trackId)?.locked?restoreReversal(c):c)}));}catch(error){fail(error);}};
  const startFreeze=async(duration:number)=>{if(!freezeTarget)return;try{const target=freezeTarget,p=current.current,live=p.clips.find(c=>c.id===target.clip.id);if(JSON.stringify(live)!==JSON.stringify(target.clip))throw new Error('클립이 변경되었습니다. 정지 프레임을 다시 선택하세요.');const plan=planFreeze(p,target.clip.id,target.at,duration),context={...captureJob(plan.media,plan.clip),freeze:{at:plan.at,duration:plan.duration}},result=await window.studio.freezeFrame(plan.media,plan.sourceTime);jobContexts.current.set(result.jobId,context);if(context.session===projectSession.current)setModal(null);setJobsOpen(true);}catch(error){fail(error);}};
  const startStabilize=async(options:StabilizationOptions)=>{if(!stabilizeTarget)return;try{const target=stabilizeTarget,context={...captureJob(target.media,target.clip),stabilize:{source:structuredClone(target.media),start:target.start,options}},result=await window.studio.stabilizeMedia(target.media,{...options,start:target.start,duration:target.duration});jobContexts.current.set(result.jobId,context);if(context.session===projectSession.current)setModal(null);setJobsOpen(true);}catch(error){fail(error);}};
  const undoStabilization=()=>change(p=>({...p,clips:p.clips.map(c=>c.id===selected[0]&&!p.tracks.find(t=>t.id===c.trackId)?.locked?restoreStabilization(c):c)}));
  const installModel=async(model:SpeechModelId='base')=>{if(system?.speechModels?.some(m=>m.id===model&&m.installed)||(model==='base'&&system?.modelReady)){refreshSystem();notify('설치된 모델입니다.');return;}try{const result=await window.studio.installModel(model);setJobsOpen(true);return result;}catch(e){fail(e);}};
  const installSpeechEngine=async()=>{try{await window.studio.installSpeechEngine();setJobsOpen(true);}catch(e){fail(e);}};
  const startTranscribe=async(language:string,options:SpeechOptions)=>{if(!transcribeTarget)return;try{const {clip,media}=transcribeTarget,context=captureJob(media,clip),result=await window.studio.transcribe(media,language,{...options,start:clip.in,duration:Math.min(clipSourceSpan(clip),media.duration-clip.in)});jobContexts.current.set(result.jobId,context);if(context.session===projectSession.current)setModal(null);setJobsOpen(true);}catch(e){fail(e);}};
  const startExport=async(settings:ExportSettings)=>{try{const context=captureJob(),result=await window.studio.exportProject(current.current,settings);if(result){jobContexts.current.set(result.jobId,context);if(context.session===projectSession.current)setModal(null);setJobsOpen(true);}}catch(e){fail(e);}};
  useEffect(()=>{const onJob=(event:JobEvent)=>{
    if(event.type==='enhance'&&event.preview)return;
    if(event.status==='complete'&&event.media&&previewProxyPath(event.media)){mediaUpdates.current.set(event.media.path,event.media);previewReady(event.media);}
    setJobs(items=>{const index=items.findIndex(j=>j.id===event.id);if(index>=0)return items.map(j=>j.id===event.id?event:j);return [...items.slice(-19),event];});
    if(event.type==='range'){
      if(event.status==='running'&&!rangePanelTimers.current.has(event.id))rangePanelTimers.current.set(event.id,window.setTimeout(()=>{rangePanelTimers.current.set(event.id,0);setJobsOpen(true);},500));
      else if(event.status!=='running'){window.clearTimeout(rangePanelTimers.current.get(event.id));rangePanelTimers.current.delete(event.id);}
    }
    if(event.type==='enhance'&&event.status!=='running'&&!jobContexts.current.has(event.id)&&enhancementStarting.current.size){earlyEnhancementEvents.current.set(event.id,event);return;}
    if(event.status==='running'||handledJobs.current.has(event.id))return;handledJobs.current.add(event.id);
    const context=jobContexts.current.get(event.id);jobContexts.current.delete(event.id);
    if(event.type==='range')return;
    if(event.type==='track'&&trackingDialogJobs.current.delete(event.id))return;
    if(event.status==='error'){notify(event.message,'error',event.type==='proxy'?context?.source:undefined);setJobsOpen(true);return;}
    if(event.status==='cancelled'){notify('작업을 취소했습니다.');return;}
    if(event.type==='relink'){
      if(!context?.reconnect||context.projectId!==current.current.id||context.session!==projectSession.current){notify('프로젝트가 변경되어 추적 파일 연결을 적용하지 않았습니다.');return;}
      try{if(!event.trackingReconnect)throw new Error('복구한 추적 정보가 없습니다.');change(p=>applyTrackingReconnect(p,context.reconnect!,event.trackingReconnect!));setPlaying(false);setSeekId(n=>n+1);notify(event.message);}catch(error){fail(error);}return;
    }
    if(event.type==='track'){notify(event.message);return;}
    if(event.type==='collect'){notify(event.message);return;}
    if(event.type==='model'){refreshSystem();notify('음성 인식 모델이 준비되었습니다.');return;}
    if(event.type==='enhancement-install'){notify('화질 향상 엔진이 준비되었습니다.');return;}
    const projectJob=['proxy','stabilize','transcribe','freeze','reverse','cutout','enhance','combine'].includes(event.type);
    if(projectJob&&(!context||context.projectId!==current.current.id||context.session!==projectSession.current||!matchesMediaSource(current.current,context.source)||!matchesMediaSource(current.current,context.clipMedia))){notify('작업이 완료되었지만 프로젝트 또는 원본이 변경되어 적용하지 않았습니다.');return;}
    if(context&&context.projectId===current.current.id&&context.session===projectSession.current){
      if(event.media){
        if(event.type==='proxy'&&!matchesMediaSource(current.current,event.media)){notify('원본이 변경되어 이전 프록시를 적용하지 않았습니다.');return;}
        const p=current.current,known=p.media.find(m=>m.id===event.media!.id||m.path===event.media!.path),m=known?mergeAsset(known,event.media):event.media;
        if(!known&&p.media.length>=2000){notify('미디어는 최대 2,000개까지 추가할 수 있습니다. 처리된 파일은 작업의 폴더에서 확인하세요.','error');return;}
        const media=known?p.media.map(asset=>asset.id===known.id?m:asset):[...p.media,m];
        if(event.type==='freeze'&&context?.clip&&context.freeze){
          const target=p.clips.find(c=>c.id===context.clip!.id);
          try{if(JSON.stringify(target)!==JSON.stringify(context.clip))throw new Error('처리 중 클립이 변경되었습니다.');const result=insertFreeze(p,context.clip.id,context.freeze.at,context.freeze.duration,m);change(result.project);setSelected([result.clip.id]);seek(result.clip.start);}
          catch(error){change({...p,media});notify(`${humanError(error)} 정지 프레임은 보관함에 추가했습니다.`);return;}
        }else if(event.type==='enhance'&&context?.clip&&context.enhancement){
          const target=p.clips.find(c=>c.id===context.clip!.id),canApply=target&&sameSourceInterval(target,context.clip)&&!p.tracks.find(t=>t.id===target.trackId)?.locked;
          change({...p,media,clips:canApply?p.clips.map(c=>c.id===target.id?applyEnhancement(c,m,context.enhancement!.scale):c):p.clips});
          if(!canApply){notify('클립이 변경되었거나 잠겨 화질 향상 결과를 보관함에만 추가했습니다.');return;}
        }else if(event.type==='cutout'&&context?.clip&&context.cutout){
          const target=p.clips.find(c=>c.id===context.clip!.id),canApply=target&&sameSourceInterval(target,context.clip)&&!p.tracks.find(t=>t.id===target.trackId)?.locked;
          change({...p,media,clips:canApply?p.clips.map(c=>c.id===target.id?applyCutout(c,m,context.cutout!):c):p.clips});
          if(!canApply){notify('클립이 변경되었거나 잠겨 배경 제거 결과를 보관함에만 추가했습니다.');return;}
        }else if(event.type==='combine'&&context?.combine){
          try{const result=applyCombination({...p,media},context.combine.plan,context.combine.clips,m);change(result.project);setSelected([result.clip.id]);seek(result.clip.start);}
          catch(error){change({...p,media});notify(`${humanError(error)} 합친 결과는 보관함에 추가했습니다.`);return;}
        }else if(event.type==='reverse'&&context?.clip&&context.reverse){
          const target=p.clips.find(c=>c.id===context.clip!.id),canApply=target&&sameSourceInterval(target,context.clip)&&!p.tracks.find(t=>t.id===target.trackId)?.locked;
          change({...p,media,clips:canApply?p.clips.map(c=>c.id===target.id?applyReversal(c,m):c):p.clips});
          if(!canApply){notify('클립이 변경되었거나 잠겨 역재생 결과를 보관함에만 추가했습니다.');return;}
        }else if(event.type==='stabilize'&&context?.clip&&context.stabilize){
          const target=p.clips.find(c=>c.id===context.clip!.id),canApply=target&&sameSourceInterval(target,context.clip)&&!p.tracks.find(t=>t.id===target.trackId)?.locked;
          const data=context.stabilize;
          change({...p,media,clips:canApply?p.clips.map(c=>c.id===target.id?applyStabilization(c,m,data.source,data.start,data.options):c):p.clips});
          if(!canApply){notify('클립이 변경되었거나 잠겨 보정 결과를 보관함에만 추가했습니다.');return;}
        }else change({...p,media},false);
      }
      if(event.cues&&context?.clip){try{
        const p=current.current,source=p.clips.find(c=>c.id===context.clip!.id);
        if(!source||!sameSourceInterval(source,context.clip)||p.tracks.find(t=>t.id===source.trackId)?.locked){notify('인식 중 클립 구간이 변경되었거나 잠겨 자막을 적용하지 않았습니다. 다시 실행해 주세요.');return;}
        const filtered=sourceCuesToTimeline(source,event.cues),track:Track={id:uid(),name:'자동 자막',type:'text',muted:false,hidden:false,locked:false},clips=cuesToClips(filtered,track.id,p,0,{start:source.start,end:Math.min(86400,source.start+source.duration)});
        if(clips.length){if(p.clips.length+clips.length>10000||p.tracks.length>=100){notify('자막을 추가하면 최대 클립 수(10,000개) 또는 트랙 수(100개)를 넘습니다.','error');return;}change({...p,tracks:[...p.tracks,track],clips:[...p.clips,...clips]});setTab('captions');setSelected([clips[0].id]);}else notify('선택한 구간에서 인식된 음성이 없습니다.');
      }catch(error){notify(humanError(error),'error');return;}}
    }
    notify(event.type==='enhance'?'화질 향상을 적용했습니다.':event.type==='cutout'?'배경 제거를 적용했습니다.':event.type==='export'?'영상 내보내기가 완료되었습니다.':event.type==='proxy'?'미리보기 프록시를 만들었습니다.':event.type==='stabilize'?'흔들림 보정이 완료되었습니다.':event.type==='freeze'?'정지 프레임을 삽입했습니다.':event.type==='reverse'?'역재생을 적용했습니다.':event.type==='combine'?'선택한 클립을 하나로 합쳤습니다.':'자동 자막 생성이 완료되었습니다.');
  };handleJob.current=onJob;return window.studio?.onJob(onJob);},[change,current,notify,refreshSystem,previewReady]);

  useEffect(()=>{
    const handler=(e:KeyboardEvent)=>{
      const ctrl=e.ctrlKey||e.metaKey,key=e.key.toLowerCase();
      if(modal||recovery)return;
      if(ctrl&&key==='s'){e.preventDefault();void save(e.shiftKey);return;}
      if(ctrl&&key==='o'){e.preventDefault();void open();return;}
      if(inputTarget(e.target))return;
      if(ctrl&&key==='n'){e.preventDefault();create();return;}
      if(ctrl&&key==='i'){e.preventDefault();void importAssets();return;}
      if(ctrl&&key==='e'){e.preventDefault();if(project.clips.length){setPlaying(false);setModal('export');}return;}
      if(ctrl&&key==='z'){e.preventDefault();setPlaying(false);e.shiftKey?redo():undo();return;}
      if(ctrl&&key==='y'){e.preventDefault();redo();return;}
      if(ctrl&&key==='d'){e.preventDefault();duplicate();return;}
      // CapCut: Alt+G compound clip, Alt+Shift+G undo it. Ctrl+G stays as an alias.
      if((ctrl||e.altKey)&&key==='g'){e.preventDefault();if(e.shiftKey){if(project.clips.find(c=>c.id===selected[0])?.compound)uncombine();}else if(selected.length&&!combineBusy)void startCombine();return;}
      if(ctrl&&key==='c'){e.preventDefault();copy();return;}
      if(ctrl&&key==='x'){e.preventDefault();cutClips();return;}
      if(ctrl&&key==='v'){e.preventDefault();paste();return;}
      if(ctrl&&key==='a'){e.preventDefault();setSelected(project.clips.filter(c=>!project.tracks.find(t=>t.id===c.trackId)?.locked).map(c=>c.id));return;}
      if(monitorMode==='source')return;
      if(e.altKey&&(key==='arrowleft'||key==='arrowright')){e.preventDefault();nudge((key==='arrowleft'?-1:1)*(e.shiftKey?10:1));return;}
      if(key==='m'&&!ctrl){e.preventDefault();change(p=>({...p,markers:[...(p.markers||[]),{id:uid(),time:frameTime(timeRef.current,p.fps),label:`마커 ${(p.markers?.length||0)+1}`,color:'#e6bc61'}]}));return;}
      if(key===' '){e.preventDefault();play();return;}
      if(ctrl&&key==='b'){e.preventDefault();split();return;}
      if(!ctrl&&!e.altKey&&(key==='q'||key==='w')){e.preventDefault();trimAtPlayhead(key==='q'?'left':'right');return;}
      if(!e.altKey&&(key==='arrowup'||key==='arrowdown')){e.preventDefault();editPoint(key==='arrowup'?-1:1);return;}
      if(key==='s'&&!ctrl){e.preventDefault();split();return;}
      if(key==='delete'||key==='backspace'){e.preventDefault();if(selectedTransitionId)removeTransition(selectedTransitionId);else remove(e.shiftKey||ripple);return;}
      if(key==='arrowleft'||key==='arrowright'){e.preventDefault();seek(timeRef.current+(key==='arrowleft'?-1:1)*(e.shiftKey?1:1/project.fps));return;}
      if(key==='home'){e.preventDefault();seek(0);return;}
      if(key==='end'){e.preventDefault();seek(projectDuration(project));return;}
      if(key==='escape'){setSelected([]);setFileMenu(false);}
      if(key==='?'||key==='f1'){e.preventDefault();setModal('shortcuts');}
    };
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);
  });
  const running=jobs.filter(j=>j.status==='running').length;
  const closeModal=useCallback(()=>setModal(null),[]);
  const showTracking=()=>{try{const target=planTracking(current.current,selected[0],timeRef.current);setPlaying(false);setTrackingTarget({target,session:projectSession.current,id:uid()});setModal('track');}catch(e){fail(e);}};
  const reconnectTracking=async()=>{
    if(reconnectPicker.current)return;reconnectPicker.current=true;setReconnectStarting(true);
    try{const p=current.current,target=planTrackingReconnect(p,selected[0]),context={...captureJob(p.media.find(m=>m.id===target.media.id)),reconnect:target},result=await window.studio.reconnectTracking(p,target.analysis.id);
      if(result){jobContexts.current.set(result.jobId,context);if(context.session!==projectSession.current)void window.studio.cancelJob(result.jobId).catch(fail);else setJobsOpen(true);}
    }catch(error){fail(error);}finally{reconnectPicker.current=false;setReconnectStarting(false);}
  };
  const validateTracking=()=>{if(!trackingTarget||trackingTarget.session!==projectSession.current)throw new Error('프로젝트가 변경되었습니다.');validateTrackingTarget(current.current,trackingTarget.target);};
  const applyTrackingResult=async(value:TrackingApply)=>{validateTracking();const result=applyTracking(current.current,trackingTarget!.target,value);change(result.project);setSelected([result.clip.id]);seek(result.time);setModal(null);};
  const removeTracking=async(reset=false)=>{const p=current.current,c=p.clips.find(c=>c.id===selected[0]),b=c?.motionBinding,a=p.motionPaths?.find(a=>a.id===b?.analysisId),session=projectSession.current;if(!c||!b||!a)return;const time=clamp(timeRef.current,c.start,c.start+c.duration-.000001);try{const sample=reset?undefined:(await window.studio.readTrackingPath(a.path,bindingTime(p,b,a,time),1)).samples[0];if(session!==projectSession.current||p.id!==current.current.id||JSON.stringify(current.current.clips.find(v=>v.id===c.id))!==JSON.stringify(c))throw new Error('클립 또는 프로젝트가 변경되었습니다.');change(detachMotion(current.current,c.id,time,sample));seek(time);}catch(e){fail(e);}};
  if(!window.studio)return <div className="browser-fallback"><h1>SLU Studio</h1><p>데스크톱 앱에서 실행하세요. Windows 실행 파일 또는 npm run dev로 열 수 있습니다.</p></div>;
  return <div className="app-shell" style={{'--timeline-height':`${timelineHeight}px`} as React.CSSProperties} onDragOver={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();}} onDragEnter={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();setDraggingFiles(true);}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDraggingFiles(false);}} onDrop={e=>{e.preventDefault();setDraggingFiles(false);if(e.dataTransfer.files.length){const paths=[...e.dataTransfer.files].map(f=>window.studio.getPathForFile(f)).filter(Boolean);if(paths.length)void importAssets(paths);}}}>
    <header className="app-header"><div className="brand"><img className="brand-mark" src={new URL('./assets/studio-icon.svg',import.meta.url).href} alt=""/><strong>SLU Studio</strong><span className="brand-version" aria-label="앱 버전">v{system?.version||buildVersion}</span></div><div className="header-divider"/><div className="dropdown-wrap"><button className="text-button file-menu-button" onClick={()=>setFileMenu(v=>!v)}>프로젝트<ChevronDown size={13}/></button>{fileMenu&&<><div className="dropdown-dismiss" onClick={()=>setFileMenu(false)}/><div className="dropdown project-menu"><button onClick={()=>{setFileMenu(false);create();}}><FilePlus2 size={15}/>새 프로젝트<kbd>Ctrl N</kbd></button><button onClick={()=>{setFileMenu(false);void open();}}><FolderOpen size={15}/>프로젝트 열기<kbd>Ctrl O</kbd></button><button onClick={()=>{setFileMenu(false);void save();}}><Save size={15}/>저장<kbd>Ctrl S</kbd></button><button onClick={()=>{setFileMenu(false);void save(true);}}><Save size={15}/>다른 이름으로 저장</button><button onClick={()=>{setFileMenu(false);void collect();}}><FolderOpen size={15}/>{"\uD504\uB85C\uC81D\uD2B8 \uBAA8\uC544 \uC800\uC7A5"}</button><button onClick={()=>{setFileMenu(false);void showRecoveries();}}><FolderOpen size={15}/>복구 기록</button></div></>}</div><div className="project-title"><input aria-label="프로젝트 이름" value={project.name} maxLength={120} onChange={e=>change(p=>({...p,name:e.target.value}),true,{coalesce:e.currentTarget})}/><span title={projectPath||'아직 프로젝트 파일로 저장하지 않았습니다'} className={dirty?'unsaved':''}>{importing?<><LoaderCircle size={10} className="spin"/>미디어 분석 중</>:autoSaved?<><Check size={10}/>자동 저장됨</>:<>● {dirty?'변경 사항 있음':'새 프로젝트'}</>}</span></div><div className="header-actions"><div className="undo-buttons"><button className="icon-button" title="실행 취소 (Ctrl+Z)" disabled={!canUndo} onClick={()=>{setPlaying(false);undo();}}><Undo2 size={17}/></button><button className="icon-button" title="다시 실행 (Ctrl+Shift+Z)" disabled={!canRedo} onClick={()=>{setPlaying(false);redo();}}><Redo2 size={17}/></button></div><span className="header-divider"/><button className="icon-button" title="프로젝트 저장 (Ctrl+S)" onClick={()=>void save()}><Save size={17}/></button><button className="icon-button" title="키보드 단축키" onClick={()=>setModal('shortcuts')}><Keyboard size={18}/></button><button className="button primary export-button" title="내보내기 (Ctrl+E)" disabled={!project.clips.length} onClick={()=>{setPlaying(false);setModal('export');}}>내보내기<ArrowUpRight size={16}/></button></div></header>
    <main className="workspace"><Library onInsertCaption={insertCaptionAppearance} onApplyCaption={applyCaptionAppearanceToSelected} time={time} onUpdateCaptionWords={(id,words)=>{try{const clip=current.current.clips.find(c=>c.id===id);if(!clip||clip.text===undefined||current.current.tracks.find(t=>t.id===clip.trackId)?.locked)return false;if(words)assertCaptionWords(clip.text,words,0,clip.duration);change(p=>({...p,clips:p.clips.map(c=>c.id===id?{...c,captionWords:words}:c)}));return true;}catch(error){fail(error);return false;}}} onAddTransition={kind=>void addTransition(kind)} transitionCanAdd={!!cut&&!transitionBusy&&!project.tracks.find(t=>t.id===cut[0].trackId)?.locked} project={project} tab={tab} setTab={setTab} onImport={()=>void importAssets()} onAddMedia={addMedia} onSelectMedia={sourceSelect} activeMediaId={sourceMedia?.id} onCaptionEditStart={checkpoint} onUpdateCaption={(id,text)=>change(p=>({...p,clips:p.clips.map(c=>c.id===id&&!p.tracks.find(t=>t.id===c.trackId)?.locked?editCaptionText(c,text):c)}),false)} onAddText={addText} onImportSubtitles={()=>void importSubtitles()} onExportSubtitles={()=>void exportSubtitles()} onTranscribe={showTranscribe} onEffect={applyEffect} selected={selected} onSelect={id=>setSelected([id])} seek={seek} system={system} proxy={proxy} setProxy={setProxy} onInstallModel={()=>void installModel()} onHelp={runHelp} onRemoveMedia={id=>{if(project.clips.some(c=>clipMediaIds(c).includes(id))){notify('타임라인에서 사용 중인 미디어입니다. 클립을 먼저 삭제하세요.');return;}change(p=>({...p,media:p.media.filter(m=>m.id!==id)}));}} onProxy={m=>void startProxy(m)} onRefreshSystem={refreshSystem}/><div className="monitor-area"><div className="monitor-tabs"><button className={monitorMode==='timeline'?'active':''} onClick={()=>setMonitorMode('timeline')}>프로그램</button><button className={monitorMode==='source'?'active':''} disabled={!sourceMedia} onClick={()=>{setPlaying(false);setMonitorMode('source');}}>소스{sourceMedia?` · ${sourceMedia.name}`:''}</button></div><div className="monitor-program" style={{display:monitorMode==='timeline'?'flex':'none'}}><Preview active={monitorMode==='timeline'} seekId={seekId} onTimeUpdate={transportTime} onEnded={()=>setPlaying(false)} onTransformStart={at=>{if(playing)seek(at);else setPlaying(false);checkpoint();}} onTransform={transformClip} onDeselect={()=>setSelected([])} project={project} time={time} playing={playing} onPlay={play} onSeek={seek} onImport={()=>void importAssets()} selected={selected} onSelect={id=>setSelected([id])} proxy={proxy} onProxy={m=>void startProxy(m)} previewFailures={previewFailures} onMediaReady={previewReady} onError={(message,media)=>notify(message,'error',media)}/></div>{sourceMedia&&<div className="monitor-source" style={{display:monitorMode==='source'?'flex':'none'}}><SourceMonitor media={project.media.find(m=>m.id===sourceMedia.id)||sourceMedia} active={monitorMode==='source'&&!modal} proxy={proxy} fps={project.fps} onAdd={addSourceRange} onMediaReady={previewReady} preparationFailure={previewFailures[previewSourceKey(project.media.find(m=>m.id===sourceMedia.id)||sourceMedia)]?.message} onProxy={()=>void startProxy(project.media.find(m=>m.id===sourceMedia.id)||sourceMedia)}/></div>}</div><Inspector onUncombine={()=>uncombine()} selectedTransitionId={selectedTransitionId} onUpdateTransition={updateTransition} onRemoveTransition={removeTransition} project={project} change={change} checkpoint={checkpoint} selected={selected} time={time} system={system} onProxy={()=>void startProxy()} onTranscribe={showTranscribe} onDetach={detachAudio} onSeek={seek} onEnhance={showEnhancement} onRestoreEnhancement={undoEnhancement} enhancementBusy={jobs.some(j=>j.type==='enhance'&&j.status==='running'&&jobContexts.current.get(j.id)?.clip?.id===selected[0]&&jobContexts.current.get(j.id)?.session===projectSession.current)} onCutout={showCutout} onRestoreCutout={undoCutout} cutoutBusy={jobs.some(j=>j.type==='cutout'&&j.status==='running'&&jobContexts.current.get(j.id)?.clip?.id===selected[0]&&jobContexts.current.get(j.id)?.session===projectSession.current)} onStabilize={showStabilize} onFreeze={showFreeze} onTrack={showTracking} onDetachMotion={()=>void removeTracking()} onResetMotion={()=>void removeTracking(true)} onReconnectTracking={()=>void reconnectTracking()} reconnectBusy={reconnectStarting||jobs.some(j=>j.type==='relink'&&j.status==='running'&&jobContexts.current.get(j.id)?.reconnect?.analysis.id===project.clips.find(c=>c.id===selected[0])?.motionBinding?.analysisId)} onRestoreStabilization={undoStabilization} onReverse={()=>void startReverse()} onRestoreReversal={undoReversal} reverseBusy={jobs.some(j=>j.type==='reverse'&&j.status==='running'&&jobContexts.current.get(j.id)?.clip?.id===selected[0])}/></main>
    <div className="panel-divider" role="separator" aria-label="타임라인 높이 조절" onPointerDown={resizeTimeline}/>
    <Timeline onDropFiles={dropFiles} onCombine={()=>void startCombine()} onUncombine={uncombine} combineBusy={combineBusy} selectedTransitionId={selectedTransitionId} onSelectTransition={selectTransition} onAddTransition={(from,to,kind='dissolve')=>void addTransition(kind,from,to)} project={project} change={change} checkpoint={checkpoint} selected={selected} setSelected={ids=>{setSelected(ids);if(ids.length)setMonitorMode('timeline');}} time={time} seek={seek} addMedia={addMedia} addTrack={addTrack} split={split} remove={remove} duplicate={duplicate} copy={copy} detach={detachAudio} openSource={clip=>{const media=project.media.find(m=>m.id===clip.mediaId);if(media)sourceSelect(media);}} playing={playing} ripple={ripple} setRipple={setRipple} zoom={zoom} setZoom={setZoom}/>
    <footer className="status-bar"><span><i className="status-dot"/>{system?.encoders.some(v=>v.includes('nvenc'))?'NVIDIA NVENC':system?.hardwareAcceleration?'GPU 가속 활성화':'로컬 편집'}<span className="status-separator">·</span>{system?.gpu||'하드웨어 확인 중'}</span><div><button onClick={()=>setModal('shortcuts')}><CircleHelp size={11}/>단축키</button><button className={running?'active':''} onClick={()=>setJobsOpen(v=>!v)}>{running?<LoaderCircle size={12} className="spin"/>:<Activity size={12}/>}작업{running?` ${running}`:''}</button></div></footer>
    {modal==='track'&&trackingTarget&&<TrackingDialog key={trackingTarget.id} target={trackingTarget.target} project={project} onClose={closeModal} onValidate={validateTracking} onApply={applyTrackingResult} onJobStarted={id=>trackingDialogJobs.current.add(id)} onProxy={media=>void startProxy(media)}/>}
    {modal==='freeze'&&freezeTarget&&<FreezeDialog name={freezeTarget.media.name} sourceTime={freezeTarget.sourceTime} fps={project.fps} onClose={closeModal} onApply={startFreeze}/>}{modal==='cutout'&&cutoutTarget&&<CutoutDialog {...cutoutTarget} onClose={()=>setModal(null)} onApply={startCutout}/>}
    {modal==='enhance'&&enhancementTarget&&enhancementTarget.session===projectSession.current&&matchesMediaSource(project,enhancementTarget.media)&&<EnhancementDialog key={enhancementTarget.clip.id+'-'+enhancementTarget.session} {...enhancementTarget} media={project.media.find(m=>m.id===enhancementTarget.media.id)||enhancementTarget.media} onClose={closeModal} onValidate={validateEnhancement} onApply={startEnhancement} onPrepareSource={()=>void startProxy(enhancementTarget.media)}/>}
    {modal==='stabilize'&&stabilizeTarget&&<StabilizationDialog {...stabilizeTarget} onClose={closeModal} onApply={startStabilize}/>}{modal==='export'&&<ExportDialog project={project} system={system} onClose={closeModal} onExport={startExport}/>}{modal==='transcribe'&&transcribeTarget&&<TranscribeDialog {...transcribeTarget} system={system} modelBusy={jobs.some(j=>j.type==='model'&&j.status==='running')} onClose={closeModal} onInstall={model=>void installModel(model)} onInstallEngine={()=>void installSpeechEngine()} onTranscribe={startTranscribe}/>}{modal==='shortcuts'&&<ShortcutDialog onClose={closeModal} onHelp={runHelp}/>}
    {recovery&&<Modal title="작업을 이어서 할까요?" subtitle="이전 자동 저장 프로젝트가 있습니다." onClose={()=>setRecovery(null)}><div className="recovery-card"><FilmIcon/><div><h3>{recovery.name}</h3><p>{recovery.clips.length} 클립 · {recovery.media.length} 미디어</p><small>{new Date(recovery.updatedAt).toLocaleString('ko-KR')}</small></div></div><div className="modal-actions"><button className="button secondary" onClick={()=>setRecovery(null)}>새로 시작</button><button className="button primary" onClick={()=>{reset(recovery);setSavedStamp('');setRecovery(null);notify('자동 저장한 프로젝트를 복원했습니다.');}}>작업 이어서 열기</button></div></Modal>}
    {modal==='recoveries'&&<Modal title="복구 기록" onClose={closeModal}><div className="recovery-list">{recoveries.map(item=><button key={item.id} onClick={()=>void loadArchived(item.id)}><b>{item.name}</b><span>{new Date(item.updatedAt).toLocaleString('ko-KR')} · {item.clips} 클립</span></button>)}{!recoveries.length&&<p className="functional-note">저장된 복구 기록 없음</p>}</div><div className="modal-actions"><button className="button secondary" onClick={closeModal}>닫기</button></div></Modal>}
    {jobsOpen&&<JobsPanel jobs={jobs} onClose={()=>setJobsOpen(false)} onCancel={id=>{void window.studio.cancelJob(id).catch(fail);}} onReveal={path=>{void window.studio.showInFolder(path).catch(fail);}}/>}
    <div className="toast-stack" aria-live="polite">{toasts.map(t=><div className={`toast toast-${t.kind}`} key={t.id}>{t.kind==='error'?<span className="toast-error-mark">!</span>:<Check size={15}/>}<span>{t.text}</span><button title="알림 닫기" onClick={()=>setToasts(v=>v.filter(x=>x.id!==t.id))}><X size={13}/></button></div>)}</div>
    {draggingFiles&&<div className="drop-overlay"><div><FolderOpen size={35}/><h2>미디어를 여기에 놓으세요</h2><p>영상, 사진, 음악을 프로젝트로 가져옵니다. 아래 타임라인 트랙에 놓으면 그 위치에 바로 배치됩니다.</p></div></div>}
  </div>;
}

function FilmIcon(){return <div className="recovery-icon"><FolderOpen size={25}/></div>;}
