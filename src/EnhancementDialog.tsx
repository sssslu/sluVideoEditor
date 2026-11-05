import {useCallback,useEffect,useRef,useState} from 'react';
import {Download,LoaderCircle,Pause,Play} from 'lucide-react';
import type {EnhancementInfo,JobEvent,MediaAsset} from '../shared/types';
import {fromPreviewTime,needsPreviewProxy,previewMediaPath,previewProxyPath,toPreviewTime} from '../shared/media-clock';
import {Modal} from './Dialogs';
import {ownEnhancementJob} from './enhancement-preview';
import './enhancement.css';

const message=(error:unknown)=>error instanceof Error?error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''):String(error);
interface Props {
  media:MediaAsset;start:number;duration:number;previewStart:number;
  onClose:()=>void;onValidate:()=>void;onApply:(scale:2|4)=>Promise<void>;onPrepareSource:()=>void;
}

function Comparison({media,result,start,duration,onPrepareSource}:{media:MediaAsset;result:MediaAsset;start:number;duration:number;onPrepareSource:()=>void}){
  const before=useRef<HTMLVideoElement>(null),after=useRef<HTMLVideoElement>(null),localTime=useRef(0);
  const [time,setTime]=useState(0),[playing,setPlaying]=useState(false),[ready,setReady]=useState(false),[sourceError,setSourceError]=useState(''),[resultError,setResultError]=useState('');
  const [fallback,setFallback]=useState(false),useProxy=fallback||needsPreviewProxy(media),waiting=needsPreviewProxy(media);
  const sourcePath=previewMediaPath(media,useProxy),resultPath=previewMediaPath(result),step=1/Math.max(1,media.fps||30),last=Math.max(0,duration-step);
  const sourceUrl=waiting?undefined:window.studio.mediaUrl(sourcePath)+(media.sourceRevision?'?revision='+media.sourceRevision:''),resultUrl=window.studio.mediaUrl(resultPath);
  const updateReady=useCallback(()=>setReady(!!before.current&&!!after.current&&!before.current.seeking&&!after.current.seeking&&before.current.readyState>=2&&after.current.readyState>=2),[]);
  const seek=useCallback((value:number)=>{
    const at=Math.min(last,Math.max(0,value));localTime.current=at;setTime(at);setReady(false);
    if(before.current?.readyState)before.current.currentTime=toPreviewTime(media,start+at,useProxy);
    if(after.current?.readyState)after.current.currentTime=toPreviewTime(result,at);
    updateReady();
  },[last,media,result,start,updateReady,useProxy]);
  useEffect(()=>{setPlaying(false);setReady(false);setSourceError('');setResultError('');localTime.current=0;setTime(0);},[sourceUrl,resultUrl]);
  useEffect(()=>{
    const a=before.current,b=after.current;if(!a||!b)return;
    let frame=0,disposed=false;
    if(playing&&ready){
      void Promise.all([a.play(),b.play()]).catch(error=>{if(!disposed){setPlaying(false);setResultError(message(error));}}).finally(()=>{if(disposed){a.pause();b.pause();}});
      const tick=()=>{
        if(a.seeking||b.seeking||a.readyState<2||b.readyState<2){setReady(false);return;}
        const at=Math.max(0,fromPreviewTime(media,a.currentTime,useProxy)-start);
        if(at>=duration-step/2){setPlaying(false);seek(last);return;}
        localTime.current=at;setTime(at);
        if(Math.abs(fromPreviewTime(result,b.currentTime)-at)>step){b.currentTime=toPreviewTime(result,at);setReady(false);return;}
        frame=requestAnimationFrame(tick);
      };frame=requestAnimationFrame(tick);
    }else {a.pause();b.pause();}
    return()=>{disposed=true;cancelAnimationFrame(frame);a.pause();b.pause();};
  },[playing,ready,media,result,start,duration,last,step,useProxy,seek]);
  return <div className="enhancement-comparison">
    <div className="enhancement-pictures">
      <figure><figcaption>원본</figcaption><video aria-label="화질 향상 원본 비교" ref={before} src={sourceUrl} muted playsInline preload="auto" onLoadedMetadata={()=>{if(before.current)before.current.currentTime=toPreviewTime(media,start+localTime.current,useProxy);}} onCanPlay={updateReady} onSeeked={updateReady} onWaiting={()=>setReady(false)} onError={()=>{setPlaying(false);setFallback(true);if(!previewProxyPath(media)||useProxy)setSourceError('원본 미리보기를 준비하세요.');}}/>{(waiting||sourceError)&&<div className="enhancement-video-message"><button className="button secondary" onClick={onPrepareSource}>미리보기 준비</button></div>}</figure>
      <figure><figcaption>화질 향상</figcaption><video aria-label="화질 향상 결과 비교" ref={after} src={resultUrl} muted playsInline preload="auto" onLoadedMetadata={()=>{if(after.current)after.current.currentTime=toPreviewTime(result,localTime.current);}} onCanPlay={updateReady} onSeeked={updateReady} onWaiting={()=>setReady(false)} onEnded={()=>{setPlaying(false);seek(last);}} onError={()=>{setPlaying(false);setResultError('결과 미리보기를 재생할 수 없습니다. 다시 생성하세요.');}}/></figure>
    </div>
    <div className="enhancement-transport"><button className="icon-button bordered" aria-label={playing?'비교 일시 정지':'비교 재생'} disabled={!playing&&(!ready||!!sourceError||!!resultError||waiting)} onClick={()=>{if(time>=last)seek(0);setPlaying(value=>!value);}}>{playing?<Pause size={16}/>:<Play size={16}/>}</button><input type="range" aria-label="화질 향상 비교 위치" min="0" max={last} step={step} value={Math.min(last,time)} disabled={waiting||!!sourceError||!!resultError} onChange={event=>{setPlaying(false);seek(+event.target.value);}}/><output>{Math.min(duration,time).toFixed(2)} / {duration.toFixed(2)}초</output></div>
    {resultError&&<p className="enhancement-error" role="alert">{resultError}</p>}
  </div>;
}

export default function EnhancementDialog({media,start,duration,previewStart,onClose,onValidate,onApply,onPrepareSource}:Props){
  const [info,setInfo]=useState<EnhancementInfo>(),[scale,setScale]=useState<2|4>(2),[error,setError]=useState(''),[job,setJob]=useState<JobEvent>(),[starting,setStarting]=useState(false),[applying,setApplying]=useState(false),[result,setResult]=useState<MediaAsset>();
  const alive=useRef(true),owned=useRef<ReturnType<typeof ownEnhancementJob>|undefined>(undefined),attempt=useRef(0);
  const sampleDuration=Math.min(2,duration),sampleStart=Math.max(start,Math.min(previewStart,start+duration-sampleDuration));
  const report=useCallback((failure:unknown)=>{if(alive.current){setError(message(failure));setStarting(false);}},[]);
  const refresh=useCallback(async()=>{try{const next=await window.studio.enhancementInfo();if(alive.current)setInfo(next);}catch(failure){report(failure);}},[report]);
  useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;attempt.current++;owned.current?.dispose();};},[refresh]);
  const busy=starting||job?.status==='running',sizeSupported=Math.max(media.width,media.height)*scale<=7680&&media.width*media.height*scale**2<=33177600,supported=!!info?.deviceSupported&&sizeSupported;
  const clearPreview=()=>{attempt.current++;owned.current?.dispose();owned.current=undefined;setResult(undefined);setJob(undefined);setError('');};
  const begin=(preview:boolean)=>{
    try{if(busy||applying)return;onValidate();clearPreview();setStarting(true);const generation=attempt.current;
      owned.current=ownEnhancementJob(window.studio,()=>preview?window.studio.enhanceMedia(media,{start:sampleStart,duration:sampleDuration,scale,preview:true}):window.studio.installEnhancementEngine(),preview,event=>{
        if(!alive.current||generation!==attempt.current)return;
        setStarting(false);setJob(event);
        if(event.status==='complete'){if(preview){if(event.media)setResult(event.media);else setError('미리보기 결과가 없습니다. 다시 생성하세요.');}else void refresh();}
        if(event.status==='error')setError(event.message);
      },failure=>{if(generation===attempt.current)report(failure);});
    }catch(failure){report(failure);}
  };
  return <Modal title="AI 화질 향상" onClose={onClose} wide>
    <div className="transcribe-source"><div><b>{media.name}</b><span>{start.toFixed(2)}–{(start+duration).toFixed(2)}초</span></div></div>
    <div className="enhancement-settings"><label className="form-field"><span>확대</span><select aria-label="화질 향상 배율" value={scale} disabled={busy||applying} onChange={event=>{clearPreview();setScale(+event.target.value as 2|4);}}><option value="2">2×</option><option value="4">4×</option></select></label><span>{media.width} × {media.height} → {media.width*scale} × {media.height*scale}</span></div>
    {!info&&(error?<button className="button secondary" onClick={()=>{setError('');void refresh();}}>엔진 다시 확인</button>:<p className="field-note">엔진 확인 중…</p>)}
    {info&&!info.installed&&<button className="button secondary full" disabled={busy||!info.deviceSupported} onClick={()=>begin(false)}><Download size={15}/>AI 엔진 설치 · {Math.ceil(info.downloadBytes/1000000)} MB</button>}
    {info?.message&&<p className="field-note">{info.message}</p>}
    {!sizeSupported&&<p className="enhancement-error">결과는 최대 7680px, 3,318만 화소까지 지원합니다.</p>}
    {result&&<Comparison media={media} result={result} start={sampleStart} duration={sampleDuration} onPrepareSource={onPrepareSource}/>}
    {busy&&<div className="enhancement-progress" role="status"><LoaderCircle size={15} className="spin"/><span>{job?.message||'작업 준비 중…'}</span><progress max="1" value={job?.progress||0}/><button className="button secondary tiny" onClick={()=>{owned.current?.dispose();attempt.current++;setStarting(false);setJob(undefined);}}>취소</button></div>}
    {error&&<p className="enhancement-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button secondary" onClick={onClose}>닫기</button><button className="button secondary" disabled={!info?.installed||!supported||busy||applying} onClick={()=>begin(true)}>{result?'비교 다시 생성':`${sampleDuration.toFixed(sampleDuration<1?2:1)}초 비교`}</button><button className="button primary" disabled={!info?.installed||!supported||busy||applying} onClick={async()=>{setApplying(true);setError('');try{onValidate();await onApply(scale);if(alive.current)onClose();}catch(failure){report(failure);}finally{if(alive.current)setApplying(false);}}}>{applying&&<LoaderCircle size={15} className="spin"/>}클립에 적용</button></div>
  </Modal>;
}
