import {useEffect,useState} from 'react';
import type {CaptionWord,Clip} from '../shared/types';
import {assertCaptionWords,estimateCaptionWords} from '../shared/captions';
import {NumberField} from './InspectorFields';
import './caption-words.css';

interface Props {clip:Clip;time:number;fps:number;locked:boolean;onSeek:(time:number)=>void;onChange:(words:CaptionWord[]|undefined)=>boolean|void}
export default function CaptionWordEditor({clip,time,fps,locked,onSeek,onChange}:Props){
  const [selected,setSelected]=useState(0),[error,setError]=useState('');
  useEffect(()=>{setSelected(0);setError('');},[clip.id,clip.text]);
  const words=clip.captionWords||[],index=Math.min(selected,Math.max(0,words.length-1)),word=words[index],local=time-clip.start;
  const commit=(next:CaptionWord[]|undefined)=>{if(locked)return false;try{if(next)assertCaptionWords(clip.text||'',next,0,clip.duration);if(onChange(next)===false)return false;setError('');return true;}catch(e){setError(e instanceof Error?e.message:String(e));return false;}};
  const update=(values:Partial<CaptionWord>)=>word?commit(words.map((w,i)=>i===index?{...w,...values,timing:'manual'}:w)):false;
  return <section className="caption-word-editor" aria-label="단어 시간 편집"><div className="caption-word-heading"><b>단어 시간</b>{!!words.length&&<button className="text-button tiny" disabled={locked} onClick={()=>commit(undefined)}>시간 지우기</button>}</div>
    {!words.length?<><p className="functional-note">단어 시간이 없습니다.</p><button className="button secondary full" disabled={locked||!clip.text?.trim()} onClick={()=>{try{const next=estimateCaptionWords(clip);if(!next.length)throw new Error('시간을 배치할 단어가 없습니다.');commit(next);}catch(e){setError(e instanceof Error?e.message:String(e));}}}>단어 시간 균등 배치 · 추정</button></>:<>
    <div className="caption-word-strip" aria-label="자막 단어">{words.map((w,i)=><button type="button" key={i} aria-pressed={i===index} className={`${i===index?'selected ':''}${local>=w.start&&local<w.end?'playing':''}`} title={`${w.start.toFixed(3)}–${w.end.toFixed(3)}초 · ${w.timing==='measured'?'음성 인식':w.timing==='manual'?'직접 지정':'추정'}`} onClick={()=>{setSelected(i);onSeek(clip.start+w.start);}}>{clip.text?.slice(w.from,w.to)}</button>)}</div>
    {!clip.captionStyle&&<p className="caption-word-provenance">단어 강조는 속성의 자막 스타일에서 켤 수 있습니다.</p>}
    {word&&<div key={`${clip.id}:${index}`}><div className="caption-word-provenance">{word.timing==='measured'?'음성 인식 시간':word.timing==='manual'?'직접 지정한 시간':'균등 배치한 추정 시간'}</div><div className="field-grid"><NumberField disabled={locked} label="단어 시작" value={word.start} min={words[index-1]?.end??0} max={word.end-Math.min(.001,(word.end-word.start)/2)} step={1/fps} unit="초" onChange={value=>update({start:value})}/><NumberField disabled={locked} label="단어 끝" value={word.end} min={word.start+Math.min(.001,(word.end-word.start)/2)} max={words[index+1]?.start??clip.duration} step={1/fps} unit="초" onChange={value=>update({end:value})}/></div>
    <div className="caption-word-actions"><button className="text-button tiny" disabled={locked||local<(words[index-1]?.end??0)||local>=word.end} onClick={()=>update({start:local})}>현재 위치를 시작으로</button><button className="text-button tiny" disabled={locked||local<=word.start||local>(words[index+1]?.start??clip.duration)} onClick={()=>update({end:local})}>현재 위치를 끝으로</button><button className="text-button tiny" disabled={locked} onClick={()=>commit(words.filter((_,i)=>i!==index))}>이 단어 시간 지우기</button></div></div>}</>}
    {error&&<p className="inline-warning" role="alert">{error}</p>}
  </section>;
}
