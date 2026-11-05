import {useState} from 'react';
import {LoaderCircle} from 'lucide-react';
import type {Clip,MediaAsset,StabilizationOptions} from '../shared/types';
import {Modal} from './Dialogs';

export default function StabilizationDialog({clip,media,start,duration,onClose,onApply}:{clip:Clip;media:MediaAsset;start:number;duration:number;onClose:()=>void;onApply:(options:StabilizationOptions)=>Promise<void>}) {
  const saved=clip.stabilization?.options;
  const [smoothing,setSmoothing]=useState(saved?.smoothing??30),[accuracy,setAccuracy]=useState(saved?.accuracy??15),[crop,setCrop]=useState<'auto'|'black'>(saved?.crop??'auto'),[zoom,setZoom]=useState(saved?.zoom??0),[busy,setBusy]=useState(false);
  const valid=Number.isInteger(smoothing)&&smoothing>=0&&smoothing<=120&&Number.isFinite(zoom)&&zoom>=0&&zoom<=20;
  return <Modal title="흔들림 보정" onClose={onClose}>
    <div className="transcribe-source"><div><b>{media.name}</b><span>원본 {start.toFixed(2)}–{(start+duration).toFixed(2)}초</span></div></div>
    <label className="form-field"><span>부드러움 · 프레임</span><input aria-label="보정 부드러움" type="number" min="0" max="120" step="1" value={smoothing} onChange={e=>setSmoothing(+e.target.value)}/></label>
    <label className="form-field"><span>분석</span><select aria-label="보정 분석 정밀도" value={accuracy} onChange={e=>setAccuracy(+e.target.value)}><option value="9">빠르게</option><option value="15">정밀하게</option></select></label>
    <label className="form-field"><span>가장자리 처리</span><select aria-label="보정 가장자리 처리" value={crop} onChange={e=>setCrop(e.target.value as typeof crop)}><option value="auto">자동 확대</option><option value="black">{media.hasAlpha?'투명 여백':'검정 여백'}</option></select></label>
    <label className="form-field"><span>추가 확대 · %</span><input aria-label="보정 추가 확대" type="number" min="0" max="20" step=".5" value={zoom} onChange={e=>setZoom(+e.target.value)}/></label>
    <p className="field-note">자동 확대는 흔들림으로 생기는 여백을 자릅니다. 보정 결과를 적용한 뒤에도 원본으로 되돌릴 수 있습니다.</p>
    <div className="modal-actions"><button className="button secondary" onClick={onClose}>취소</button><button className="button primary" disabled={busy||!valid} onClick={async()=>{setBusy(true);try{await onApply({smoothing,accuracy,shakiness:5,crop,zoom});}finally{setBusy(false);}}}>{busy&&<LoaderCircle size={15} className="spin"/>}분석 후 적용</button></div>
  </Modal>;
}
