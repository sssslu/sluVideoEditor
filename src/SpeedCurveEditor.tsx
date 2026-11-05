import {useEffect,useRef,useState} from 'react';
import type {PointerEvent as ReactPointerEvent} from 'react';
import {Plus,RotateCcw,Trash2} from 'lucide-react';
import type {Clip,SpeedPoint} from '../shared/types';
import {clipSourceSpan,clipSpeedAt,speedCurveMean} from '../shared/speed';
import {clamp} from './editor';
import {NumberField} from './InspectorFields';
import './speed-curve.css';

interface Props {
  clip:Clip;
  time:number;
  onStart:()=>void;
  onChange:(points:SpeedPoint[]|undefined,record?:boolean)=>boolean;
  onSeek:(time:number)=>void;
}
const W=264,H=182,L=30,R=12,T=13,B=25;
const presets:{name:string;description:string;points:SpeedPoint[]}[]=[
  {name:'몽타주',description:'1배와 3배 속도를 번갈아 적용',points:[{position:0,speed:1},{position:.2,speed:3},{position:.4,speed:1},{position:.6,speed:3},{position:.8,speed:1},{position:1,speed:1}]},
  {name:'히어로',description:'중앙 구간을 0.25배로 감속',points:[{position:0,speed:1},{position:.3,speed:1},{position:.5,speed:.25},{position:.7,speed:1},{position:1,speed:1}]},
  {name:'점프',description:'중앙 구간을 3배로 가속',points:[{position:0,speed:.5},{position:.3,speed:1},{position:.5,speed:3},{position:.7,speed:1},{position:1,speed:.5}]},
  {name:'점차 가속',description:'0.5배에서 2배까지 일정하게 가속',points:[{position:0,speed:.5},{position:1,speed:2}]},
  {name:'점차 감속',description:'2배에서 0.5배까지 일정하게 감속',points:[{position:0,speed:2},{position:1,speed:.5}]},
];

export default function SpeedCurveEditor({clip,time,onStart,onChange,onSeek}:Props){
  const [selected,setSelected]=useState(0),[ceiling,setCeiling]=useState(4);
  const svg=useRef<SVGSVGElement>(null),cleanup=useRef<(()=>void)|null>(null);
  const points=clip.speedCurve||[{position:0,speed:clip.speed},{position:1,speed:clip.speed}],active=!!clip.speedCurve;
  const point=points[Math.min(selected,points.length-1)],index=Math.min(selected,points.length-1);
  const largest=Math.max(...points.map(p=>p.speed));
  useEffect(()=>{setSelected(0);},[clip.id]);
  useEffect(()=>{if(largest>ceiling)setCeiling(largest<=8?8:16);},[largest,ceiling]);
  useEffect(()=>()=>cleanup.current?.(),[]);
  const x=(position:number)=>L+position*(W-L-R);
  const y=(speed:number)=>T+(1-(speed-.1)/(ceiling-.1))*(H-T-B);
  const axes=ceiling===4?[.1,1,2,3,4]:ceiling===8?[.1,1,2,4,6,8]:[.1,1,4,8,12,16];
  const line=points.map(p=>`${x(p.position)},${y(p.speed)}`).join(' ');
  const presetName=active?presets.find(preset=>JSON.stringify(preset.points)===JSON.stringify(points))?.name||'':'';
  const local=clamp(time-clip.start,0,clip.duration),fraction=local/clip.duration;
  const coordinates=(clientX:number,clientY:number)=>{const rect=svg.current!.getBoundingClientRect();return {position:clamp((clientX-rect.left)/rect.width*W-L,0,W-L-R)/(W-L-R),speed:clamp(.1+(1-((clientY-rect.top)/rect.height*H-T)/(H-T-B))*(ceiling-.1),.1,ceiling)};};
  const update=(at:number,values:Partial<SpeedPoint>,record=true,base=points)=>{
    const next=base.map(p=>({...p}));
    next[at]={...next[at],...values};
    if(at===0)next[at].position=0;
    else if(at===next.length-1)next[at].position=1;
    else next[at].position=clamp(next[at].position,next[at-1].position+.0001,next[at+1].position-.0001);
    next[at].speed=clamp(next[at].speed,.1,16);
    return onChange(next,record);
  };
  const drag=(event:ReactPointerEvent,at:number)=>{
    if(event.button!==0)return;
    event.preventDefault();event.stopPropagation();setSelected(at);cleanup.current?.();
    const initial=points.map(p=>({...p})),origin={x:event.clientX,y:event.clientY};let started=false;
    const move=(e:PointerEvent)=>{
      if(!started&&Math.hypot(e.clientX-origin.x,e.clientY-origin.y)<2)return;
      if(!started){onStart();started=true;}
      const next=coordinates(e.clientX,e.clientY);update(at,{position:next.position,speed:Math.round(next.speed*100)/100},false,initial);
    };
    const finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);cleanup.current=null;};
    cleanup.current=finish;window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true});window.addEventListener('pointercancel',finish,{once:true});
  };
  const add=(position?:number,speed?:number)=>{
    if(points.length>=32)return;
    let at=position??fraction;
    if(points.some(p=>Math.abs(p.position-at)<.001)){
      let gap=0;for(let i=1;i<points.length;i++){const span=points[i].position-points[i-1].position;if(span>gap){gap=span;at=(points[i].position+points[i-1].position)/2;}}
    }
    at=clamp(at,.0001,.9999);
    const value=speed??clipSpeedAt({...clip,speedCurve:points},at*clip.duration);
    const next=[...points.map(p=>({...p})),{position:at,speed:clamp(value,.1,16)}].sort((a,b)=>a.position-b.position);
    if(onChange(next))setSelected(next.findIndex(p=>p.position===at));
  };
  const remove=(at=index)=>{if(at===0||at===points.length-1)return;if(onChange(points.filter((_,i)=>i!==at)))setSelected(Math.max(0,at-1));};

  return <div className="speed-curve-editor">
    <div className="speed-control-row"><div className="speed-mode segmented"><button className={!active?'active':''} onClick={()=>onChange(undefined)}>일정</button><button className={active?'active':''} onClick={()=>{if(!active)onChange(points);}}>커브</button></div><select aria-label="속도 프리셋" value={presetName} onChange={e=>{const preset=presets.find(p=>p.name===e.target.value);if(preset&&onChange(preset.points))setSelected(0);}}><option value="">{active?'사용자 지정':'프리셋 선택'}</option>{presets.map(preset=><option key={preset.name} value={preset.name} title={preset.description}>{preset.name}</option>)}</select></div>
    <div className="speed-graph-heading"><span>{active?'속도 커브':'일정 속도'} · {points.length}점</span><label>세로 범위<select aria-label="속도 그래프 표시 범위" value={ceiling} onChange={e=>setCeiling(Math.max(+e.target.value,largest<=4?4:largest<=8?8:16))}>{[4,8,16].map(value=><option key={value} value={value}>{value}×</option>)}</select></label></div>
    <svg ref={svg} viewBox={`0 0 ${W} ${H}`} role="group" aria-label="속도 커브 그래프" className="speed-graph" onDoubleClick={e=>{if(!(e.target instanceof SVGCircleElement)){const point=coordinates(e.clientX,e.clientY);add(point.position,Math.round(point.speed*100)/100);}}}>
      <defs><clipPath id="speed-graph-clip"><rect x={L-7} y={T-7} width={W-L-R+14} height={H-T-B+14}/></clipPath></defs>
      {axes.map(rate=><g key={rate} className={rate===1?'speed-unity':'speed-grid'}><line x1={L} x2={W-R} y1={y(rate)} y2={y(rate)}/><text x={L-5} y={y(rate)+3} textAnchor="end">{rate}×</text></g>)}
      {[0,.25,.5,.75,1].map(position=><line className="speed-time-grid" key={position} x1={x(position)} x2={x(position)} y1={T} y2={H-B}/>)}
      <polygon className="speed-area" points={`${x(0)},${H-B} ${line} ${x(1)},${H-B}`}/>
      <polyline className="speed-path" points={line}/>
      <line className="speed-playhead" x1={x(fraction)} x2={x(fraction)} y1={T-4} y2={H-B+4}/>
      <g clipPath="url(#speed-graph-clip)">{points.map((value,at)=><circle key={at} data-speed-point={at} role="button" tabIndex={0} aria-label={`속도 제어점 ${at+1}`} aria-pressed={index===at} className={`speed-point ${index===at?'selected':''}`} cx={x(value.position)} cy={y(value.speed)} r={index===at?5:4} onPointerDown={e=>drag(e,at)} onDoubleClick={e=>e.stopPropagation()} onFocus={()=>setSelected(at)} onKeyDown={e=>{
        if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Delete','Backspace','Enter'].includes(e.key)){e.preventDefault();e.stopPropagation();}
        if(e.key==='Delete'||e.key==='Backspace')remove(at);
        else if(e.key==='Enter')onSeek(clip.start+value.position*clip.duration);
        else if(e.key==='ArrowUp'||e.key==='ArrowDown')update(at,{speed:value.speed+(e.key==='ArrowUp'?1:-1)*(e.shiftKey?.25:.05)});
        else if(e.key==='ArrowLeft'||e.key==='ArrowRight')update(at,{position:value.position+(e.key==='ArrowRight'?1:-1)*(e.shiftKey?.05:.01)});
      }}><title>{(value.position*100).toFixed(1)}% · {value.speed.toFixed(2)}×</title></circle>)}</g>
      <text className="speed-axis-time" x={L} y={H-6}>0초</text><text className="speed-axis-time" x={W-R} y={H-6} textAnchor="end">{clip.duration.toFixed(3)}초</text>
    </svg>
    <div className="speed-point-toolbar"><select aria-label="속도 제어점 선택" value={index} onChange={e=>setSelected(+e.target.value)}>{points.map((value,at)=><option key={at} value={at}>점 {at+1} · {(value.position*100).toFixed(1)}%</option>)}</select><button className="icon-button bordered" title="속도 제어점 추가 · 최대 32개" aria-label="속도 제어점 추가" disabled={points.length>=32} onClick={()=>add()}><Plus size={14}/></button><button className="icon-button bordered" title="선택한 속도 제어점 삭제" disabled={index===0||index===points.length-1} onClick={()=>remove()}><Trash2 size={13}/></button><button className="icon-button bordered" title="속도 커브 해제" disabled={!active} onClick={()=>onChange(undefined)}><RotateCcw size={13}/></button></div>
    <div className="field-grid"><NumberField label="제어점 위치" value={point.position*100} min={index===0?0:(points[index-1].position+.0001)*100} max={index===points.length-1?100:(points[index+1].position-.0001)*100} step={.1} unit="%" disabled={index===0||index===points.length-1} onChange={value=>update(index,{position:value/100})}/><NumberField label="제어점 속도" value={point.speed} min={.1} max={16} step={.05} unit="×" onChange={value=>update(index,{speed:value})}/></div>
    <button className="text-button speed-seek" onClick={()=>onSeek(clip.start+point.position*clip.duration)}>선택 제어점으로 이동 · {(point.position*clip.duration).toFixed(3)}초</button>
    <dl className="speed-summary"><dt>현재 속도</dt><dd>{clipSpeedAt(clip,local).toFixed(2)}×</dd><dt>평균 속도</dt><dd>{(active?speedCurveMean(points):clip.speed).toFixed(2)}×</dd><dt>원본 구간</dt><dd>{clipSourceSpan(clip).toFixed(3)}초</dd><dt>타임라인 길이</dt><dd>{clip.duration.toFixed(3)}초</dd></dl>
  </div>;
}
