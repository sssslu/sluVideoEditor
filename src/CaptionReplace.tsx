import {useState} from 'react';
import type {CaptionReplaceReport} from './captions/replace';
import './caption-replace.css';

export default function CaptionReplace({onReplace}:{onReplace:(find:string,replacement:string)=>CaptionReplaceReport}){
  const [find,setFind]=useState(''),[replacement,setReplacement]=useState(''),[message,setMessage]=useState(''),[error,setError]=useState('');
  const clear=()=>{setMessage('');setError('');};
  return <details className="caption-replace" onKeyDown={event=>{if(event.key===' '||event.key==='Enter')event.stopPropagation();}}><summary>찾아 바꾸기</summary><div>
    <label><span>찾을 내용</span><input aria-label="찾을 자막 내용" value={find} maxLength={20000} onChange={event=>{setFind(event.target.value);clear();}}/></label>
    <label><span>바꿀 내용</span><input aria-label="바꿀 자막 내용" value={replacement} maxLength={20000} onChange={event=>{setReplacement(event.target.value);clear();}}/></label>
    <p className="field-note">전체 자막에서 바꿉니다. 대소문자를 구분하고, 잠긴 트랙은 건너뜁니다.</p>
    <button type="button" className="button secondary full" disabled={!find||find===replacement} title={!find?'찾을 내용을 입력하세요.':find===replacement?'찾을 내용과 바꿀 내용이 같습니다.':undefined} onClick={()=>{clear();try{const result=onReplace(find,replacement);setMessage(result.changedClips?`${result.changedClips}개 자막의 ${result.occurrences}곳을 바꿨습니다.${result.lockedMatches?` 잠긴 트랙 ${result.lockedMatches}곳은 제외했습니다.`:''}`:result.lockedMatches?'일치하는 내용이 모두 잠긴 트랙에 있습니다.':'일치하는 내용이 없습니다.');}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}}>전체 바꾸기</button>
    {message&&<p className="field-note" role="status">{message}</p>}{error&&<p className="inline-warning" role="alert">{error}</p>}
  </div></details>;
}
