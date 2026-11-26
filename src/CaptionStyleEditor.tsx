import {useEffect,useState} from 'react';
import {AlignCenter,AlignLeft,AlignRight,Trash2} from 'lucide-react';
import type {CaptionAnimation,CaptionStyle,Clip} from '../shared/types';
import {CAPTION_FONT_WEIGHTS,defaultCaptionAnimation,defaultCaptionStyle} from '../shared/captions';
import {NumberField,Section} from './InspectorFields';
import {applyCaptionAppearance,builtInCaptionAppearance,captureCaptionAppearance,deleteCaptionPreset,readCaptionPresets,saveCaptionPreset,type CaptionAppearance} from './captions/presets';
import {captionGlyphError} from './captions/glyphs';
import {captionFontAvailable,captionFontError,captionFontsReady,ensureCaptionFonts} from './captions/font';
import {clearTextRunProperties,resolveRunStyle,setTextRunStyle,textRunAt,textRunFonts,type RunStyle} from '../shared/text-runs';
import './captions/styles.css';

/** `selection`: the characters selected in the text box. Font, weight, size and color then apply to
 * just those characters; with nothing selected they apply to the whole text. */
interface Props {clip:Clip;disabled:boolean;onChange:(values:Partial<Clip>,coalesce?:EventTarget)=>void;onApplyMany:(values:CaptionAppearance)=>void;selectedTextCount:number;selection?:{from:number;to:number}}
const animations=[['none','없음'],['fade','페이드'],['pop','확대'],['slide','이동']] as const;
export default function CaptionStyleEditor({clip,disabled,onChange,onApplyMany,selectedTextCount,selection}:Props){
  const [presets,setPresets]=useState(readCaptionPresets),[name,setName]=useState(''),[selectedPreset,setSelectedPreset]=useState(''),[error,setError]=useState('');
  const [fontsReady,setFontsReady]=useState(captionFontsReady);
  useEffect(()=>{const refresh=()=>setPresets(readCaptionPresets());window.addEventListener('slu-caption-presets',refresh);return()=>window.removeEventListener('slu-caption-presets',refresh);},[]);
  const style=clip.captionStyle,animation=clip.captionAnimation||defaultCaptionAnimation(),glyphError=style?captionGlyphError(clip.text||''):undefined;
  const styled=!!style;
  useEffect(()=>{if(!styled)return;let active=true;void ensureCaptionFonts().then(()=>{if(active)setFontsReady(true);},cause=>{if(active)setError(cause instanceof Error?cause.message:String(cause));});return()=>{active=false;};},[styled]);
  const reaticAvailable=fontsReady&&CAPTION_FONT_WEIGHTS.reatic.some(weight=>captionFontAvailable('reatic',weight)),fontError=style&&fontsReady?textRunFonts(clip).map(f=>captionFontError(f.font,f.weight)).find(Boolean):undefined;
  const patch=(values:Partial<CaptionStyle>,coalesce?:EventTarget)=>onChange({captionStyle:{...(style||defaultCaptionStyle()),...values}},coalesce);
  const text=clip.text||'',range=selection&&selection.to>selection.from&&selection.to<=text.length?selection:undefined;
  const look=resolveRunStyle(clip,range?textRunAt(clip.textRuns,range.from):{}),styledRange=!!range&&!!clip.textRuns?.some(run=>run.from<range.to&&run.to>range.from);
  // With a selection the look applies to those characters; otherwise to the whole text, dropping
  // any per-character value of the same property.
  const setLook=(values:Partial<RunStyle>,coalesce?:EventTarget)=>{
    if(range){onChange({textRuns:setTextRunStyle(text,clip.textRuns,range.from,range.to,values)},coalesce);return;}
    const next:Partial<Clip>={textRuns:clearTextRunProperties(text,clip.textRuns,Object.keys(values) as (keyof RunStyle)[])};
    if(values.size!==undefined)next.fontSize=values.size;if(values.color!==undefined)next.color=values.color;
    if((values.font!==undefined||values.weight!==undefined)&&style)next.captionStyle={...style,...(values.font!==undefined?{font:values.font}:{}),...(values.weight!==undefined?{weight:values.weight}:{})};
    onChange(next,coalesce);
  };
  const selectFont=(font:CaptionStyle['font'])=>{if(!style)return;const preferred=font==='reatic'?(look.weight<=500?400:700):font==='gmarket-sans'?(look.weight<=500?500:700):look.weight;const available=CAPTION_FONT_WEIGHTS[font].filter(weight=>captionFontAvailable(font,weight));setLook({font,weight:available.includes(preferred)?preferred:available[0]??preferred});};
  const animate=(values:Partial<CaptionAnimation>)=>onChange({captionAnimation:{...animation,...values},sourceClipOffset:undefined,sourceClipDuration:undefined});
  const apply=(values:CaptionAppearance)=>{setError('');onChange(applyCaptionAppearance(clip,values));};
  return <fieldset className="caption-style-editor" disabled={disabled}>
    <label className="inline-field"><span>자막 스타일</span><input type="checkbox" aria-label="새 자막 스타일 사용" checked={!!style} onChange={e=>onChange(e.target.checked?{captionStyle:defaultCaptionStyle(),captionAnimation:defaultCaptionAnimation(),sourceClipOffset:undefined,sourceClipDuration:undefined}:{captionStyle:undefined,captionAnimation:undefined})}/></label>
    {style&&<>
      <div className="caption-style-presets">{([['outline','외곽선 강조'],['line','줄 배경'],['plain','간결한 자막']] as const).map(([id,label])=><button key={id} type="button" className={`caption-style-tile ${id}`} onClick={()=>apply(builtInCaptionAppearance(id,clip.fontSize))}><span aria-hidden="true">가나다</span><small>{label}</small></button>)}</div>
      <p className={`field-note text-run-scope ${range?'active':''}`} role="status">{range?`선택한 ${[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text.slice(range.from,range.to))].length}글자에만 글꼴·크기·색상을 적용합니다.`:'텍스트 상자에서 일부를 선택하면 그 글자만 글꼴·크기·색상을 바꿉니다.'}{styledRange&&<button type="button" className="text-button tiny" onClick={()=>setLook({font:undefined,weight:undefined,size:undefined,color:undefined})}>선택 글자 스타일 지우기</button>}</p>
      <label className="inline-field"><span>글꼴</span><select aria-label="자막 글꼴" value={look.font} onChange={e=>selectFont(e.target.value as CaptionStyle['font'])}><option value="noto-sans-kr">Noto Sans KR</option><option value="gmarket-sans">Gmarket Sans</option><option value="reatic" disabled={!reaticAvailable}>{!fontsReady?'리틱체 (확인 중)':reaticAvailable?'리틱체':'리틱체 (설치 필요)'}</option></select></label>
      {fontError&&<p className="inline-warning" role="alert">{fontError}</p>}
      {glyphError&&<p className="inline-warning" role="alert">{glyphError}</p>}
      <div className="field-grid"><NumberField label="글자 크기" value={look.size} min={4} max={1000} unit="px" onChange={v=>setLook({size:v})}/><label className="number-field"><span>굵기</span><select aria-label="자막 굵기" value={look.weight} onChange={e=>setLook({weight:+e.target.value as CaptionStyle['weight']})}>{CAPTION_FONT_WEIGHTS[look.font].map(weight=><option key={weight} value={weight} disabled={!captionFontAvailable(look.font,weight)}>{weight}</option>)}</select></label></div>
      <Color label="글자 색상" value={look.color} onChange={(color,field)=>setLook({color},field)}/>
      <div className="inline-field"><span>정렬</span><div className="segmented">{(['left','center','right'] as const).map(align=><button type="button" key={align} title={align==='left'?'왼쪽 정렬':align==='center'?'가운데 정렬':'오른쪽 정렬'} className={clip.align===align?'active':''} onClick={()=>onChange({align})}>{align==='left'?<AlignLeft size={14}/>:align==='center'?<AlignCenter size={14}/>:<AlignRight size={14}/>}</button>)}</div></div>
      <Section title="자막 모양" initialOpen={false}>
        <div className="field-grid"><NumberField label="줄 간격" value={style.lineHeight} min={.8} max={3} step={.05} unit="배" onChange={lineHeight=>patch({lineHeight})}/><NumberField label="자간" value={style.letterSpacing} min={-5} max={40} step={.1} unit="px" onChange={letterSpacing=>patch({letterSpacing})}/><NumberField label="자막 최대 너비" value={style.maxWidth*100} min={10} max={100} unit="%" onChange={v=>patch({maxWidth:v/100})}/><NumberField label="외곽선 두께" value={style.outlineWidth} min={0} max={30} step={.5} unit="px" onChange={outlineWidth=>patch({outlineWidth})}/></div>
        <div className="field-grid"><Color label="외곽선 색상" value={style.outlineColor} onChange={(outlineColor,field)=>patch({outlineColor},field)}/><Color label="그림자 색상" value={style.shadowColor} onChange={(shadowColor,field)=>patch({shadowColor},field)}/></div><NumberField label="그림자 흐림" value={style.shadowBlur} min={0} max={60} unit="px" onChange={shadowBlur=>patch({shadowBlur})}/>
        <label className="inline-field"><span>배경</span><select aria-label="자막 배경 모양" value={style.background} onChange={e=>patch({background:e.target.value as CaptionStyle['background']})}><option value="none">없음</option><option value="line">줄마다 박스</option><option value="box">전체 박스</option></select></label>
        {style.background!=='none'&&<><Color label="박스 색상" value={clip.textBackground} onChange={(textBackground,field)=>onChange({textBackground},field)}/><div className="field-grid"><NumberField label="가로 여백" value={style.paddingX} min={0} max={160} unit="px" onChange={paddingX=>patch({paddingX})}/><NumberField label="세로 여백" value={style.paddingY} min={0} max={160} unit="px" onChange={paddingY=>patch({paddingY})}/><NumberField label="모서리 반경" value={style.radius} min={0} max={160} unit="px" onChange={radius=>patch({radius})}/></div></>}
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
function Color({label,value,onChange}:{label:string;value:string;onChange:(value:string,field:EventTarget)=>void}){return <label className="number-field caption-color"><span>{label}</span><input type="color" aria-label={label} value={value} onChange={e=>onChange(e.target.value,e.currentTarget)}/></label>;}
