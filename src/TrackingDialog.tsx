import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ChevronLeft,ChevronRight,Crosshair,LoaderCircle,Pause,Play,Trash2} from 'lucide-react';
import type {JobEvent,Project,MediaAsset} from '../shared/types';
import type {MotionAnalysis,MotionBox,MotionSample,TrackingAnchor,TrackingStill} from '../shared/tracking';
import {MotionPageCache} from '../shared/motion-pages';
import {bindingTime} from '../shared/motion';
import {clipSourceSpan} from '../shared/speed';
import {previewProxyPath,toPreviewTime,fromPreviewTime} from '../shared/media-clock';
import {Modal} from './Dialogs';
import {trackingReference,type TrackingTarget,type TrackingApply} from './tracking-edits';
import './tracking.css';

interface Props {target:TrackingTarget;project:Project;onClose:()=>void;onApply:(apply:TrackingApply)=>Promise<void>;onValidate:()=>void;onJobStarted:(id:string)=>void;onProxy:(media:MediaAsset)=>void}
const clamp=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const message=(e:unknown)=>e instanceof Error?e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''):String(e);
type Drag={pointer:number;from:{x:number;y:number};initial:MotionBox;box:MotionBox;mode:'draw'|'move'|'nw'|'ne'|'sw'|'se'};
export default function TrackingDialog({target,project,onClose,onApply,onValidate,onJobStarted,onProxy}:Props){
  const [time,setTime]=useState(target.time),[start,setStart]=useState(target.start),[end,setEnd]=useState(target.end),[playing,setPlaying]=useState(false);
  const [still,setStill]=useState<TrackingStill&{requestedTime:number;requestedMaximum:number}>(),[loading,setLoading]=useState(true),[frameError,setFrameError]=useState(''),[error,setError]=useState('');
  const [analysis,setAnalysis]=useState<MotionAnalysis|undefined>(target.existing?.analysis),[anchors,setAnchors]=useState<TrackingAnchor[]>(target.existing?.analysis.anchors||[]),[dirty,setDirty]=useState(!target.existing);
  const [maximum,setMaximum]=useState(Math.max(720,target.existing?.analysis.analysisWidth||1280,target.existing?.analysis.analysisHeight||0)),[device,setDevice]=useState<'auto'|'gpu'|'cpu'>('auto');
  const [job,setJob]=useState<JobEvent>(),[starting,setStarting]=useState(false),[applying,setApplying]=useState(false),[cancelling,setCancelling]=useState(false),[videoError,setVideoError]=useState(false);
  const [targetId,setTargetId]=useState(target.existing?.clip.id||'new'),[text,setText]=useState('텍스트'),[followScale,setFollowScale]=useState(target.existing?.clip.motionBinding?.followScale||false),[query,setQuery]=useState(''),[drag,setDrag]=useState<Drag>();
  const alive=useRef(true),jobId=useRef<string|undefined>(undefined),cancelRequested=useRef(false),video=useRef<HTMLVideoElement>(null),canvas=useRef<HTMLCanvasElement>(null),picture=useRef<HTMLDivElement>(null),dragRef=useRef<Drag|undefined>(undefined),latest=useRef({time,start,end,playing});latest.current={time,start,end,playing};
  const [,redraw]=useState(0),[pages]=useState(()=>new MotionPageCache((file,t,limit)=>window.studio.readTrackingPath(file,t,limit),()=>{if(alive.current)redraw(v=>v+1);},8));
  const busy=starting||job?.status==='running',media=project.media.find(m=>m.id===target.media.id)||target.media,proxy=!!previewProxyPath(media),videoFile=previewProxyPath(media)||media.path,videoUrl=window.studio.mediaUrl(videoFile)+(media.sourceRevision?'?revision='+encodeURIComponent(media.sourceRevision):'');
  const waiting=loading||!still||still.requestedTime!==time||still.requestedMaximum!==maximum;
  const at=playing||waiting?time:Math.max(start,still.time);let sample:MotionSample|undefined,pathError='';
  if(analysis&&at>=analysis.start&&at<analysis.end)try{sample=pages.peek(analysis,at);}catch(e){pathError=message(e);}
  const anchor=anchors.find(a=>Math.abs(a.time-at)<.000001),box=drag?.box||anchor?.box||sample?.box;
  const sourceStart=Math.max(target.existing?0:target.source.in,still?.videoStart??media.videoStart??0),sourceEnd=Math.min(target.existing?media.duration:target.source.in+clipSourceSpan(target.source),still?.videoEnd??media.videoEnd??media.duration);
  const ratio=still?still.sourceWidth/still.sourceHeight:Math.max(1,media.width)/Math.max(1,media.height);
  const stop=useCallback(()=>{video.current?.pause();setPlaying(false);},[]);
  const seek=(t:number)=>{stop();setTime(clamp(t,start,end-.000001));setError('');};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;pages.clear();if(jobId.current)void window.studio.cancelJob(jobId.current).catch(()=>{});};},[pages]);
  useEffect(()=>window.studio.onJob(event=>{
    if(event.id!==jobId.current||!alive.current)return;setJob(event);
    if(event.status!=='running'){
      jobId.current=undefined;setCancelling(false);setStarting(false);
      if(event.status==='complete'&&event.tracking&&!cancelRequested.current){setAnalysis(event.tracking);setAnchors(event.tracking.anchors);setDirty(false);setError('');}
      else if(event.status==='error')setError(event.message);
    }
  }),[]);
  useEffect(()=>{
    if(!analysis||at<analysis.start||at>=analysis.end||pathError)return;
    try{if(!sample)pages.request(analysis,at);else if(playing)pages.request(analysis,Math.min(analysis.end,at+.25));}catch(e){setError(message(e));}
  });
  useEffect(()=>{
    if(playing){setLoading(false);return;}let current=true;const id=crypto.randomUUID();setLoading(true);setFrameError('');
    const timer=setTimeout(()=>{void window.studio.trackingStill(id,target.media,time,maximum).then(frame=>{if(!current||!alive.current)return;setStill({...frame,requestedTime:time,requestedMaximum:maximum});},e=>{if(current&&alive.current)setFrameError(message(e));}).finally(()=>{if(current&&alive.current)setLoading(false);});},65);
    return()=>{current=false;clearTimeout(timer);void window.studio.cancelTrackingStill(id).catch(()=>{});};
  },[time,maximum,playing,target.media]);
  useEffect(()=>{if(!still)return;const from=Math.max(start,sourceStart),to=Math.min(end,sourceEnd);if(to<=from){setFrameError('선택 구간에 표시할 영상 프레임이 없습니다.');return;}if(from!==start||to!==end){setStart(from);setEnd(to);setAnchors(a=>a.filter(p=>p.time>=from&&p.time<to));setDirty(true);}},[still?.videoStart,still?.videoEnd,sourceStart,sourceEnd,start,end]);
  useLayoutEffect(()=>{if(!still||!canvas.current)return;const c=canvas.current;c.width=still.width;c.height=still.height;const data=new Uint8ClampedArray(still.width*still.height*4);for(let i=0,j=0;i<still.bgr.length;i+=3,j+=4){data[j]=still.bgr[i+2];data[j+1]=still.bgr[i+1];data[j+2]=still.bgr[i];data[j+3]=255;}c.getContext('2d')!.putImageData(new ImageData(data,still.width,still.height),0,0);},[still]);
  useEffect(()=>{setVideoError(false);},[videoUrl]);
  const positionVideo=()=>{const v=video.current;if(v&&!latest.current.playing&&v.readyState>=1)v.currentTime=toPreviewTime(media,latest.current.time,proxy);};
  useEffect(positionVideo,[time,videoUrl,playing]);
  useEffect(()=>{
    const v=video.current;if(!v||!playing)return;let callback=0,active=true;
    const frame=(_now:number,metadata:VideoFrameCallbackMetadata)=>{if(!active)return;const t=fromPreviewTime(media,metadata.mediaTime,proxy);if(t>=latest.current.end-.000001){v.pause();setPlaying(false);setTime(latest.current.end-.000001);return;}setTime(clamp(t,latest.current.start,latest.current.end-.000001));callback=v.requestVideoFrameCallback(frame);};callback=v.requestVideoFrameCallback(frame);
    return()=>{active=false;v.cancelVideoFrameCallback(callback);};
  },[playing,media,proxy]);
  const play=async()=>{if(playing){stop();return;}try{const v=video.current;if(!v||videoError)throw new Error('이 영상은 미리보기 프록시가 필요합니다.');v.currentTime=toPreviewTime(media,time>=end-.01?start:time,proxy);await v.play();if(alive.current)setPlaying(true);else v.pause();}catch(e){setError(message(e));}};
  const commit=(b:MotionBox)=>{
    if(!still||waiting||playing||busy)return;
    if(b.width*still.width<4-1e-6||b.height*still.height<4-1e-6){setError('가로·세로 4픽셀 이상으로 영역을 지정하세요.');return;}
    const t=Math.max(start,still.time);if(t>=end)return;setAnchors(values=>{const rest=values.filter(a=>Math.abs(a.time-t)>.000001);if(rest.length>=64){setError('기준점은 최대 64개입니다.');return values;}setDirty(true);setError('');return [...rest,{time:t,box:b}].sort((a,b)=>a.time-b.time);});
  };
  const point=(event:React.PointerEvent)=>{const bounds=picture.current!.getBoundingClientRect();return {x:clamp((event.clientX-bounds.left)/bounds.width),y:clamp((event.clientY-bounds.top)/bounds.height)};};
  const pointerDown=(event:React.PointerEvent)=>{
    if(event.button!==0||waiting||playing||busy||!still||frameError)return;const from=point(event),corner=(event.target as HTMLElement).dataset.corner as Drag['mode']|undefined,inside=box&&from.x>=box.x&&from.x<=box.x+box.width&&from.y>=box.y&&from.y<=box.y+box.height;
    const mode=corner||(!event.shiftKey&&inside?'move':'draw'),initial=box||{x:from.x,y:from.y,width:0,height:0},value:Drag={pointer:event.pointerId,from,initial,mode,box:mode==='draw'?{x:from.x,y:from.y,width:0,height:0}:initial};dragRef.current=value;setDrag(value);event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();
  };
  const pointerMove=(event:React.PointerEvent)=>{const d=dragRef.current;if(!d||d.pointer!==event.pointerId)return;const p=point(event),i=d.initial;let b:MotionBox;
    if(d.mode==='move')b={...i,x:clamp(i.x+p.x-d.from.x,0,1-i.width),y:clamp(i.y+p.y-d.from.y,0,1-i.height)};
    else{const fixed=d.mode==='draw'?d.from:{x:d.mode.includes('w')?i.x+i.width:i.x,y:d.mode.includes('n')?i.y+i.height:i.y};b={x:Math.min(fixed.x,p.x),y:Math.min(fixed.y,p.y),width:Math.abs(p.x-fixed.x),height:Math.abs(p.y-fixed.y)};}
    dragRef.current={...d,box:b};setDrag(dragRef.current);
  };
  const pointerUp=(event:React.PointerEvent)=>{const d=dragRef.current;if(!d||d.pointer!==event.pointerId)return;dragRef.current=undefined;setDrag(undefined);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);commit(d.box);};
  const range=(from:number,to:number)=>{stop();if(!Number.isFinite(from)||!Number.isFinite(to)||from<sourceStart||to>sourceEnd+.000001||to-from<.001)return;setStart(from);setEnd(to);setTime(t=>clamp(t,from,to-.000001));setAnchors(a=>a.filter(p=>p.time>=from&&p.time<to));setDirty(true);};
  const track=async()=>{if(busy)return;stop();setError('');setStarting(true);cancelRequested.current=false;try{onValidate();const result=await window.studio.trackMedia(target.media,{start,duration:end-start,anchors,maxDimension:maximum,device});if(!alive.current){await window.studio.cancelJob(result.jobId);return;}jobId.current=result.jobId;onJobStarted(result.jobId);setJob({id:result.jobId,type:'track',status:'running',progress:0,message:'작업 준비 중'});}catch(e){if(alive.current)setError(message(e));}finally{if(alive.current)setStarting(false);}};
  const apply=async()=>{if(!analysis||!sample||dirty||waiting||playing)return;setApplying(true);setError('');try{onValidate();let previousSample:MotionSample|undefined;if(target.existing){const c=target.existing.clip,b=c.motionBinding!,t=trackingReference(project,target,at).time,oldTime=bindingTime(project,b,target.existing.analysis,t);previousSample=(await window.studio.readTrackingPath(target.existing.analysis.path,oldTime,1)).samples[0];}if(alive.current)await onApply({analysis,sample,sourceTime:at,targetId,text,followScale,previousSample});}catch(e){if(alive.current)setError(message(e));}finally{if(alive.current)setApplying(false);}};
  const candidates=project.clips.filter(c=>!c.motionBinding&&!project.tracks.find(t=>t.id===c.trackId)?.locked&&(c.text!==undefined||project.media.find(m=>m.id===c.mediaId)?.kind==='image')&&(c.id===targetId||!query||c.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()))).sort((a,b)=>Number(b.id===targetId)-Number(a.id===targetId)).slice(0,200);
  const shownError=error||frameError||pathError,status=anchor?'기준점':sample?.status==='lost'?'대상 확인 필요':sample?.status==='review'?'경로 확인 필요':sample?'추적 경로':'영역을 드래그해 지정하세요';
  return <Modal title={target.existing?'객체 추적 검토':'객체 추적'} onClose={onClose} wide>
    <div className="tracking-dialog">
      <div className="tracking-main"><div className="tracking-source"><b title={media.path}>{media.name}</b><span>{at.toFixed(3)}초 · 원본</span></div>
        <div className="tracking-view"><div ref={picture} className="tracking-picture" style={{aspectRatio:ratio,width:`min(100%, calc(48vh * ${ratio}))`}} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={()=>{dragRef.current=undefined;setDrag(undefined);}}>
          <canvas ref={canvas} aria-label="추적 기준 프레임" data-source-time={still?.time} style={{visibility:playing?'hidden':'visible'}}/>
          <video ref={video} src={videoUrl} muted preload="auto" style={{visibility:playing?'visible':'hidden'}} onLoadedMetadata={positionVideo} onDurationChange={positionVideo} onError={()=>{setVideoError(true);stop();}} onEnded={()=>{stop();setTime(end-.000001);}}/>
          {box&&(playing||!waiting)&&<><svg className={`tracking-box ${anchor?'anchor':sample?.status||''}`} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"><rect x={box.x*1000} y={box.y*1000} width={box.width*1000} height={box.height*1000} vectorEffect="non-scaling-stroke"/></svg>{!playing&&!waiting&&!busy&&(['nw','ne','sw','se'] as const).map(corner=><span key={corner} data-corner={corner} className={`tracking-handle ${corner}`} style={{left:(box.x+(corner.includes('e')?box.width:0))*100+'%',top:(box.y+(corner.includes('s')?box.height:0))*100+'%'}}/>)}</>}
          {!playing&&waiting&&!frameError&&<div className="tracking-loading"><LoaderCircle size={20} className="spin"/><span>프레임 불러오는 중</span></div>}
        </div></div>
        <div className="tracking-status"><Crosshair size={13}/><span>{dirty&&analysis?'수정 후 다시 분석':status}</span>{videoError&&<button onClick={()=>onProxy(media)} className="text-button">재생용 프록시 만들기</button>}</div>
        <input aria-label="추적 재생 위치" className="tracking-scrubber" type="range" min={start} max={Math.max(start,end-.000001)} step="0.000001" value={clamp(time,start,end-.000001)} onChange={e=>seek(+e.target.value)}/>
        <div className="tracking-transport"><button className="icon-button" title="이전 프레임" disabled={waiting||playing||!!busy||still?.previousTime===undefined||still.time<=start} onClick={()=>seek(Math.max(start,still!.previousTime!))}><ChevronLeft size={17}/></button><button className="icon-button" title={playing?'추적 재생 일시정지':'추적 결과 재생'} disabled={videoError} onClick={()=>void play()}>{playing?<Pause size={17}/>:<Play size={17}/>}</button><button className="icon-button" title="다음 프레임" disabled={waiting||playing||!!busy||still?.nextTime===undefined||still.nextTime>=end} onClick={()=>seek(still!.nextTime!)}><ChevronRight size={17}/></button><label><input aria-label="추적 원본 시각" type="number" min={start} max={end-.000001} step="0.001" value={Number(time.toFixed(6))} onChange={e=>{if(Number.isFinite(e.target.valueAsNumber))seek(e.target.valueAsNumber);}}/>초</label></div>
        {shownError&&<div className="tracking-error" role="alert">{shownError}</div>}
        {busy&&<div className="tracking-progress" role="status"><progress value={job?.progress||0} max="1"/><span>{cancelling?'취소 중':job?.message||'작업 준비 중'}</span><button className="button secondary" disabled={!jobId.current||cancelling} onClick={()=>{cancelRequested.current=true;setCancelling(true);void window.studio.cancelJob(jobId.current!).catch(e=>setError(message(e)));}}>분석 취소</button></div>}
      </div>
      <div className="tracking-settings"><fieldset disabled={!!busy||applying}><legend>분석 구간</legend><div className="tracking-range"><label>시작<input aria-label="추적 시작" type="number" step="0.001" value={Number(start.toFixed(6))} min={sourceStart} max={end-.001} onChange={e=>range(e.target.valueAsNumber,end)}/></label><label>끝<input aria-label="추적 끝" type="number" step="0.001" value={Number(end.toFixed(6))} min={start+.001} max={sourceEnd} onChange={e=>range(start,e.target.valueAsNumber)}/></label></div>
        <label className="inline-field"><span>해상도</span><select aria-label="추적 분석 해상도" value={maximum} onChange={e=>{setMaximum(+e.target.value);setDirty(true);}}>{[...new Set([720,1280,1920,maximum])].sort((a,b)=>a-b).map(v=><option key={v} value={v}>{v}px</option>)}</select></label>
        <label className="inline-field"><span>처리 장치</span><select aria-label="추적 처리 장치" value={device} onChange={e=>setDevice(e.target.value as typeof device)}><option value="auto">자동 · GPU 우선</option><option value="gpu">GPU</option><option value="cpu">CPU</option></select></label>
        <div className="tracking-anchor-heading"><b>기준점 {anchors.length}/64</b><button className="text-button" disabled={!anchor} onClick={()=>{setAnchors(a=>a.filter(v=>v!==anchor));setDirty(true);}}>현재 기준점 삭제</button></div>
        <div className="tracking-anchors">{anchors.map(a=><div key={a.time} className={a===anchor?'active':''}><button onClick={()=>seek(a.time)}>{a.time.toFixed(3)}초</button><button title={`${a.time.toFixed(3)}초 기준점 삭제`} onClick={()=>{setAnchors(values=>values.filter(v=>v!==a));setDirty(true);}}><Trash2 size={12}/></button></div>)}{!anchors.length&&<span>멈춘 화면에서 영역을 지정하세요.</span>}</div>
        <button className="button secondary full" disabled={waiting||!!frameError||!anchors.length||end-start>86400} onClick={()=>void track()}>{analysis?'다시 분석':'앞·뒤 방향 분석'}</button></fieldset>
        <fieldset disabled={applying}><legend>움직임 연결</legend>{target.existing?<p className="tracking-existing">{target.existing.clip.name}</p>:<><input className="tracking-search" aria-label="연결할 클립 검색" placeholder="클립 이름 검색" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="움직임 연결 대상" value={targetId} onChange={e=>setTargetId(e.target.value)}><option value="new">새 텍스트</option>{candidates.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>{targetId==='new'&&<input aria-label="추적 텍스트 내용" maxLength={500} value={text} onChange={e=>setText(e.target.value)}/>}</>}
        <label className="tracking-check"><input type="checkbox" checked={followScale} onChange={e=>setFollowScale(e.target.checked)}/>크기도 따라가기</label><p className="field-note">가림·회전 구간을 확인하고, 벗어난 프레임에서 상자를 다시 지정한 뒤 분석하세요.</p></fieldset>
      </div>
    </div>
    <div className="modal-actions"><button className="button secondary" onClick={onClose}>닫기</button><button className="button primary" disabled={!!busy||applying||dirty||!analysis||!sample||waiting||playing||!!shownError} onClick={()=>void apply()}>{applying&&<LoaderCircle size={15} className="spin"/>}{target.existing?'수정 적용':'움직임 연결'}</button></div>
  </Modal>;
}
