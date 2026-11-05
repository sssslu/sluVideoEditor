import {useEffect,useState} from 'react';
import {AlignCenter,AlignLeft,AlignRight,Trash2} from 'lucide-react';
import type {CaptionAnimation,CaptionStyle,Clip} from '../shared/types';
import {defaultCaptionAnimation,defaultCaptionStyle} from '../shared/captions';
import {NumberField,Section} from './InspectorFields';
import {applyCaptionAppearance,builtInCaptionAppearance,captureCaptionAppearance,deleteCaptionPreset,readCaptionPresets,saveCaptionPreset,type CaptionAppearance} from './captions/presets';
import {captionGlyphError} from './captions/glyphs';
import './captions/styles.css';

interface Props {clip:Clip;disabled:boolean;onChange:(values:Partial<Clip>)=>void;onApplyMany:(values:CaptionAppearance)=>void;selectedTextCount:number}
const animations=[['none','없음'],['fade','페이드'],['pop','확대'],['slide','이동']] as const;
export default function CaptionStyleEditor({clip,disabled,onChange,onApplyMany,selectedTextCount}:Props){
  const [presets,setPresets]=useState(readCaptionPresets),[name,setName]=useState(''),[selectedPreset,setSelectedPreset]=useState(''),[error,setError]=useState('');
  useEffect(()=>{const refresh=()=>setPresets(readCaptionPresets());window.addEventListener('slu-caption-presets',refresh);return()=>window.removeEventListener('slu-caption-presets',refresh);},[]);
  const style=clip.captionStyle,animation=clip.captionAnimation||defaultCaptionAnimation(),glyphError=style?captionGlyphError(clip.text||''):undefined;
  const patch=(values:Partial<CaptionStyle>)=>onChange({captionStyle:{...(style||defaultCaptionStyle()),...values}});
  const animate=(values:Partial<CaptionAnimation>)=>onChange({captionAnimation:{...animation,...values},sourceClipOffset:undefined,sourceClipDuration:undefined});
  const apply=(values:CaptionAppearance)=>{setError('');onChange(applyCaptionAppearance(clip,values));};
  return <fieldset className="caption-style-editor" disabled={disabled}>
    <label className="inline-field"><span>자막 스타일</span><input type="checkbox" aria-label="새 자막 스타일 사용" checked={!!style} onChange={e=>onChange(e.target.checked?{captionStyle:defaultCaptionStyle(),captionAnimation:defaultCaptionAnimation(),sourceClipOffset:undefined,sourceClipDuration:undefined}:{captionStyle:undefined,captionAnimation:undefined})}/></label>
    {style&&<>
      <div className="caption-style-presets">{([['outline','외곽선 강조'],['line','줄 배경'],['plain','간결한 자막']] as const).map(([id,label])=><button key={id} type="button" className={`caption-style-tile ${id}`} onClick={()=>apply(builtInCaptionAppearance(id,clip.fontSize))}><span aria-hidden="true">가나다</span><small>{label}</small></button>)}</div>
      <label className="inline-field"><span>글꼴</span><select aria-label="자막 글꼴" value={style.font} onChange={e=>patch({font:e.target.value as CaptionStyle['font'],weight:e.target.value==='gmarket-sans'?(style.weight<=500?500:700):style.weight})}><option value="noto-sans-kr">Noto Sans KR</option><option value="gmarket-sans">Gmarket Sans</option></select></label>
      {glyphError&&<p className="inline-warning" role="alert">{glyphError}</p>}
      <div className="field-grid"><NumberField label="글자 크기" value={clip.fontSize} min={4} max={1000} unit="px" onChange={v=>onChange({fontSize:v})}/><label className="number-field"><span>굵기</span><select aria-label="자막 굵기" value={style.weight} onChange={e=>patch({weight:+e.target.value as CaptionStyle['weight']})}>{(style.font==='gmarket-sans'?[500,700]:[400,500,600,700,800]).map(weight=><option key={weight} value={weight}>{weight}</option>)}</select></label></div>
      <div className="field-grid"><Color label="글자 색상" value={clip.color} onChange={color=>onChange({color})}/><Color label="강조 색상" value={style.activeColor} onChange={activeColor=>patch({activeColor})}/></div>
      <label className="inline-field"><span>단어 강조</span><input type="checkbox" aria-label="단어 강조" checked={style.highlight} onChange={e=>patch({highlight:e.target.checked})}/></label>
      {!clip.captionWords?.length&&style.highlight&&<p className="field-note">단어 시간은 자막 목록에서 지정하세요.</p>}
      {clip.captionWords?.some(word=>word.timing==='estimated')&&<label className="inline-field"><span>추정 시간 사용</span><input type="checkbox" aria-label="추정 시간 강조 허용" checked={!!style.highlightEstimated} onChange={e=>patch({highlightEstimated:e.target.checked})}/></label>}
      <div className="inline-field"><span>정렬</span><div className="segmented">{(['left','center','right'] as const).map(align=><button type="button" key={align} title={align==='left'?'왼쪽 정렬':align==='center'?'가운데 정렬':'오른쪽 정렬'} className={clip.align===align?'active':''} onClick={()=>onChange({align})}>{align==='left'?<AlignLeft size={14}/>:align==='center'?<AlignCenter size={14}/>:<AlignRight size={14}/>}</button>)}</div></div>
      <Section title="자막 모양" initialOpen={false}>
        <div className="field-grid"><NumberField label="줄 간격" value={style.lineHeight} min={.8} max={3} step={.05} unit="배" onChange={lineHeight=>patch({lineHeight})}/><NumberField label="자간" value={style.letterSpacing} min={-5} max={40} step={.1} unit="px" onChange={letterSpacing=>patch({letterSpacing})}/><NumberField label="자막 최대 너비" value={style.maxWidth*100} min={10} max={100} unit="%" onChange={v=>patch({maxWidth:v/100})}/><NumberField label="외곽선 두께" value={style.outlineWidth} min={0} max={30} step={.5} unit="px" onChange={outlineWidth=>patch({outlineWidth})}/></div>
        <div className="field-grid"><Color label="외곽선 색상" value={style.outlineColor} onChange={outlineColor=>patch({outlineColor})}/><Color label="그림자 색상" value={style.shadowColor} onChange={shadowColor=>patch({shadowColor})}/></div><NumberField label="그림자 흐림" value={style.shadowBlur} min={0} max={60} unit="px" onChange={shadowBlur=>patch({shadowBlur})}/>
        <label className="inline-field"><span>배경</span><select aria-label="자막 배경 모양" value={style.background} onChange={e=>patch({background:e.target.value as CaptionStyle['background']})}><option value="none">없음</option><option value="line">줄마다 박스</option><option value="box">전체 박스</option></select></label>
        {style.background!=='none'&&<><Color label="박스 색상" value={clip.textBackground} onChange={textBackground=>onChange({textBackground})}/><div className="field-grid"><NumberField label="가로 여백" value={style.paddingX} min={0} max={160} unit="px" onChange={paddingX=>patch({paddingX})}/><NumberField label="세로 여백" value={style.paddingY} min={0} max={160} unit="px" onChange={paddingY=>patch({paddingY})}/><NumberField label="모서리 반경" value={style.radius} min={0} max={160} unit="px" onChange={radius=>patch({radius})}/></div></>}
      </Section>
      <Section title="자막 애니메이션" initialOpen={false}>
        {!clip.captionAnimation?<><p className="field-note">기존 효과: {animations.find(([id])=>id===clip.animation)?.[1]}</p><button type="button" className="button secondary full" onClick={()=>animate(defaultCaptionAnimation())}>등장·퇴장 따로 설정</button></>:<><div className="field-grid">{(['entry','exit'] as const).map(key=><label key={key} className="number-field"><span>{key==='entry'?'등장':'퇴장'}</span><select aria-label={key==='entry'?'자막 등장 효과':'자막 퇴장 효과'} value={animation[key]} onChange={e=>animate({[key]:e.target.value})}>{animations.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>)}<NumberField label="자막 등장 시간" value={animation.entrySeconds} min={0} max={Math.max(10,animation.entrySeconds)} step={.01} unit="초" onChange={entrySeconds=>animate({entrySeconds})}/><NumberField label="자막 퇴장 시간" value={animation.exitSeconds} min={0} max={Math.max(10,animation.exitSeconds)} step={.01} unit="초" onChange={exitSeconds=>animate({exitSeconds})}/></div>
        <label className="inline-field"><span>진행</span><select aria-label="자막 애니메이션 진행" value={animation.easing} onChange={e=>animate({easing:e.target.value as CaptionAnimation['easing']})}><option value="linear">일정하게</option><option value="ease-in">서서히 시작</option><option value="ease-out">서서히 멈춤</option><option value="ease-in-out">부드럽게</option><option value="hold">유지</option></select></label>
        </>}
      </Section>
      <Section title="스타일 저장 및 적용">
        <div className="caption-preset-save"><input aria-label="자막 스타일 이름" placeholder="스타일 이름" value={name} maxLength={40} onChange={e=>setName(e.target.value)}/><button type="button" className="button secondary" onClick={()=>{try{const preset=saveCaptionPreset(name,captureCaptionAppearance(clip));setPresets(readCaptionPresets());setSelectedPreset(preset.id);setName('');setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}}}>스타일 저장</button></div>
        <div className="caption-preset-save"><select aria-label="저장한 자막 스타일" value={selectedPreset} onChange={e=>setSelectedPreset(e.target.value)}><option value="">현재 자막 스타일</option>{presets.map(preset=><option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><button type="button" className="icon-button" title="선택 스타일 삭제" disabled={!selectedPreset} onClick={()=>{try{deleteCaptionPreset(selectedPreset);setPresets(readCaptionPresets());setSelectedPreset('');setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}}}><Trash2 size={14}/></button></div>
        <button type="button" className="button secondary full" disabled={!selectedTextCount} onClick={()=>{try{const preset=presets.find(preset=>preset.id===selectedPreset);onApplyMany(structuredClone(preset?.appearance||captureCaptionAppearance(clip)));setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}}}>선택 자막에 스타일 적용</button>
        {error&&<p className="inline-warning" role="alert">{error}</p>}
      </Section>
    </>}
  </fieldset>;
}
function Color({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>void}){return <label className="number-field caption-color"><span>{label}</span><input type="color" aria-label={label} value={value} onChange={e=>onChange(e.target.value)}/></label>;}
