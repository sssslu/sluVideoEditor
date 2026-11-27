import {useState} from 'react';
import {AudioWaveform,Combine,LoaderCircle,Split} from 'lucide-react';
import type {SystemInfo,SpeechModelId,SpeechOptions} from '../shared/types';
import {Modal} from './Dialogs';
import './caption-tools.css';

/** 자막 정리 in the captions tab: sync captions to the speech, and re-break them shorter or longer.
 * Each acts on the selected captions, or on every caption on unlocked tracks. The tools are used a
 * few times per project, so they stay folded away and leave the room to the caption list. */
export default function CaptionTools({scope,count,syncBusy,onSync,onSplit,onMerge,onSelectAll}:{scope:'selected'|'all';count:number;syncBusy:boolean;onSync:()=>void;onSplit:(maxChars:number)=>void;onMerge:(maxChars:number)=>void;onSelectAll?:()=>void}){
  const [short,setShort]=useState(()=>Number(localStorage.getItem('slu-caption-split'))||14),[long,setLong]=useState(()=>Number(localStorage.getItem('slu-caption-merge'))||30);
  const [open,setOpen]=useState(()=>localStorage.getItem('slu-caption-tools-open')==='1');
  const remember=(key:string,value:number)=>{try{localStorage.setItem(key,String(value));}catch{/* optional */}};
  const valid=(v:number)=>Number.isFinite(v)&&v>=4&&v<=120;
  return <section className="caption-tools" aria-label="자막 정리">
    {onSelectAll&&<button type="button" className="button secondary full" title="잠기지 않은 자막을 모두 선택합니다. 속성에서 글꼴·크기·위치를 한꺼번에 바꿀 수 있습니다." onClick={onSelectAll}>자막 전체 선택</button>}
    <details open={open} onToggle={e=>{const next=e.currentTarget.open;setOpen(next);remember('slu-caption-tools-open',next?1:0);}} onKeyDown={event=>{if(event.key===' '||event.key==='Enter')event.stopPropagation();}}>
    <summary>자막 정리 · {scope==='selected'?`선택한 ${count}개`:`전체 ${count}개`}</summary><div className="caption-tools-body">
    <button type="button" className="button secondary full" disabled={!count||syncBusy} title={!count?'자막이 없습니다.':syncBusy?'싱크를 맞추는 중입니다.':undefined} onClick={onSync}>{syncBusy?<LoaderCircle size={14} className="spin"/>:<AudioWaveform size={14}/>}음성에 싱크 맞추기</button>
    <div className="caption-tools-row"><label><span>최대</span><input type="number" aria-label="나눌 때 자막당 최대 글자" min={4} max={120} value={short} onChange={e=>{const v=Math.round(+e.target.value);setShort(v);if(valid(v))remember('slu-caption-split',v);}}/><span>자</span></label><button type="button" className="button secondary" disabled={!count||!valid(short)} title={!count?'자막이 없습니다.':!valid(short)?'최대 글자는 4–120 사이로 입력하세요.':undefined} onClick={()=>onSplit(short)}><Split size={13}/>짧게 나누기</button></div>
    <div className="caption-tools-row"><label><span>최대</span><input type="number" aria-label="합칠 때 자막당 최대 글자" min={4} max={120} value={long} onChange={e=>{const v=Math.round(+e.target.value);setLong(v);if(valid(v))remember('slu-caption-merge',v);}}/><span>자</span></label><button type="button" className="button secondary" disabled={count<2||!valid(long)} title={count<2?'자막이 2개 이상 있어야 합칠 수 있습니다.':!valid(long)?'최대 글자는 4–120 사이로 입력하세요.':undefined} onClick={()=>onMerge(long)}><Combine size={13}/>길게 합치기</button></div>
    <p className="field-note">싱크는 음성을 듣고 자막을 말하는 위치로 옮깁니다. 나누기는 문장부호·쉼·어미에서 끊습니다.</p>
    </div></details>
  </section>;
}

export function CaptionSyncDialog({count,system,modelBusy,onClose,onInstall,onInstallEngine,onStart}:{count:number;system:SystemInfo|null;modelBusy:boolean;onClose:()=>void;onInstall:(model:SpeechModelId)=>void;onInstallEngine:()=>void;onStart:(language:string,options:SpeechOptions)=>Promise<void>}){
  const [language,setLanguage]=useState('ko'),[busy,setBusy]=useState(false),[model,setModel]=useState<SpeechModelId>(()=>system?.speechModels?.some(m=>m.id==='turbo'&&m.installed)?'turbo':system?.speechModels?.some(m=>m.id==='small'&&m.installed)?'small':'base'),[device,setDevice]=useState<'auto'|'cpu'|'cuda'>('auto');
  const models=system?.speechModels||[{id:'base' as const,name:'Base',bytes:148000000,installed:!!system?.modelReady},{id:'small' as const,name:'Small',bytes:488000000,installed:false},{id:'turbo' as const,name:'Turbo',bytes:574000000,installed:false}],installed=models.find(m=>m.id===model)?.installed;
  return <Modal title="자막 싱크 맞추기" onClose={onClose}>
    <p className="field-note">자막 {count}개의 문장을 타임라인 음성과 맞춰 시작·끝을 옮깁니다. 들리는 영상·오디오 트랙의 소리를 섞어 한 번에 인식하며, 자막 문장 자체는 바꾸지 않습니다. 맞출 말소리를 찾지 못한 자막은 앞뒤 자막 사이에 그대로 둡니다.</p>
    <label className="form-field"><span>음성 언어</span><select value={language} aria-label="싱크 음성 언어" onChange={e=>setLanguage(e.target.value)}><option value="auto">자동 감지</option><option value="ko">한국어</option><option value="en">영어</option><option value="ja">일본어</option><option value="zh">중국어</option><option value="es">스페인어</option><option value="fr">프랑스어</option><option value="de">독일어</option></select></label>
    <label className="form-field"><span>Whisper 모델</span><select aria-label="싱크 음성 인식 모델" value={model} onChange={e=>setModel(e.target.value as SpeechModelId)}>{models.map(m=><option key={m.id} value={m.id}>{m.name} · {Math.round(m.bytes/1000000)} MB{m.installed?' · 설치됨':''}</option>)}</select></label>
    {!installed&&<button className="button secondary full" disabled={modelBusy} onClick={()=>onInstall(model)}>{modelBusy?<LoaderCircle size={14} className="spin"/>:null}선택 모델 설치</button>}
    <label className="form-field"><span>처리 장치</span><select aria-label="싱크 음성 인식 장치" value={device} onChange={e=>setDevice(e.target.value as typeof device)}><option value="auto">자동 {system?.speechCuda?'· CUDA 사용 가능':'· CPU'}</option><option value="cpu">CPU</option><option value="cuda">NVIDIA CUDA</option></select></label>
    {!system?.speechCuda&&<button className="button secondary full" disabled={modelBusy} onClick={onInstallEngine}>CUDA 엔진 설치 · 약 439 MB</button>}
    <div className="modal-actions"><button className="button secondary" onClick={onClose}>취소</button><button className="button primary" disabled={!installed||busy||!count||(device==='cuda'&&!system?.speechCuda)} onClick={async()=>{setBusy(true);try{await onStart(language,{model,device});}finally{setBusy(false);}}}>{busy?<LoaderCircle size={15} className="spin"/>:<AudioWaveform size={15}/>}싱크 맞추기</button></div>
  </Modal>;
}
