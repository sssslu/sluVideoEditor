import {useId,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Search,X} from 'lucide-react';
import type {Clip,Track} from '../shared/types';
import {formatProgramTimecode} from './preview/program-timecode';
import {findTimelineClips} from './timeline-search';
import './timeline-search.css';

const ROW=64,HEIGHT=256;
interface Props {clips:Clip[];tracks:Track[];fps:number;onChoose:(id:string,additive:boolean)=>void;onClose:()=>void}
export default function TimelineClipFinder({clips,tracks,fps,onChoose,onClose}:Props){
  const [query,setQuery]=useState(''),[active,setActive]=useState(0),[top,setTop]=useState(0);
  const input=useRef<HTMLInputElement>(null),list=useRef<HTMLDivElement>(null),box=useRef<HTMLDivElement>(null),prefix=useId();
  const [placement,setPlacement]=useState({above:true,anchor:38,height:HEIGHT});
  const matches=useMemo(()=>findTimelineClips(clips,tracks,query,fps),[clips,tracks,query,fps]);
  const index=matches.length?Math.min(active,matches.length-1):-1,first=Math.max(0,Math.floor(top/ROW)-2),last=Math.min(matches.length,Math.ceil((top+HEIGHT)/ROW)+2);
  const rows=Array.from({length:Math.max(0,last-first)},(_,offset)=>first+offset);
  if(index>=0&&!rows.includes(index))rows.push(index);
  const resultId=(at:number)=>`${prefix}-result-${at}`;
  useLayoutEffect(()=>{input.current?.focus();},[]);
  useLayoutEffect(()=>{
    const parent=box.current?.parentElement,field=box.current?.querySelector('.timeline-find-field'),count=box.current?.querySelector('.timeline-find-count');if(!parent||!field||!count)return;
    const measure=()=>{const bounds=parent.getBoundingClientRect(),anchor=parent.querySelector('.timeline-toolbar')?.getBoundingClientRect().height||38,y=bounds.top+anchor,header=field.getBoundingClientRect().height+count.getBoundingClientRect().height+2,safeTop=(document.querySelector('.app-header')?.getBoundingClientRect().bottom||0)+8,aboveSpace=Math.max(0,y-safeTop),belowSpace=Math.max(0,innerHeight-y-8),above=aboveSpace>=header+ROW||aboveSpace>=belowSpace,height=Math.min(HEIGHT,Math.max(0,(above?aboveSpace:belowSpace)-header));setPlacement(old=>old.above===above&&old.anchor===anchor&&old.height===height?old:{above,anchor,height});};
    const observer=new ResizeObserver(measure);observer.observe(parent);observer.observe(field);observer.observe(count);window.addEventListener('resize',measure);measure();return()=>{observer.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  useLayoutEffect(()=>{const el=list.current;if(!el||index<0)return;const y=index*ROW;if(y<el.scrollTop)el.scrollTop=y;else if(y+ROW>el.scrollTop+el.clientHeight)el.scrollTop=y+ROW-el.clientHeight;setTop(el.scrollTop);},[index,query,placement.height]);
  return <div ref={box} id="timeline-clip-finder" className="timeline-clip-finder" style={placement.above?{bottom:`calc(100% - ${placement.anchor}px)`}:{top:placement.anchor,bottom:'auto'}} role="search" aria-label="타임라인 클립 찾기" onKeyDown={event=>{
    event.stopPropagation();if(event.nativeEvent.isComposing)return;
    if(event.key==='Escape'){event.preventDefault();onClose();}
  }}>
    <div className="timeline-find-field"><Search size={15}/><input ref={input} data-timeline-find-input aria-label="클립, 자막, 트랙 또는 시작 시간 검색" placeholder="클립 · 자막 · 트랙 · 시작 시간" role="combobox" aria-autocomplete="list" aria-expanded={true} aria-controls={`${prefix}-results`} aria-activedescendant={index>=0?resultId(index):undefined} value={query} maxLength={200} onChange={event=>{setQuery(event.target.value);setActive(0);}} onKeyDown={event=>{
      if(event.nativeEvent.isComposing)return;
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(Math.max(0,Math.min(matches.length-1,index+(event.key==='ArrowDown'?1:-1))));}
      else if(event.key==='Enter'){event.preventDefault();if(index>=0)onChoose(matches[index].clip.id,event.shiftKey);}
    }}/><button type="button" className="icon-button" aria-label="클립 찾기 닫기" title="닫기 (Esc)" onClick={onClose}><X size={15}/></button></div>
    <div className="timeline-find-count"><span role="status">{query.trim()?`${matches.length}개 결과`:'이름 · 트랙 2 · 00:01:30:00 · 90초'}</span><small>Shift+Enter / Shift+클릭 · 선택에 추가</small></div>
    <div ref={list} className="timeline-find-results" id={`${prefix}-results`} role="listbox" aria-label="클립 검색 결과" style={{height:Math.min(placement.height,matches.length*ROW)}} onScroll={event=>setTop(event.currentTarget.scrollTop)}>
      <div style={{height:matches.length*ROW,position:'relative'}}>{rows.map(at=>{const {clip,track,trackIndex}=matches[at],states=[track.locked?'잠김':'',track.hidden?'숨김':'',track.muted?'음소거':''].filter(Boolean).join(' · ');return <button type="button" tabIndex={-1} key={clip.id} id={resultId(at)} role="option" aria-selected={at===index} aria-posinset={at+1} aria-setsize={matches.length} className={`timeline-find-result ${at===index?'active':''}`} style={{top:at*ROW,height:ROW}} onPointerDown={event=>{event.preventDefault();setActive(at);}} onClick={event=>onChoose(clip.id,event.shiftKey)}>
        <strong>{clip.name}</strong><span className="timeline-find-location">트랙 {trackIndex+1} · {track.name} · {formatProgramTimecode(clip.start,fps)}{states&&` · ${states}`}</span>{clip.text&&clip.text!==clip.name&&<small>{clip.text.replace(/\s+/g,' ')}</small>}
      </button>;})}</div>
    </div>
  </div>;
}
