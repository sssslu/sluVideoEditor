import {useLayoutEffect,useRef,useState} from 'react';
import {Activity,AudioLines,ChartColumn,ChevronLeft,ChevronRight,Film,FolderPlus,Maximize2,Pause,Play,SkipBack,SkipForward,Volume2,VolumeX,X} from 'lucide-react';
import {needsPreviewProxy,previewSourceKey} from '../shared/media-clock';
import type {Keyframe,MediaAsset,Project} from '../shared/types';
import {projectDuration} from '../shared/project';
import {formatTime} from './editor';
import {clamp} from './preview/math';
import {PreviewRuntime,type PreviewStats} from './preview/runtime';
import type {Geometry} from './preview/renderer';
import {SNAP_DISTANCE,handleCursor,regionBounds,regionCenter,rotationTransform,scaleTransform,snapMove,snapRotation,sweepAngle,type Box,type Guide,type Handle,type Point} from './preview/transform-handles';
import './preview/gpu-preview.css';
import ScopePanel from './ScopePanel';
import type {ScopeResult} from '../shared/scopes';
import AudioMeter from './AudioMeter';
import {AudioMeterFeed} from './preview/audio-meter';

interface PreviewProps {active?:boolean;project:Project;time:number;playing:boolean;onPlay:()=>void;onSeek:(time:number)=>void;onImport:()=>void;selected:string[];onSelect:(id:string)=>void;proxy:boolean;onProxy:(media:MediaAsset)=>void;onError:(message:string,media?:MediaAsset)=>void;onMediaReady?:(media:MediaAsset)=>void;previewFailures?:Record<string,{message:string}>;seekId?:number;onTimeUpdate?:(time:number)=>void;onEnded?:()=>void;onTransformStart?:()=>void;onTransform?:(id:string,values:TransformPatch)=>void;onDeselect?:()=>void}
export type TransformPatch=Partial<Pick<Keyframe,'x'|'y'|'scale'|'rotation'>>;
interface DragState {id:string;pointer:number;mode:'move'|Handle;from:Point;last:Point;clientX:number;clientY:number;state:Keyframe;geometry:Geometry;bounds:Box;dragScale:number;started:boolean;angle:number}
interface Issue {media?:MediaAsset;message:string;preparation?:boolean}
export default function Preview(props:PreviewProps){
  const {active=true,project,time,playing,onPlay,onSeek,onImport,selected,onSelect,proxy,onProxy,seekId=0}=props;
  const panel=useRef<HTMLElement>(null),wrap=useRef<HTMLDivElement>(null),stage=useRef<HTMLDivElement>(null),overlay=useRef<HTMLCanvasElement>(null),runtime=useRef<PreviewRuntime|undefined>(undefined);
  const current=useRef(props);current.current=props;
  const [showScopes,setShowScopes]=useState(false),[scopeResult,setScopeResult]=useState<ScopeResult>(),[scopeError,setScopeError]=useState<string>();
  const [showAudioMeter,setShowAudioMeter]=useState(false),[audioFeed]=useState(()=>new AudioMeterFeed());
  const [size,setSize]=useState({width:640,height:360}),[quality,setQuality]=useState(()=>Number(localStorage.getItem('slu-preview-height'))||720),[muted,setMuted]=useState(false),[stats,setStats]=useState<PreviewStats>(),[showStats,setShowStats]=useState(false),[issues,setIssues]=useState<Issue[]>([]);
  const drag=useRef<DragState|undefined>(undefined);
  useLayoutEffect(()=>{const host=stage.current;if(!host)return;const engine=new PreviewRuntime(host,{onTime:value=>current.current.onTimeUpdate?.(value),onEnded:()=>current.current.onEnded?.(),onStats:setStats,onScopes:setScopeResult,onScopeError:setScopeError,onAudioLevels:frame=>audioFeed.publish(frame),onAudioMeterError:error=>audioFeed.publish(undefined,error),onMediaReady:media=>{setIssues(previous=>previous.some(item=>item.media&&previewSourceKey(item.media)===previewSourceKey(media))?previous.filter(item=>!item.media||previewSourceKey(item.media)!==previewSourceKey(media)):previous);current.current.onMediaReady?.(media);},onIssue:(media,message)=>{setIssues(previous=>[...previous.filter(item=>item.media?.id!==media?.id),{media,message}].slice(-3));current.current.onError(message,media);}},overlay.current??undefined);runtime.current=engine;(host as HTMLDivElement&{previewRuntime?:PreviewRuntime}).previewRuntime=engine;return()=>{engine.dispose();runtime.current=undefined;delete(host as HTMLDivElement&{previewRuntime?:PreviewRuntime}).previewRuntime;};},[audioFeed]);
  useLayoutEffect(()=>{runtime.current?.setProject(project);setIssues(previous=>{const remaining=previous.filter(item=>!item.media||project.clips.some(c=>c.mediaId===item.media!.id)&&project.media.some(media=>media.id===item.media!.id&&previewSourceKey(media)===previewSourceKey(item.media!)));return remaining.length===previous.length?previous:remaining;});},[project]);
  useLayoutEffect(()=>{runtime.current?.setOptions(proxy,quality,muted,selected);localStorage.setItem('slu-preview-height',String(quality));},[proxy,quality,muted,selected]);
  useLayoutEffect(()=>{runtime.current?.setTransport(time,playing,seekId);},[time,playing,seekId]);
  useLayoutEffect(()=>{setScopeError(undefined);runtime.current?.setScopes(showScopes&&active);},[showScopes,active]);
  useLayoutEffect(()=>{runtime.current?.setAudioMeter(showAudioMeter&&active);},[showAudioMeter,active]);
  useLayoutEffect(()=>{const element=wrap.current;if(!element)return;const observer=new ResizeObserver(entries=>{const rect=entries[0].contentRect;setSize({width:Math.max(1,rect.width-32),height:Math.max(1,rect.height-24)});});observer.observe(element);return()=>observer.disconnect();},[]);
  useLayoutEffect(()=>{setIssues([]);},[project.id]);
  useLayoutEffect(()=>{const host=wrap.current,frame=stage.current;if(!host||!frame)return;const outer=host.getBoundingClientRect(),inner=frame.getBoundingClientRect();runtime.current?.setViewport({width:host.clientWidth,height:host.clientHeight,left:inner.left-outer.left-host.clientLeft,top:inner.top-outer.top-host.clientTop,scale:inner.width/Math.max(1,project.width)});},[size.width,size.height,project.width,project.height]);
  const preparationIssues:Issue[]=project.media.filter(media=>needsPreviewProxy(media)&&props.previewFailures?.[previewSourceKey(media)]&&project.clips.some(clip=>clip.mediaId===media.id)).map(media=>({media,message:props.previewFailures![previewSourceKey(media)].message,preparation:true}));
  const displayedIssues=[...issues,...preparationIssues];
  const waitingSources=stats?.waitingProxySources??[],preparing=waitingSources.some(key=>!props.previewFailures?.[key]);
  const scale=Math.min(size.width/project.width,size.height/project.height),duration=projectDuration(project);
  const getPoint=(event:React.PointerEvent):Point=>{const rect=stage.current!.getBoundingClientRect();return [(event.clientX-rect.left)/rect.width*project.width,(event.clientY-rect.top)/rect.height*project.height];};
  const unit=()=>1/Math.max(1e-6,scale);
  // Overlays inside the monitor (issue cards, the empty-state button) keep their own clicks.
  const ownClick=(event:React.PointerEvent)=>!!(event.target as Element).closest?.('button,.gpu-issues');
  const hover=(event:React.PointerEvent)=>{const element=wrap.current;if(!element)return;if(!current.current.onTransform||!project.clips.length||ownClick(event)){element.style.cursor='';return;}const target=runtime.current?.pick(...getPoint(event));element.style.cursor=!target||target.locked?'':target.handle?handleCursor(target.geometry,target.handle):'move';};
  const endDrag=(event:React.PointerEvent)=>{if(drag.current?.pointer!==event.pointerId)return;drag.current=undefined;runtime.current?.setGuides([]);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);};
  const pointerDown=(event:React.PointerEvent<HTMLDivElement>)=>{if(event.button!==0||ownClick(event)||!project.clips.length)return;const point=getPoint(event),target=runtime.current?.pick(...point),props=current.current;stage.current?.focus({preventScroll:true});
    if(!target){if(props.selected.length)props.onDeselect?.();return;}
    if(!target.handle&&!(props.selected.length===1&&props.selected[0]===target.clip.id))onSelect(target.clip.id);
    if(target.locked||!props.onTransform)return;
    drag.current={id:target.clip.id,pointer:event.pointerId,mode:target.handle??'move',from:point,last:point,clientX:event.clientX,clientY:event.clientY,state:target.state,geometry:target.geometry,bounds:regionBounds(target.geometry),dragScale:target.dragScale,started:false,angle:0};
    if(target.handle==='rotate')event.currentTarget.style.cursor='grabbing';event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();};
  const pointerMove=(event:React.PointerEvent<HTMLDivElement>)=>{const state=drag.current;if(!state||state.pointer!==event.pointerId){hover(event);return;}const point=getPoint(event),transform=current.current.onTransform;if(!transform)return;
    if(!state.started){if(Math.hypot(event.clientX-state.clientX,event.clientY-state.clientY)<=3)return;state.started=true;current.current.onTransformStart?.();}
    if(state.mode==='move'){let delta:Point=[point[0]-state.from[0],point[1]-state.from[1]],guides:Guide[]=[];if(!event.ctrlKey)({delta,guides}=snapMove(state.bounds,delta,project.width,project.height,SNAP_DISTANCE*unit()));runtime.current?.setGuides(guides);transform(state.id,{x:clamp(state.state.x+delta[0]/state.dragScale,-16384,16384),y:clamp(state.state.y+delta[1]/state.dragScale,-16384,16384)});}
    else if(state.mode==='rotate'){state.angle+=sweepAngle(regionCenter(state.geometry),state.last,point);state.last=point;transform(state.id,rotationTransform(state.geometry,state.state,snapRotation(state.state.rotation+state.angle,event.shiftKey?15:undefined),state.dragScale));}
    else transform(state.id,scaleTransform(state.geometry,state.state,state.from,point,state.dragScale));};
  const seekFrame=(direction:number)=>onSeek(clamp((Math.round((runtime.current?.time()??time)*project.fps)+direction)/project.fps,0,duration));
  return <section className="preview-panel gpu-preview-panel" ref={panel} aria-label="프로그램 모니터">
    <div className="panel-heading"><span>프로그램</span><div className="preview-meta"><span>{project.width} × {project.height}</span><select aria-label="미리보기 해상도" title="미리보기 해상도" value={quality} onChange={event=>setQuality(Number(event.target.value))}><option value={360}>360p</option><option value={540}>540p</option><option value={720}>720p</option><option value={1080}>1080p</option></select><button className={`icon-button ${showScopes?'active':''}`} title="색상 스코프" aria-pressed={showScopes} onClick={()=>setShowScopes(v=>!v)}><ChartColumn size={15}/></button><button className={`icon-button ${showAudioMeter?'active':''}`} title="오디오 레벨" aria-pressed={showAudioMeter} onClick={()=>setShowAudioMeter(value=>!value)}><AudioLines size={15}/></button><button className={`icon-button ${showStats?'active':''}`} title="재생 성능" onClick={()=>setShowStats(value=>!value)}><Activity size={15}/></button><button className="icon-button" title="플레이어 전체 화면" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen();else void panel.current?.requestFullscreen();}}><Maximize2 size={15}/></button></div></div>
    <div className="preview-display-row"><div className="preview-wrap gpu-preview-wrap" ref={wrap} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event=>{endDrag(event);hover(event);}} onPointerCancel={endDrag} onPointerLeave={event=>{if(!drag.current)event.currentTarget.style.cursor='';}}>
      <div className="preview-gpu-stage" ref={stage} style={{width:Math.max(1,project.width*scale),height:Math.max(1,project.height*scale)}} tabIndex={0} aria-label="영상 캔버스"/>
      <canvas className="gpu-preview-selection" ref={overlay} aria-hidden="true"/>
      {!project.clips.length&&<div className="gpu-empty"><Film size={26}/><span>타임라인에 클립을 추가하세요</span><button className="button secondary" onClick={onImport}><FolderPlus size={15}/>가져오기</button></div>}
      {displayedIssues.length>0&&<div className="gpu-issues">{displayedIssues.map((issue,index)=><div key={issue.media?.id||index}><span>{issue.message}</span>{issue.media?.kind==='video'&&<button onClick={()=>{onProxy(issue.media!);setIssues(previous=>previous.filter(item=>item!==issue));}}>프록시 생성</button>}{!issue.preparation&&<button aria-label="안내 닫기" onClick={()=>setIssues(previous=>previous.filter(item=>item!==issue))}><X size={14}/></button>}</div>)}</div>}
      {showStats&&stats&&<div className="gpu-stats" data-testid="preview-stats"><b>{stats.mode} · {stats.width}×{stats.height}</b><span>{stats.playing?'합성 '+stats.fps.toFixed(1)+' fps':'정지'} · {stats.decoders} 미디어</span><span>합성 제출 {stats.renderMs.toFixed(2)} ms · P95 {stats.p95Ms.toFixed(2)} ms</span><span>소스 지연 {stats.maxSourceLagSeconds.toFixed(2)} s</span><span>브라우저 영상 누락 {stats.droppedVideoFrames} / {stats.totalVideoFrames}</span><span>타임라인 누락 {stats.missedFrames} · {stats.audioContext==='running'?'오디오 믹서 활성':'오디오 대기'}</span></div>}
      {stats?.seeking&&project.clips.length>0&&(preparing||!waitingSources.length)&&<span className="gpu-seeking" role="status">{preparing?'미리보기 파일 준비 중':'프레임 준비 중'}</span>}
    </div>
    {showAudioMeter&&<AudioMeter feed={audioFeed} onReset={()=>runtime.current?.resetAudioMeter()}/>}
    </div>
    {showScopes&&<ScopePanel result={scopeResult} error={scopeError} fps={project.fps}/>}
    <input className="gpu-preview-scrub" type="range" aria-label="미리보기 재생 위치" min={0} max={Math.max(duration,.001)} step={1/project.fps} value={Math.min(time,duration)} disabled={!duration} onChange={event=>onSeek(Number(event.target.value))}/>
    <div className="transport"><span className="timecode"><b>{formatTime(time,project.fps)}</b><span> / {formatTime(duration,project.fps)}</span></span><div className="transport-buttons"><button className="icon-button" title="처음으로 (Home)" onClick={()=>onSeek(0)}><SkipBack size={15}/></button><button className="icon-button" title="이전 프레임 (←)" onClick={()=>seekFrame(-1)}><ChevronLeft size={16}/></button><button className="play-button" title={playing?'일시 정지 (Space)':'재생 (Space)'} disabled={!duration} onClick={()=>{void runtime.current?.resumeAudio();onPlay();}}>{playing?<Pause size={18} fill="currentColor"/>:<Play size={18} fill="currentColor"/>}</button><button className="icon-button" title="다음 프레임 (→)" onClick={()=>seekFrame(1)}><ChevronRight size={16}/></button><button className="icon-button" title="끝으로 (End)" onClick={()=>onSeek(duration)}><SkipForward size={15}/></button></div><div className="transport-right"><button className="icon-button" title={muted?'미리보기 소리 켜기':'미리보기 소리 끄기'} onClick={()=>setMuted(value=>!value)}>{muted?<VolumeX size={16}/>:<Volume2 size={16}/>}</button><span className="preview-quality">{stats?.mode||'준비'}{proxy?' · 프록시 우선':''}</span></div></div>
  </section>;
}
