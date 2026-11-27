import {useRef,useState} from 'react';
import type {ReactNode} from 'react';
import {ChevronDown} from 'lucide-react';
import {clamp} from './editor';
/** `force`: apply a typed value even when it equals the one shown, for a field that stands for
 * several clips (it shows the first clip's value, which the others may not have). */
export function NumberField({label,value,onChange,min=-10000,max=10000,step=1,unit='',disabled=false,force=false}:{label:string;value:number;onChange:(v:number)=>void|boolean;min?:number;max?:number;step?:number;unit?:string;disabled?:boolean;force?:boolean}) {
  const formatted=String(Number(value.toFixed(4)));
  const [draft,setDraft]=useState(formatted),[focused,setFocused]=useState(false),cancel=useRef(false),edited=useRef(false);
  // Only a value the user typed is applied. The field shows 4 decimals, so writing the shown text back
  // on blur would round the clip, and add an undo step or a keyframe, just for clicking into it.
  const commit=()=>{setFocused(false);const typed=edited.current;edited.current=false;if(cancel.current){cancel.current=false;return;}if(!typed)return;const n=Number(draft);if(draft.trim()&&Number.isFinite(n)){const next=clamp(n,min,max);if(force||Math.abs(next-value)>1e-8)onChange(next);}};
  return <label className="number-field"><span>{label}</span><div><input disabled={disabled} type="number" aria-label={label} value={focused?draft:formatted} min={min} max={max} step={step} onFocus={()=>{setDraft(formatted);setFocused(true);edited.current=false;}} onChange={e=>{edited.current=true;setDraft(e.target.value);}} onBlur={commit} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.currentTarget.blur();}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel.current=true;e.currentTarget.blur();}}}/><small>{unit}</small></div></label>;
}
export function Slider({label,value,onChange,onStart,min,max,step=.01,unit='',display}:{label:string;value:number;onChange:(v:number)=>void;onStart:()=>void;min:number;max:number;step?:number;unit?:string;display?:number}) {return <label className="slider-field"><div><span>{label}</span><span className="slider-value">{display??Number(value.toFixed(2))}{unit}</span></div><input type="range" aria-label={label} min={min} max={max} step={step} value={value} onPointerDown={e=>{if(e.button===0)onStart();}} onKeyDown={e=>{if(!e.repeat&&(e.key.startsWith('Arrow')||['Home','End','PageUp','PageDown'].includes(e.key)))onStart();}} onChange={e=>onChange(+e.target.value)}/></label>;}
export function Section({title,children,action,initialOpen=true}:{title:string;children:ReactNode;action?:ReactNode;initialOpen?:boolean}) {const [open,setOpen]=useState(initialOpen);return <section className="inspector-section"><div className="section-heading"><button onClick={()=>setOpen(!open)} aria-expanded={open}><ChevronDown size={13} style={{transform:open?'':'rotate(-90deg)'}}/>{title}</button>{action}</div>{open&&<div className="section-body">{children}</div>}</section>;}
