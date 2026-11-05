import {useEffect,useRef,useState} from 'react';
import type {PointerEvent as ReactPointerEvent} from 'react';
import {Plus,RotateCcw,Trash2,Upload} from 'lucide-react';
import type {ColorChannel,ColorGrade,ColorLut,ColorPoint,HslBand,HslAdjustment} from '../shared/types';
import {COLOR_CHANNELS,HSL_BANDS,curveEvaluator,IDENTITY_CURVE,clampColor} from '../shared/color';
import {NumberField,Section,Slider} from './InspectorFields';
import './color-grade.css';

interface Props {grade?:ColorGrade;luts:ColorLut[];disabled:boolean;onPatch:(patch:Partial<ColorGrade>,record?:boolean)=>void;onStart:()=>void;onImport:()=>Promise<void>;onReset:()=>void;onPrune:()=>void}
const names={master:'RGB',red:'빨강',green:'초록',blue:'파랑'},W=260,H=202,P=18;
const hslNames={red:'빨강',yellow:'노랑',green:'초록',cyan:'청록',blue:'파랑',magenta:'자홍'};
const neutralHsl:HslAdjustment={hue:0,saturation:0,lightness:0};
export default function ColorGradeEditor({grade,luts,disabled,onPatch,onStart,onImport,onReset,onPrune}:Props){
  const [channel,setChannel]=useState<ColorChannel>('master'),[selected,setSelected]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [band,setBand]=useState<HslBand>('red');
  const adjustment=grade?.hsl?.[band]??neutralHsl;
  const patchHsl=(patch:Partial<HslAdjustment>,record=false)=>{if(!disabled)onPatch({hsl:{[band]:{...adjustment,...patch}}},record);};
  const svg=useRef<SVGSVGElement>(null),cleanup=useRef<(()=>void)|null>(null);
  useEffect(()=>()=>cleanup.current?.(),[]);useEffect(()=>{cleanup.current?.();},[disabled]);
  const points=grade?.curves?.[channel]||IDENTITY_CURVE,index=Math.min(selected,points.length-1),point=points[index],evaluate=curveEvaluator(points);
  const x=(v:number)=>P+v*(W-2*P),y=(v:number)=>H-P-v*(H-2*P);
  const coords=(cx:number,cy:number)=>{const rect=svg.current!.getBoundingClientRect();return {x:clampColor(((cx-rect.left)/rect.width*W-P)/(W-2*P)),y:clampColor(1-((cy-rect.top)/rect.height*H-P)/(H-2*P))};};
  const commit=(next:ColorPoint[],record=true)=>{if(!disabled)onPatch({curves:{...grade?.curves,[channel]:next}},record);};
  const update=(at:number,p:Partial<ColorPoint>,record=true,base=points)=>{if(disabled)return;const next=base.map(v=>({...v}));next[at]={...next[at],...p};next[at].x=at===0?0:at===next.length-1?1:Math.max(base[at-1].x+.0001,Math.min(base[at+1].x-.0001,next[at].x));next[at].y=clampColor(next[at].y);commit(next,record);};
  const add=(p?:ColorPoint)=>{if(disabled||points.length>=16)return;let value=p;if(!value){let left=points[0],right=points[1];for(let i=1;i<points.length;i++)if(points[i].x-points[i-1].x>right.x-left.x){left=points[i-1];right=points[i];}const at=(left.x+right.x)/2;value={x:at,y:evaluate(at)};}if(points.some(v=>Math.abs(v.x-value!.x)<.0001))return;const next=[...points.map(v=>({...v})),value].sort((a,b)=>a.x-b.x);commit(next);setSelected(next.indexOf(value));};
  const remove=(at=index)=>{if(disabled||at===0||at===points.length-1)return;commit(points.filter((_,i)=>i!==at));setSelected(Math.max(0,at-1));};
  const drag=(e:ReactPointerEvent,at:number)=>{if(disabled||e.button!==0)return;e.preventDefault();e.stopPropagation();cleanup.current?.();setSelected(at);const initial=points.map(v=>({...v})),origin=[e.clientX,e.clientY];let moved=false;const move=(ev:PointerEvent)=>{if(!moved&&Math.hypot(ev.clientX-origin[0],ev.clientY-origin[1])<2)return;if(!moved){onStart();moved=true;}update(at,coords(ev.clientX,ev.clientY),false,initial);};const finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);cleanup.current=null;};cleanup.current=finish;window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true});window.addEventListener('pointercancel',finish,{once:true});};
  return <div className="color-grade-editor"><Section title="HSL · 곡선 · LUT" action={<button className="icon-button small" title="색 보정 전체 초기화" disabled={disabled} onClick={onReset}><RotateCcw size={12}/></button>}>
    <label className="inline-field"><span>색 보정 사용</span><input type="checkbox" aria-label="HSL·곡선·LUT 사용" disabled={disabled} checked={grade?.enabled??true} onChange={e=>onPatch({enabled:e.target.checked})}/></label>
    <fieldset className="hsl-controls" disabled={disabled}>
      <div className="inline-field"><label htmlFor="hsl-band">HSL 색상군</label><select id="hsl-band" aria-label="HSL 색상군" value={band} onChange={e=>setBand(e.target.value as HslBand)}>{HSL_BANDS.map(name=><option key={name} value={name}>{hslNames[name]}</option>)}</select><button className="icon-button small" title="선택한 HSL 색상군 초기화" onClick={()=>patchHsl(neutralHsl,true)}><RotateCcw size={12}/></button></div>
      <Slider label="HSL 색조" value={adjustment.hue} min={-60} max={60} step={1} unit="°" onStart={onStart} onChange={value=>patchHsl({hue:value})}/>
      <Slider label="HSL 채도" value={adjustment.saturation*100} min={-100} max={100} step={1} unit="%" onStart={onStart} onChange={value=>patchHsl({saturation:value/100})}/>
      <Slider label="HSL 명도" value={adjustment.lightness*100} min={-100} max={100} step={1} unit="%" onStart={onStart} onChange={value=>patchHsl({lightness:value/100})}/>
    </fieldset>
    <div className="color-channels" role="group" aria-label="곡선 채널">{COLOR_CHANNELS.map(c=><button key={c} className={`color-channel ${c} ${channel===c?'active':''}`} aria-pressed={channel===c} onClick={()=>{cleanup.current?.();setChannel(c);setSelected(0);}}>{names[c]}</button>)}</div>
    <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className={`color-graph ${channel}`} role="group" aria-label={`${names[channel]} 색상 곡선`} onDoubleClick={e=>{if(!(e.target instanceof SVGCircleElement))add(coords(e.clientX,e.clientY));}}>
      <rect className="color-graph-bg" x={P} y={P} width={W-2*P} height={H-2*P}/>{[0,.25,.5,.75,1].map(v=><g key={v} className="color-grid"><line x1={x(v)} x2={x(v)} y1={P} y2={H-P}/><line x1={P} x2={W-P} y1={y(v)} y2={y(v)}/></g>)}
      <line className="color-diagonal" x1={P} x2={W-P} y1={H-P} y2={P}/><polyline className="color-line" points={Array.from({length:129},(_,i)=>`${x(i/128)},${y(evaluate(i/128))}`).join(' ')}/>
      {points.map((p,i)=><circle key={i} data-color-point={i} role="button" aria-label={`색상 제어점 ${i+1}`} aria-disabled={disabled} aria-pressed={i===index} tabIndex={disabled?-1:0} className={`color-point ${i===index?'selected':''}`} cx={x(p.x)} cy={y(p.y)} r={i===index?5:4} onPointerDown={e=>drag(e,i)} onFocus={()=>setSelected(i)} onDoubleClick={e=>e.stopPropagation()} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Delete','Backspace'].includes(e.key)){e.preventDefault();e.stopPropagation();}const step=e.shiftKey?.05:.005;if(e.key==='Delete'||e.key==='Backspace')remove(i);if(e.key==='ArrowLeft'||e.key==='ArrowRight')update(i,{x:p.x+(e.key==='ArrowRight'?step:-step)});if(e.key==='ArrowUp'||e.key==='ArrowDown')update(i,{y:p.y+(e.key==='ArrowUp'?step:-step)});}}/>)}
      <text x={P} y={H-3}>0</text><text x={W-P} y={H-3} textAnchor="end">255</text><text x={P-4} y={P+3} textAnchor="end">255</text>
    </svg>
    <div className="color-point-toolbar"><select aria-label="색상 제어점 선택" value={index} onChange={e=>setSelected(+e.target.value)}>{points.map((p,i)=><option key={i} value={i}>점 {i+1} · {Math.round(p.x*255)}</option>)}</select><button className="icon-button bordered" title="색상 제어점 추가" disabled={disabled||points.length>=16} onClick={()=>add()}><Plus size={14}/></button><button className="icon-button bordered" title="색상 제어점 삭제" disabled={disabled||index===0||index===points.length-1} onClick={()=>remove()}><Trash2 size={13}/></button><button className="icon-button bordered" title="현재 색상 채널 초기화" disabled={disabled} onClick={()=>{const curves={...grade?.curves};delete curves[channel];onPatch({curves});setSelected(0);}}><RotateCcw size={13}/></button></div>
    <div className="field-grid"><NumberField label="곡선 입력" value={point.x*255} min={index===0?0:(points[index-1].x+.0001)*255} max={index===points.length-1?255:(points[index+1].x-.0001)*255} step={1} disabled={disabled||index===0||index===points.length-1} onChange={v=>update(index,{x:v/255})}/><NumberField label="곡선 출력" value={point.y*255} min={0} max={255} step={1} disabled={disabled} onChange={v=>update(index,{y:v/255})}/></div>
    <label className="inline-field"><span>LUT</span><select aria-label="색상 LUT" disabled={disabled} value={grade?.lutId||''} onChange={e=>onPatch({lutId:e.target.value||undefined})}><option value="">없음</option>{luts.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
    <button className="button secondary full" disabled={disabled||busy} onClick={async()=>{setBusy(true);setError('');try{await onImport();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}><Upload size={13}/>{busy?'LUT 읽는 중':'LUT 가져오기'}</button>
    {grade?.lutId&&<Slider label="LUT 강도" value={grade.intensity} min={0} max={1} display={Math.round(grade.intensity*100)} unit="%" onStart={onStart} onChange={v=>{if(!disabled)onPatch({intensity:v},false);}}/>}
    {!!luts.length&&<button className="text-button" disabled={disabled} onClick={onPrune}>사용하지 않는 LUT 정리</button>}
    {error&&<p className="inline-warning" role="alert">{error}</p>}
  </Section></div>;
}
