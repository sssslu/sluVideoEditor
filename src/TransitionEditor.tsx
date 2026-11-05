import {ArrowRight,Blend,Trash2} from 'lucide-react';
import type {Easing,Project,Transition} from '../shared/types';
import {NumberField,Section} from './InspectorFields';
import './transitions.css';

export const transitionNames:Record<Transition['kind'],string>={dissolve:'디졸브',wipe:'와이프',slide:'밀어내기',zoom:'줌'};
export function TransitionSwatch({kind}:{kind:Transition['kind']}){
  return <span className={`transition-swatch transition-swatch-${kind}`} aria-hidden="true"><span className="transition-scene transition-scene-a">A</span><span className="transition-scene transition-scene-b">B</span></span>;
}

export default function TransitionEditor({project,transition,maxFrames,onChange,onRemove}:{project:Project;transition:Transition;maxFrames:number;onChange:(patch:Partial<Transition>)=>boolean|void;onRemove:()=>void}){
  const from=project.clips.find(c=>c.id===transition.fromClipId),to=project.clips.find(c=>c.id===transition.toClipId),locked=project.tracks.find(t=>t.id===from?.trackId)?.locked;
  const easings:[Easing,string][]=[['linear','일정하게'],['ease-in','서서히 시작'],['ease-out','서서히 멈춤'],['ease-in-out','부드럽게'],['hold','마지막에 전환']];
  return <aside className="inspector transition-inspector" aria-label="전환 속성 패널"><div className="panel-heading"><span>전환 속성</span><Blend size={14}/></div><div className="inspector-scroll">
    <div className="transition-pair"><span title={from?.name}>{from?.name}</span><ArrowRight size={13}/><span title={to?.name}>{to?.name}</span></div>
    {locked&&<p className="inline-warning">잠긴 트랙</p>}
    <fieldset disabled={locked} className="transition-fields">
      <Section title="전환"><div className="transition-kind-grid">{(Object.keys(transitionNames) as Transition['kind'][]).map(kind=><button key={kind} aria-pressed={transition.kind===kind} className={transition.kind===kind?'active':''} onClick={()=>onChange({kind})}><TransitionSwatch kind={kind}/><span>{transitionNames[kind]}</span></button>)}</div>
      <NumberField label="전환 길이" value={transition.durationFrames} min={1} max={maxFrames} step={1} unit="프레임" disabled={locked} onChange={value=>onChange({durationFrames:Math.round(value)})}/><div className="transition-duration-readout"><span>{(transition.durationFrames/project.fps).toFixed(3)}초</span><span>최대 {maxFrames}프레임</span></div>
      <label className="inline-field"><span>진행</span><select aria-label="전환 진행 방식" value={transition.easing||'linear'} onChange={e=>onChange({easing:e.target.value as Easing})}>{easings.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      {(transition.kind==='wipe'||transition.kind==='slide')&&<label className="inline-field"><span>방향</span><select aria-label="전환 방향" value={transition.direction||'left'} onChange={e=>onChange({direction:e.target.value as Transition['direction']})}><option value="left">왼쪽</option><option value="right">오른쪽</option><option value="up">위쪽</option><option value="down">아래쪽</option></select></label>}
      </Section>
      <Section title="오디오"><label className="inline-field"><span>크로스페이드</span><select aria-label="전환 오디오" value={transition.audio||'linear'} onChange={e=>onChange({audio:e.target.value as Transition['audio']})}><option value="linear">선형</option><option value="equal-power">이퀄 파워</option><option value="none">없음</option></select></label></Section>
      <div className="transition-remove"><button className="button secondary full" onClick={onRemove}><Trash2 size={14}/>전환 삭제</button></div>
    </fieldset>
  </div></aside>;
}
