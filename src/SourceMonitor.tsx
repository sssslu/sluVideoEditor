import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,AudioLines,Pause,Play,SkipBack,SkipForward} from 'lucide-react';
import type {MediaAsset} from '../shared/types';
import {clamp,fileUrl,formatTime,keyBelongsToField,minClipDuration} from './editor';
import {frameTime} from './timeline-model';
import {toPreviewTime,fromPreviewTime,previewClockOffset,needsPreviewProxy,previewMediaPath} from '../shared/media-clock';
interface Props {media:MediaAsset;active:boolean;proxy:boolean;fps:number;onAdd:(media:MediaAsset,sourceIn:number,sourceOut:number,mode:'insert'|'overwrite'|'append')=>void;onProxy:()=>void;preparationFailure?:string;onMediaReady?:(media:MediaAsset)=>void}
/** A time field that applies what was typed on Enter or when it loses focus, not on every keystroke. */
function MarkField({label,value,step,onCommit}:{label:string;value:number;step:number;onCommit:(value:number)=>void}){
  const shown=String(Number(value.toFixed(3))),[draft,setDraft]=useState<string|null>(null);
  return <input aria-label={label} type="number" step={step} min="0" value={draft??shown} onChange={e=>setDraft(e.target.value)} onBlur={()=>{if(draft===null)return;const typed=Number(draft);if(draft.trim()&&Number.isFinite(typed))onCommit(typed);setDraft(null);}} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur();}}}/>;
}
export default function SourceMonitor({media,active,proxy,fps,onAdd,onProxy,preparationFailure,onMediaReady}:Props) {
  const element=useRef<HTMLVideoElement&HTMLAudioElement>(null),ranges=useRef(new Map<string,{start:number;end:number}>());
  const duration=media.kind==='image'?5:media.duration,minimum=minClipDuration(fps),rangeKey=`${media.id}:${media.sourceRevision||media.path}`;
  const base=fileUrl(previewMediaPath(media,proxy)),src=media.sourceRevision?`${base}${base.includes('?')?'&':'?'}revision=${encodeURIComponent(media.sourceRevision)}`:base;
  const available=Math.min(minimum,duration);
  const initialRange=()=>{const saved=ranges.current.get(rangeKey),start=clamp(saved?.start??0,0,Math.max(0,duration-available));return {key:rangeKey,time:0,start,end:clamp(saved?.end??duration,start+available,duration)};};
  const [position,setPosition]=useState(initialRange),[playing,setPlaying]=useState(false),[failed,setFailed]=useState(false);
  const current=position.key===rangeKey?position:initialRange();
  const start=clamp(current.start,0,Math.max(0,duration-available)),end=clamp(current.end,start+available,duration),time=clamp(current.time,0,duration);
  const updatePosition=(patch:Partial<typeof position>)=>setPosition(previous=>({... (previous.key===rangeKey?previous:initialRange()),...patch}));
  const setTime=(time:number)=>updatePosition({time}),setStart=(start:number)=>updatePosition({start}),setEnd=(end:number)=>updatePosition({end});
  const waitingForProxy=needsPreviewProxy(media);
  const ready=()=>{setFailed(false);onMediaReady?.(media);};
  const clockOffset=previewClockOffset(media,proxy);
  useEffect(()=>{setPosition(previous=>previous.key===rangeKey?previous:initialRange());},[rangeKey]);
  useEffect(()=>{setPlaying(false);setFailed(false);},[rangeKey,src]);
  useEffect(()=>{ranges.current.set(rangeKey,{start,end});},[start,end,rangeKey]);
  useEffect(()=>{if(!active){element.current?.pause();setPlaying(false);}},[active]);
  const seek=(value:number)=>{const next=clamp(frameTime(value,fps),0,duration);setTime(next);if(element.current)element.current.currentTime=toPreviewTime(media,next,proxy);};
  useEffect(()=>{const el=element.current;if(el&&el.readyState>=1)el.currentTime=toPreviewTime(media,time,proxy);},[clockOffset,src]);
  const loaded=()=>{if(element.current)element.current.currentTime=toPreviewTime(media,time,proxy);};
  const play=()=>{const el=element.current;if(!el||!active)return;if(el.paused){const sourceTime=fromPreviewTime(media,el.currentTime,proxy);if(sourceTime>=end||sourceTime<start)el.currentTime=toPreviewTime(media,start,proxy);void el.play().catch(error=>{if(element.current===el&&error?.name!=='AbortError')setFailed(true);});}else el.pause();};
  // A mark past the other mark starts a new range there instead of landing one frame beside it.
  const markIn=()=>{const t=frameTime(time,fps);if(t>=end-available){setEnd(duration);setStart(clamp(t,0,duration-available));}else setStart(clamp(t,0,end-available));};
  const markOut=()=>{const t=frameTime(time,fps);if(t<=start+available){setStart(0);setEnd(clamp(t,available,duration));}else setEnd(clamp(t,start+available,duration));};
  useEffect(()=>{if(!active)return;const handler=(e:KeyboardEvent)=>{if(e.defaultPrevented||document.querySelector('.modal-backdrop')||keyBelongsToField(e)||e.ctrlKey||e.metaKey||e.altKey)return;if(e.key.toLowerCase()==='i'){e.preventDefault();markIn();}else if(e.key.toLowerCase()==='o'){e.preventDefault();markOut();}else if(e.key===' '){e.preventDefault();play();}else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();seek(time+(e.key==='ArrowLeft'?-1:1)*(e.shiftKey?1:1/fps));}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);});
  const timeUpdate=()=>{const el=element.current;if(!el)return;const sourceTime=fromPreviewTime(media,el.currentTime,proxy);setTime(clamp(sourceTime,0,duration));if(sourceTime>=end){el.pause();setPlaying(false);}};
  return <section className="source-monitor" aria-label="소스 모니터"><div className="source-heading"><span title={media.path}>{media.name}</span><small>{media.width?`${media.width}×${media.height} · `:''}{media.codec?.toUpperCase()} · {media.fps?`${media.fps.toFixed(2)} fps`:''}</small></div><div className="source-view">{waitingForProxy?null:media.kind==='image'?<img key={src} src={src} alt={media.name}/>:media.kind==='audio'?<><AudioLines size={44}/><audio key={src} ref={element} src={src} onLoadedMetadata={loaded} onLoadedData={ready} onTimeUpdate={timeUpdate} onPlay={e=>{if(!active||e.currentTarget!==element.current)e.currentTarget.pause();else setPlaying(true);}} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onError={()=>setFailed(true)}/></>:<video key={src} ref={element} src={src} preload="auto" onLoadedMetadata={loaded} onLoadedData={ready} onTimeUpdate={timeUpdate} onPlay={e=>{if(!active||e.currentTarget!==element.current)e.currentTarget.pause();else setPlaying(true);}} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onError={()=>setFailed(true)}/>} {waitingForProxy&&!preparationFailure&&<div className="source-error" role="status"><span>미리보기 파일 준비 중</span></div>} {(failed||waitingForProxy&&preparationFailure)&&<div className="source-error"><span>{preparationFailure||'소스 미리보기 실패'}</span>{media.kind==='video'&&<button className="button secondary" onClick={onProxy}>프록시 생성</button>}</div>}</div>
  <div className="source-scrubber"><div className="source-range-fill" style={{left:`${start/duration*100}%`,width:`${(end-start)/duration*100}%`}}/><input aria-label="소스 재생 위치" type="range" min="0" max={duration} step={1/fps} value={time} onChange={e=>seek(+e.target.value)}/></div>
  <div className="source-transport"><span className="timecode">{formatTime(time,fps)} / {formatTime(duration,fps)}</span><button className="icon-button" title="소스 시작점으로" onClick={()=>seek(start)}><SkipBack size={15}/></button><button className="icon-button" title="소스 재생 (Space)" disabled={media.kind==='image'||waitingForProxy} onClick={play}>{playing?<Pause size={17}/>:<Play size={17}/>}</button><button className="icon-button" title="소스 끝점으로" onClick={()=>seek(end)}><SkipForward size={15}/></button></div>
  <div className="source-edit-controls"><div className="source-marks"><label><button onClick={markIn} title="시작점 지정 (I)">I 시작</button><MarkField label="소스 시작점" value={start} step={1/fps} onCommit={v=>setStart(clamp(v,0,end-available))}/></label><label><button onClick={markOut} title="끝점 지정 (O)">O 끝</button><MarkField label="소스 끝점" value={end} step={1/fps} onCommit={v=>setEnd(clamp(v,start+available,duration))}/></label><span>{(end-start).toFixed(3)}초</span></div><div className="source-insert-buttons"><button className="button secondary" title="플레이헤드에 삽입하고 뒤 클립 밀기" disabled={end-start+1e-10<minimum} onClick={()=>onAdd(media,start,end,'insert')}>삽입</button><button className="button secondary" title="플레이헤드 위치의 기존 구간 대체" disabled={end-start+1e-10<minimum} onClick={()=>onAdd(media,start,end,'overwrite')}>덮어쓰기</button><button className="button secondary" title="트랙 끝에 추가" disabled={end-start+1e-10<minimum} onClick={()=>onAdd(media,start,end,'append')}><ArrowDownToLine size={13}/>끝에 추가</button></div></div></section>;
}
