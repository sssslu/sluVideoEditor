import {useId,useState} from 'react';
import {formatProgramTimecode,parseProgramTimecode} from './program-timecode';

interface Props {time:number;fps:number;duration:number;onBeginEdit:()=>number;onSeek:(time:number)=>void;onFinish:()=>void}
export function ProgramTimecodeInput({time,fps,duration,onBeginEdit,onSeek,onFinish}:Props){
  const [draft,setDraft]=useState<string|null>(null),[error,setError]=useState(''),id=useId();
  const formatted=formatProgramTimecode(time,fps),help=`시:분:초:프레임 · ${fps} fps${Number.isInteger(fps)?'':' · 논드롭 프레임 기준'}. Enter로 이동, Esc 또는 포커스 이동으로 취소합니다.`;
  const cancel=()=>{setDraft(null);setError('');};
  return <div className="program-timecode">
    <input type="text" aria-label="현재 시간" aria-describedby={`${id}-help${error?` ${id}-error`:''}`} aria-invalid={!!error} title={help}
      className="program-timecode-input" style={{width:`${formatted.length}ch`}} value={draft??formatted} disabled={!duration} spellCheck={false} autoComplete="off" maxLength={12}
      onFocus={event=>{setDraft(formatProgramTimecode(onBeginEdit(),fps));setError('');event.currentTarget.select();}}
      onChange={event=>{setDraft(event.target.value);setError('');}} onBlur={cancel}
      onKeyDown={event=>{
        if(event.nativeEvent.isComposing)return;
        if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel();onFinish();}
        if(event.key==='Enter'){
          event.preventDefault();event.stopPropagation();const result=parseProgramTimecode(draft??formatted,fps,duration);
          if(!result.ok){setError(result.error);return;}
          onSeek(result.time);cancel();onFinish();
        }
      }}/>
    <span id={`${id}-help`} className="program-timecode-help">{help}</span>
    {error&&<span id={`${id}-error`} className="program-timecode-error" role="alert">{error}</span>}
  </div>;
}
