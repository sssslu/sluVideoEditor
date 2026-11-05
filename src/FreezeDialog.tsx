import {useState} from 'react';
import {Modal} from './Dialogs';
import {minFreezeFrames} from './freeze';
export default function FreezeDialog({name,sourceTime,fps,onClose,onApply}:{name:string;sourceTime:number;fps:number;onClose:()=>void;onApply:(duration:number)=>Promise<void>}){
  const [frames,setFrames]=useState(Math.round(3*fps)),[busy,setBusy]=useState(false);
  const minimum=minFreezeFrames(fps);
  return <Modal title="정지 프레임 삽입" onClose={onClose}>
    <div className="transcribe-source"><div><b>{name}</b><span>원본 {sourceTime.toFixed(3)}초</span></div></div>
    <label className="form-field"><span>정지 길이 · 초</span><input aria-label="정지 프레임 길이" type="number" min={minimum/fps} max="3600" step={1/fps} value={Number((frames/fps).toFixed(6))} onChange={event=>setFrames(Math.round(Number(event.target.value)*fps))}/></label>
    <p className="field-note">선택한 트랙의 뒤 클립이 정지 길이만큼 밀립니다. 다른 트랙의 위치는 유지됩니다.</p>
    <div className="modal-actions"><button className="button secondary" onClick={onClose}>취소</button><button className="button primary" disabled={busy||!Number.isInteger(frames)||frames<minimum||frames>3600*fps} onClick={async()=>{setBusy(true);try{await onApply(frames/fps);}finally{setBusy(false);}}}>삽입</button></div>
  </Modal>;
}
