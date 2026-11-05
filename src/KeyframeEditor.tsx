import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {PointerEvent as ReactPointerEvent} from 'react';
import {ChevronLeft,ChevronRight,Diamond,Plus,Trash2} from 'lucide-react';
import type {Clip,Keyframe} from '../shared/types';
import {Section} from './InspectorFields';
import {editKeyframe,keyframeCurve,keyframeProperties,keyframeValueRange,sortedKeyframes,toggleKeyframe,type KeyframeProperty} from './keyframe-edits';
import './keyframe-editor.css';

interface Props {
  clip:Clip;
  time:number;
  fps:number;
  disabled:boolean;
  onStart:()=>void;
  onChange:(keys:Keyframe[],record?:boolean)=>boolean;
  onSeek:(time:number)=>void;
}
const W=264,H=142,L=37,R=12,T=12,B=23;
const easings:[NonNullable<Keyframe['easing']>,string][]=[['linear','일정하게'],['ease-in','서서히 시작'],['ease-out','서서히 멈춤'],['ease-in-out','부드럽게'],['hold','유지']];
const properties=Object.keys(keyframeProperties) as KeyframeProperty[];

export default function KeyframeEditor(props:Props){
  const {clip,time,fps,disabled,onStart,onChange,onSeek}=props;
  const [property,setProperty]=useState<KeyframeProperty>('x'),[selected,setSelected]=useState(0);
  const [frozenRange,setFrozenRange]=useState<[number,number]|null>(null);
  const svg=useRef<SVGSVGElement>(null),cleanup=useRef<(()=>void)|null>(null),mounted=useRef(false),latest=useRef(props);
  const dragState=useRef<{committed:string;pending:string[];id:string;start:number;duration:number}|null>(null);
  latest.current=props;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;cleanup.current?.();};},[]);
  useEffect(()=>{if(disabled)cleanup.current?.();},[disabled]);
  useEffect(()=>{cleanup.current?.();setSelected(0);},[clip.id,property]);
  useLayoutEffect(()=>{
    const active=dragState.current;if(!active)return;
    if(disabled||clip.id!==active.id||clip.start!==active.start||clip.duration!==active.duration){cleanup.current?.();return;}
    const rendered=JSON.stringify(clip.keyframes);
    if(rendered===active.committed)return;
    const pending=active.pending.indexOf(rendered);
    if(pending<0){cleanup.current?.();return;}
    active.committed=rendered;active.pending.splice(0,pending+1);
  },[clip,disabled]);
  const keys=sortedKeyframes(clip),local=Math.max(0,Math.min(clip.duration,Math.round((time-clip.start)*fps)/fps));
  const atKey=keys.findIndex(key=>Math.abs(key.time-local)<.5/fps),index=atKey>=0?atKey:Math.min(selected,keys.length-1);
  const config=keyframeProperties[property],[low,high]=frozenRange||keyframeValueRange(clip,property);
  const x=(value:number)=>L+value/clip.duration*(W-L-R),y=(value:number)=>T+(high-value)/(high-low)*(H-T-B);
  const format=(value:number)=>Number((value*config.factor).toFixed(1)).toString();
  const curve=keyframeCurve(clip,property).map(point=>`${x(point.time)},${y(point.value)}`).join(' ');
  const select=(at:number)=>{setSelected(at);onSeek(clip.start+keys[at].time);};
  const remove=(at:number)=>{
    if(disabled)return;
    cleanup.current?.();
    if(onChange(keys.filter((_,index)=>index!==at)))setSelected(Math.max(0,at-1));
  };
  const toggle=()=>{if(!disabled)onChange(toggleKeyframe(clip,local,fps));};
  const update=(at:number,values:{time?:number;value?:number})=>{
    if(disabled)return;
    const next=editKeyframe(clip,at,property,values,fps);
    if(onChange(next)){setSelected(at);onSeek(clip.start+next[at].time);}
  };
  const drag=(event:ReactPointerEvent,at:number)=>{
    if(disabled||event.button!==0)return;
    event.preventDefault();event.stopPropagation();cleanup.current?.();select(at);
    const initial={...clip,keyframes:keys},origin={x:event.clientX,y:event.clientY},rect=svg.current!.getBoundingClientRect();
    const range:[number,number]=[low,high];setFrozenRange(range);
    let started=false;
    const state={committed:JSON.stringify(clip.keyframes),pending:[] as string[],id:clip.id,start:clip.start,duration:clip.duration};dragState.current=state;
    const finish=()=>{
      window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);
      window.removeEventListener('keydown',historyKey,true);dragState.current=null;
      cleanup.current=null;if(mounted.current)setFrozenRange(null);
    };
    const historyKey=(event:KeyboardEvent)=>{if(event.key==='Escape'||((event.ctrlKey||event.metaKey)&&['z','y','o','n'].includes(event.key.toLowerCase())))finish();};
    const move=(e:PointerEvent)=>{
      const current=latest.current;
      if(current.disabled||current.clip.id!==initial.id||current.clip.start!==initial.start||current.clip.duration!==initial.duration){finish();return;}
      const dx=e.clientX-origin.x,dy=e.clientY-origin.y;
      if(!started&&Math.hypot(dx,dy)<2)return;
      if(!started){onStart();started=true;}
      const next=editKeyframe(initial,at,property,{
        ...(Math.abs(dx)>=2?{time:keys[at].time+dx/rect.width*W/(W-L-R)*initial.duration}:{}),
        value:keys[at][property]-dy/rect.height*H/(H-T-B)*(range[1]-range[0]),
      },fps);
      // React can commit several pointer moves together. Reconcile only when
      // props render, so an earlier owned update cannot cancel a later move.
      state.pending.push(JSON.stringify(next));
      if(!current.onChange(next,false)){finish();return;}
      current.onSeek(initial.start+next[at].time);
    };
    cleanup.current=finish;window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true});window.addEventListener('pointercancel',finish,{once:true});window.addEventListener('keydown',historyKey,true);
  };
  return <Section title="키프레임" action={<div className="toolbar-group">
    <button className="icon-button small" title="이전 키프레임" disabled={!keys.some(key=>key.time<local-.5/fps)} onClick={()=>{const previous=[...keys].reverse().find(key=>key.time<local-.5/fps);if(previous)select(keys.indexOf(previous));}}><ChevronLeft size={13}/></button>
    <button className={`icon-button small ${atKey>=0?'active':''}`} title={atKey>=0?'현재 키프레임 삭제':'현재 위치에 키프레임 추가'} disabled={disabled||(atKey<0&&keys.length>=1000)} onClick={toggle}><Diamond size={12} fill={atKey>=0?'currentColor':'none'}/></button>
    <button className="icon-button small" title="다음 키프레임" disabled={!keys.some(key=>key.time>local+.5/fps)} onClick={()=>{const next=keys.findIndex(key=>key.time>local+.5/fps);if(next>=0)select(next);}}><ChevronRight size={13}/></button>
  </div>}>
    <div className="keyframe-editor">
      <label className="keyframe-property"><span>값</span><select aria-label="키프레임 속성" value={property} onChange={e=>setProperty(e.target.value as KeyframeProperty)}>{properties.map(name=><option key={name} value={name}>{keyframeProperties[name].label}</option>)}</select><span>{config.unit}</span></label>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="keyframe-graph" role="group" aria-label={`${config.label} 키프레임 그래프`}>
        <rect className="keyframe-graph-background" x={L} y={T} width={W-L-R} height={H-T-B}/>
        {[0,.5,1].map(fraction=><g key={fraction} className="keyframe-grid"><line x1={L} x2={W-R} y1={T+fraction*(H-T-B)} y2={T+fraction*(H-T-B)}/><text x={L-5} y={T+fraction*(H-T-B)+3} textAnchor="end">{format(high-fraction*(high-low))}</text></g>)}
        <polyline className="keyframe-curve" points={curve}/>
        <line className="keyframe-playhead" x1={x(local)} x2={x(local)} y1={T} y2={H-B}/>
        {keys.map((key,at)=><circle key={at} role="button" aria-label={`키프레임 ${at+1} 그래프 점`} aria-pressed={at===index} aria-disabled={disabled} tabIndex={disabled?-1:0} data-keyframe-point={at} className={`keyframe-point ${at===index?'selected':''}`} cx={x(key.time)} cy={y(key[property])} r={at===index?5:4} onPointerDown={event=>drag(event,at)} onFocus={()=>setSelected(at)} onKeyDown={event=>{
          if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Delete','Backspace','Enter',' '].includes(event.key))return;
          event.preventDefault();event.stopPropagation();if(disabled)return;
          const multiplier=event.shiftKey?10:1;
          if(event.key==='ArrowLeft'||event.key==='ArrowRight')update(at,{time:key.time+(event.key==='ArrowRight'?1:-1)*multiplier/fps});
          if(event.key==='ArrowUp'||event.key==='ArrowDown')update(at,{value:key[property]+(event.key==='ArrowUp'?1:-1)*multiplier*config.step});
          if(event.key==='Delete'||event.key==='Backspace')remove(at);
          if(event.key==='Enter'||event.key===' ')select(at);
        }}><title>{`${key.time.toFixed(3)}초 · ${format(key[property])}${config.unit}. 시간 이동은 모든 변형에 함께 적용됩니다.`}</title></circle>)}
        <text className="keyframe-axis" x={L} y={H-5}>0초</text><text className="keyframe-axis" x={W-R} y={H-5} textAnchor="end">{Number(clip.duration.toFixed(3))}초</text>
      </svg>
      {!!keys.length&&<div className="keyframe-list keyframe-editor-list">{keys.map((key,at)=><div key={at} className={at===index?'active':''}>
        <button title="키프레임으로 이동" onClick={()=>select(at)}><Diamond size={10}/>{key.time.toFixed(3)}s</button>
        <select aria-label={`키프레임 ${at+1} 보간`} disabled={disabled} value={key.easing||'linear'} onChange={e=>onChange(keys.map((value,index)=>index===at?{...value,easing:e.target.value as Keyframe['easing'],easingStart:undefined,easingEnd:undefined}:value))}>{easings.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>
        <button title={`키프레임 ${at+1} 삭제`} disabled={disabled} onClick={()=>remove(at)}><Trash2 size={11}/></button>
      </div>)}</div>}
      {!keys.length&&<button className="button secondary full" disabled={disabled} onClick={toggle}><Plus size={13}/>현재 위치에 키프레임</button>}
    </div>
  </Section>;
}
