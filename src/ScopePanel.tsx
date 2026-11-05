import {useLayoutEffect,useRef,useState} from 'react';
import type {ScopeResult} from '../shared/scopes';
import {formatTime} from './editor';
import './scopes.css';
type Mode='histogram'|'waveform'|'parade'|'vectors';
const colors=['#dce4e9','#f17a89','#6ed5a2','#82acff'];
export default function ScopePanel({result,error,fps}:{result?:ScopeResult;error?:string;fps:number}){
  const [mode,setMode]=useState<Mode>('waveform'),[log,setLog]=useState(false),[size,setSize]=useState({width:400,height:140});
  const canvas=useRef<HTMLCanvasElement>(null),host=useRef<HTMLDivElement>(null),raster=useRef<HTMLCanvasElement|undefined>(undefined);
  useLayoutEffect(()=>{const observer=new ResizeObserver(([entry])=>setSize({width:Math.max(1,entry.contentRect.width),height:Math.max(1,entry.contentRect.height)}));observer.observe(host.current!);return()=>observer.disconnect();},[]);
  useLayoutEffect(()=>{
    const target=canvas.current!,ratio=Math.min(2,devicePixelRatio||1);target.width=Math.round(size.width*ratio);target.height=Math.round(size.height*ratio);const ctx=target.getContext('2d')!;ctx.scale(ratio,ratio);const {width:w,height:h}=size;ctx.fillStyle='#0b0e13';ctx.fillRect(0,0,w,h);ctx.font='10px Consolas,monospace';ctx.textBaseline='middle';
    const left=30,top=13,right=w-10,bottom=h-18,pw=Math.max(1,right-left),ph=Math.max(1,bottom-top),analysis=result?.analysis;
    ctx.strokeStyle='#2a313b';ctx.lineWidth=1;ctx.fillStyle='#8994a4';
    if(mode!=='vectors')for(let i=0;i<=4;i++){const y=top+ph*i/4;ctx.beginPath();ctx.moveTo(left,y+.5);ctx.lineTo(right,y+.5);ctx.stroke();if(mode!=='histogram')ctx.fillText(String(Math.round(255*(1-i/4))),2,y);}
    if(!analysis?.samples){ctx.fillStyle='#8e99a8';ctx.textAlign='center';ctx.fillText(error?'분석할 수 없음':'프레임 대기',w/2,h/2);return;}
    const bitmap=(counts:Uint16Array,columns:number,rows:number,color:number[])=>{const image=new ImageData(columns,rows);let peak=0;for(const count of counts)peak=Math.max(peak,count);const scale=Math.log1p(peak);for(let i=0;i<counts.length;i++){const n=counts[i];if(!n)continue;const alpha=.2+.8*Math.log1p(n)/scale;image.data[i*4]=color[0];image.data[i*4+1]=color[1];image.data[i*4+2]=color[2];image.data[i*4+3]=Math.round(alpha*255);}const offscreen=raster.current??=document.createElement('canvas');offscreen.width=columns;offscreen.height=rows;offscreen.getContext('2d')!.putImageData(image,0,0);return offscreen;};
    if(mode==='histogram'){
      let peak=0;for(const count of analysis.histogram)peak=Math.max(peak,count);const scale=log?Math.log1p(peak):peak;
      for(const c of [1,2,3,0]){ctx.strokeStyle=colors[c];ctx.fillStyle=colors[c];ctx.beginPath();ctx.moveTo(left,bottom);for(let i=0;i<256;i++){const v=analysis.histogram[c*256+i],value=(log?Math.log1p(v):v)/scale;ctx.lineTo(left+pw*i/255,bottom-ph*value);}ctx.lineTo(right,bottom);ctx.closePath();ctx.globalAlpha=c===0?.08:.14;ctx.fill();ctx.globalAlpha=c===0?.65:1;ctx.stroke();}ctx.globalAlpha=1;ctx.fillStyle='#8994a4';ctx.fillText('0',left,bottom+11);ctx.textAlign='right';ctx.fillText('255',right,bottom+11);
    }else if(mode==='waveform'||mode==='parade'){
      const count=mode==='parade'?3:1,plane=analysis.waveWidth*analysis.waveHeight;
      for(let n=0;n<count;n++){const channel=mode==='parade'?n+1:0,counts=analysis.waveform.subarray(channel*plane,(channel+1)*plane),tint=channel===1?[241,122,137]:channel===2?[110,213,162]:channel===3?[130,172,255]:[219,233,239],x=left+pw*n/count;ctx.imageSmoothingEnabled=false;ctx.drawImage(bitmap(counts,analysis.waveWidth,analysis.waveHeight,tint),x,top,pw/count,ph);ctx.fillStyle=colors[channel];ctx.textAlign='center';ctx.fillText(['Y′','R','G','B'][channel],x+pw/count/2,bottom+11);}
    }else{
      const side=Math.max(1,Math.min(w-50,h-28)),x=(w-side)/2,y=(h-side)/2,center=[x+side/2,y+side/2];ctx.imageSmoothingEnabled=false;ctx.drawImage(bitmap(analysis.vectors,128,128,[116,230,204]),x,y,side,side);ctx.strokeStyle='#36414c';ctx.beginPath();ctx.arc(center[0],center[1],side/2,0,Math.PI*2);ctx.moveTo(x,center[1]);ctx.lineTo(x+side,center[1]);ctx.moveTo(center[0],y);ctx.lineTo(center[0],y+side);ctx.stroke();
      const targets:[string,number[]][]=[['R',[1,0,0]],['Y',[1,1,0]],['G',[0,1,0]],['C',[0,1,1]],['B',[0,0,1]],['M',[1,0,1]]];
      for(const [label,rgb] of targets){const [r,g,b]=rgb.map(v=>v*.75),luma=.2126*r+.7152*g+.0722*b,px=x+(.5+(b-luma)/1.8556)*side,py=y+(.5-(r-luma)/1.5748)*side;ctx.strokeRect(px-3,py-3,6,6);ctx.fillStyle='#a5afbc';ctx.textAlign='center';ctx.fillText(label,px,py+(py<center[1]?-11:11));}
    }
  },[result,error,mode,log,size]);
  return <section className="scope-panel" aria-label="색상 스코프" data-scope-serial={result?.serial} data-scope-time={result?.time}>
    <div className="scope-toolbar"><select aria-label="스코프 종류" value={mode} onChange={e=>setMode(e.target.value as Mode)}><option value="waveform">밝기 파형</option><option value="parade">RGB 퍼레이드</option><option value="histogram">히스토그램</option><option value="vectors">벡터스코프</option></select>{mode==='histogram'&&<button className={log?'active':''} aria-pressed={log} onClick={()=>setLog(v=>!v)}>로그 눈금</button>}<span className="scope-range" title="표시된 SDR 합성 화면의 밝기 최솟값과 최댓값">{result?`Y′ ${result.analysis.min[0]}–${result.analysis.max[0]}`:'SDR'}</span><span className="scope-time">{result?formatTime(result.time,fps):'—'}</span></div>
    <div ref={host} className="scope-plot"><canvas ref={canvas} aria-label={`${mode==='histogram'?'히스토그램':mode==='parade'?'RGB 퍼레이드':mode==='vectors'?'벡터스코프':'밝기 파형'} 그래프`}/></div>
    {error&&<span className="scope-error" role="alert">{error}</span>}
  </section>;
}
