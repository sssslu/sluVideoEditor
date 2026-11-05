import {useMemo,useRef,useState} from 'react';
import type {PointerEvent} from 'react';
import {RotateCcw} from 'lucide-react';
import type {AudioEQ,EQBand,EQKind} from '../shared/types';
import {defaultEQ,eqResponse,EQ_KINDS} from '../shared/audio-eq';
import {NumberField,Section,Slider} from './InspectorFields';
import './audio-eq.css';

const kinds:Record<EQKind,string>={highpass:'저역 차단',lowshelf:'저역 선반',peaking:'피크',highshelf:'고역 선반',lowpass:'고역 차단'};
const colors=['#a3bbff','#6cceee','#69d9bc','#d7ce7b','#e6aa76','#cd9ced'];
const X=(hz:number)=>28+Math.log10(hz/20)/3*264,Y=(db:number)=>83-Math.max(-24,Math.min(24,db))*2.5;
const hz=(x:number)=>Math.max(20,Math.min(20000,20*10**((x-28)/264*3)));
type Update=(fn:(eq:AudioEQ)=>AudioEQ|undefined,record?:boolean)=>void;
export default function AudioEQEditor({value,onChange,checkpoint,disabled=false}:{value?:AudioEQ;onChange:Update;checkpoint:()=>void;disabled?:boolean}){
  const eq=value||defaultEQ(),[selected,setSelected]=useState(2),drag=useRef<{index:number;pointer:number}|null>(null),band=eq.bands[selected];
  const path=useMemo(()=>Array.from({length:160},(_,i)=>{const f=20*1000**(i/159);return `${i?'L':'M'}${X(f).toFixed(2)},${Y(eqResponse(eq,f)).toFixed(2)}`;}).join(' '),[eq]);
  const patch=(changes:Partial<EQBand>,record=true,index=selected)=>onChange(e=>({...e,bands:e.bands.map((b,i)=>i===index?{...b,...changes}:b)}),record);
  const move=(event:PointerEvent<SVGSVGElement>)=>{if(!drag.current||drag.current.pointer!==event.pointerId||disabled)return;const rect=event.currentTarget.getBoundingClientRect(),x=(event.clientX-rect.x)/rect.width*320,y=(event.clientY-rect.y)/rect.height*170,b=eq.bands[drag.current.index];patch({frequency:Math.round(hz(x)),...(['peaking','lowshelf','highshelf'].includes(b.type)?{gain:Math.round(Math.max(-18,Math.min(18,(83-y)/2.5))*10)/10}:{})},false,drag.current.index);};
  const preset=(name:string)=>{if(!name)return;onChange(()=>{const e=defaultEQ();if(name==='voice'){e.bands[0].enabled=true;e.bands[0].frequency=90;e.bands[2].frequency=300;e.bands[2].gain=-3;e.bands[3].frequency=3000;e.bands[3].gain=3;e.output=-2;}if(name==='bass'){e.bands[1].gain=4;e.output=-2;}if(name==='soft'){e.bands[4].frequency=6000;e.bands[4].gain=-4;}return e;});};
  return <Section title="이퀄라이저"><fieldset className="audio-eq-editor" disabled={disabled}>
    <div className="eq-toolbar"><label className="eq-enable"><input type="checkbox" aria-label="EQ 사용" checked={eq.enabled} onChange={e=>{const enabled=e.target.checked;onChange(v=>({...v,enabled}));}}/>EQ</label><select aria-label="EQ 프리셋" value="" onChange={e=>preset(e.target.value)}><option value="">프리셋</option><option value="flat">평탄</option><option value="voice">보컬 명료도</option><option value="bass">저음 강조</option><option value="soft">고음 완화</option></select><button className="icon-button small" title="EQ 초기화" onClick={()=>onChange(()=>undefined)}><RotateCcw size={13}/></button></div>
    <svg className={`eq-graph ${eq.enabled?'':'bypassed'}`} viewBox="0 0 320 170" aria-label="EQ 주파수 응답 · 48 kHz 기준" onPointerMove={move} onPointerUp={e=>{if(drag.current?.pointer===e.pointerId){drag.current=null;e.currentTarget.releasePointerCapture(e.pointerId);}}} onPointerCancel={()=>{drag.current=null;}}>
      {[-24,-12,0,12,24].map(db=><g key={db}><line x1={28} x2={292} y1={Y(db)} y2={Y(db)}/><text x={23} y={Y(db)+3} textAnchor="end">{db>0?'+':''}{db}</text></g>)}
      {[20,100,1000,10000,20000].map(f=><g key={f}><line x1={X(f)} x2={X(f)} y1={23} y2={143}/><text x={X(f)} y={162} textAnchor="middle">{f>=1000?`${f/1000}k`:f}</text></g>)}
      <path d={path} className="eq-response"/>
      {eq.bands.map((b,i)=><g key={i} className={`eq-point ${b.enabled?'':'off'} ${selected===i?'selected':''}`} style={{color:colors[i]}}><circle cx={X(b.frequency)} cy={Y(['highpass','lowpass'].includes(b.type)?0:b.gain)} r={selected===i?7:5} role="slider" tabIndex={disabled?-1:0} aria-label={`EQ 밴드 ${i+1} 주파수`} aria-disabled={disabled} aria-valuemin={20} aria-valuemax={20000} aria-valuenow={b.frequency} aria-valuetext={`${b.frequency} Hz · ${b.gain} dB${b.enabled?'':' · 해제'}`} onFocus={()=>setSelected(i)} onKeyDown={e=>{if(disabled||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();setSelected(i);if(e.key==='Home'||e.key==='End')patch({frequency:e.key==='Home'?20:20000},true,i);else if(e.key==='ArrowLeft'||e.key==='ArrowRight')patch({frequency:Math.round(Math.max(20,Math.min(20000,b.frequency*(e.key==='ArrowRight'?1.05:1/1.05))))},true,i);else if(!['highpass','lowpass'].includes(b.type))patch({gain:Math.max(-18,Math.min(18,b.gain+(e.key==='ArrowUp'?1:-1)))},true,i);}} onPointerDown={e=>{if(disabled||e.button!==0)return;e.preventDefault();setSelected(i);checkpoint();drag.current={index:i,pointer:e.pointerId};e.currentTarget.ownerSVGElement!.setPointerCapture(e.pointerId);}}/></g>)}
    </svg>
    <div className="eq-band-tabs" role="tablist" aria-label="EQ 밴드">{eq.bands.map((b,i)=><button key={i} role="tab" aria-selected={i===selected} aria-label={`EQ 밴드 ${i+1}`} style={{color:colors[i]}} className={`${i===selected?'active':''} ${b.enabled?'':'off'}`} onClick={()=>setSelected(i)}>{i+1}</button>)}</div>
    <div className="eq-band-options"><label className="eq-enable"><input type="checkbox" aria-label="EQ 밴드 사용" checked={band.enabled} onChange={e=>patch({enabled:e.target.checked})}/>밴드 {selected+1}</label><select aria-label="EQ 밴드 종류" value={band.type} onChange={e=>patch({type:e.target.value as EQKind})}>{EQ_KINDS.map(k=><option key={k} value={k}>{kinds[k]}</option>)}</select></div>
    <div className="field-grid"><NumberField label="EQ 주파수" value={band.frequency} min={20} max={20000} step={1} unit="Hz" disabled={disabled} onChange={v=>patch({frequency:v})}/>{['lowshelf','highshelf'].includes(band.type)?<NumberField label="EQ 기울기" value={1} unit="S" disabled onChange={()=>{}}/>:<NumberField label="EQ 폭" value={band.q} min={.1} max={10} step={.1} unit="Q" disabled={disabled} onChange={v=>patch({q:v})}/>}</div>
    {!['highpass','lowpass'].includes(band.type)&&<Slider label="EQ 밴드 게인" value={band.gain} min={-18} max={18} step={.1} unit=" dB" onStart={checkpoint} onChange={v=>patch({gain:v},false)}/>}
    <NumberField label="EQ 출력 게인" value={eq.output} min={-18} max={18} step={.1} unit="dB" disabled={disabled} onChange={output=>onChange(v=>({...v,output}))}/>
  </fieldset></Section>;
}
