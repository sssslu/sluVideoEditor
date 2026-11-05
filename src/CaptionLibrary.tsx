import {useEffect,useMemo,useRef,useState} from 'react';
import type {CaptionAppearance} from './captions/presets';
import {builtInCaptionAppearance,readCaptionPresets} from './captions/presets';
import {newClip,newProject} from '../shared/project';
import {resizeCaptionStyle} from '../shared/captions';
import {ensureCaptionFonts,rasterCaption} from './preview/text';
import './caption-library.css';

function Sample({appearance}:{appearance:CaptionAppearance}){
  const ref=useRef<HTMLCanvasElement>(null),[error,setError]=useState('');
  useEffect(()=>{let active=true;void ensureCaptionFonts().then(()=>{
    if(!active||!ref.current)return;
    const project={...newProject(),width:400,height:150},clip={...newClip('text-1'),...appearance,text:'하루를 담는 영상',fontSize:32,captionStyle:resizeCaptionStyle(appearance.captionStyle,32/appearance.fontSize),captionAnimation:undefined,animation:'none' as const,captionWords:[{from:0,to:3,start:0,end:1,timing:'manual' as const}]};
    const frame=rasterCaption(clip,project,1,.5),canvas=ref.current,ctx=canvas.getContext('2d')!;canvas.width=400;canvas.height=120;ctx.clearRect(0,0,400,120);const scale=Math.min(1,380/frame.width,110/frame.height);ctx.drawImage(frame.canvas,(400-frame.width*scale)/2,(120-frame.height*scale)/2,frame.width*scale,frame.height*scale);setError('');
  }).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));});return()=>{active=false;};},[appearance]);
  return error?<span className="inline-warning" role="alert">{error}</span>:<canvas ref={ref} aria-label="자막 스타일 미리보기"/>;
}
export default function CaptionLibrary({fontSize,canApply,onInsert,onApply}:{fontSize:number;canApply:boolean;onInsert:(appearance:CaptionAppearance)=>void;onApply:(appearance:CaptionAppearance)=>void}){
  const [presets,setPresets]=useState(readCaptionPresets);
  useEffect(()=>{const update=()=>setPresets(readCaptionPresets());window.addEventListener('slu-caption-presets',update);return()=>window.removeEventListener('slu-caption-presets',update);},[]);
  const builtins=useMemo(()=>([['outline','외곽선 강조'],['line','줄 배경'],['plain','간결한 자막']] as const).map(([id,name])=>({id,name,appearance:builtInCaptionAppearance(id,fontSize)})),[fontSize]);
  return <div className="caption-library"><div className="section-label">자막 스타일</div>{[...builtins,...presets].map(preset=><div className="caption-library-card" key={preset.id} data-caption-preset={preset.id}><Sample appearance={preset.appearance}/><b>{preset.name}</b><div><button type="button" className="button secondary" aria-label={`${preset.name} 텍스트 삽입`} onClick={()=>onInsert(preset.appearance)}>삽입</button><button type="button" className="button secondary" aria-label={`${preset.name} 선택 자막에 적용`} disabled={!canApply} onClick={()=>onApply(preset.appearance)}>선택에 적용</button></div></div>)}</div>;
}
