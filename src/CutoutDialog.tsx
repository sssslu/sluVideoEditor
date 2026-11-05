import {useState} from 'react';
import {LoaderCircle} from 'lucide-react';
import type {CutoutQuality,MediaAsset,PersonCutoutOptions} from '../shared/types';
import {Modal} from './Dialogs';

export default function CutoutDialog({media,start,duration,onClose,onApply}:{media:MediaAsset;start:number;duration:number;onClose:()=>void;onApply:(options:Pick<PersonCutoutOptions,'device'|'quality'>)=>Promise<void>}){
 const [device,setDevice]=useState<'auto'|'cpu'|'gpu'>('auto'),[quality,setQuality]=useState<CutoutQuality>('portrait'),[busy,setBusy]=useState(false);
 return <Modal title="인물 배경 제거" onClose={onClose}>
  <div className="transcribe-source"><div><b>{media.name}</b><span>원본 {start.toFixed(2)}–{(start+duration).toFixed(2)}초</span></div></div>
  <label className="form-field"><span>처리 품질</span><select aria-label="배경 제거 품질" value={quality} onChange={e=>setQuality(e.target.value as CutoutQuality)}><option value="portrait">기본 · 상반신</option><option value="fullbody">기본 · 전신</option><option value="precision">ResNet50 · 전신</option></select></label>
  <label className="form-field"><span>처리 장치</span><select aria-label="배경 제거 처리 장치" value={device} onChange={e=>setDevice(e.target.value as typeof device)}><option value="auto">자동 · GPU 우선</option><option value="gpu">GPU</option><option value="cpu">CPU</option></select></label>
  <p className="field-note">인물이 있는 SDR 영상에 적용합니다. 투명 영상 파일을 만들므로 처리 시간과 저장 공간이 필요합니다. 적용 후 가장자리를 확인하세요.</p>
  {quality==='precision'&&<p className="field-note">더 큰 모델을 사용하며 장면마다 가장자리 결과가 달라집니다. 짧은 구간을 처리해 기본 모델과 비교하세요.</p>}
  <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={onClose}>취소</button><button className="button primary" disabled={busy} onClick={async()=>{setBusy(true);try{await onApply({device,quality});}finally{setBusy(false);}}}>{busy&&<LoaderCircle size={15} className="spin"/>}배경 제거</button></div>
 </Modal>;
}
