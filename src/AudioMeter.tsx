import {useMemo,useState,useSyncExternalStore} from 'react';
import {RotateCcw} from 'lucide-react';
import {AudioPeakHold,levelDb,levelPercent} from '../shared/audio-levels';
import type {AudioMeterFeed} from './preview/audio-meter';
import './audio-meter.css';

const label=(db:number)=>db<=-100?'−∞':`${db>0?'+':''}${db.toFixed(1)}`;
export default function AudioMeter({feed,onReset}:{feed:AudioMeterFeed;onReset:()=>void}){
  const snapshot=useSyncExternalStore(feed.subscribe,feed.getSnapshot),[bus,setBus]=useState(1);
  const hold=useMemo(()=>new AudioPeakHold(),[snapshot.epoch]);
  const held=useMemo(()=>hold.update(snapshot.frame?.peak||[0,0,0,0],snapshot.frame?.time||0),[hold,snapshot.frame]);
  return <section className="audio-meter" aria-label="오디오 레벨" data-meter-sequence={snapshot.frame?.sequence}>
    <div className="audio-meter-heading"><span title="샘플 피크와 RMS. 미리보기 음소거 전의 레벨이며 최종 출력의 LUFS·트루 피크 측정은 아닙니다.">레벨 · dBFS</span><select aria-label="오디오 레벨 위치" value={bus} onChange={e=>setBus(Number(e.target.value))}><option value={0}>리미터 이전</option><option value={1}>리미터 이후</option></select><button className="icon-button small" title="오디오 최대 레벨 초기화" onClick={onReset}><RotateCcw size={12}/></button></div>
    {snapshot.error?<span className="audio-meter-error" role="alert">{snapshot.error}</span>:<div className="audio-meter-bars">{['L','R'].map((channel,index)=>{
      const n=bus*2+index,peak=levelDb(snapshot.frame?.peak[n]||0),rms=levelDb(snapshot.frame?.rms[n]||0);
      return <div className="audio-meter-row" key={channel}><span>{channel}</span><div className={`audio-meter-track ${peak>0?'over':peak>-6?'near':''}`} role="meter" aria-label={`${channel} 채널 피크`} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.min(0,Math.max(-60,peak))} aria-valuetext={`${label(peak)} dBFS`} data-peak={peak} data-rms={rms}>
        <i className="meter-rms" style={{height:`${levelPercent(rms)}%`}}/><i className="meter-peak" style={{height:`${levelPercent(peak)}%`}}/><i className="meter-hold" style={{bottom:`${Math.min(99.6,levelPercent(held[n]))}%`}}/>
        {[-36,-18,-6].map(db=><i key={db} className="meter-tick" style={{bottom:`${levelPercent(db)}%`}}/>)}
      </div><button className={`meter-maximum ${hold.overload[n]?'overload':''}`} aria-label={`${channel} 최대 레벨 초기화`} title={`최대 ${label(hold.maximum[n])} dBFS${hold.overload[n]?' · 0 dBFS 초과':''}`} onClick={onReset} data-overload={hold.overload[n]}>{label(hold.maximum[n])}</button></div>;
    })}<div className="audio-meter-scale"><span>−60</span><span>−36</span><span>−18</span><span>−6</span><span>0</span></div></div>}
  </section>;
}
