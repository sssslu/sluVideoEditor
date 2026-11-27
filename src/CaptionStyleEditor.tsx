import {useEffect,useState} from 'react';
import {AlignCenter,AlignLeft,AlignRight,Trash2} from 'lucide-react';
import type {CaptionStyle,Clip} from '../shared/types';
import {CAPTION_FONT_WEIGHTS,legacyTextCaptionStyle} from '../shared/captions';
import {NumberField,Section} from './InspectorFields';
import {applyCaptionAppearance,builtInCaptionAppearance,captureCaptionAppearance,deleteCaptionPreset,readCaptionPresets,saveCaptionPreset,type CaptionAppearance} from './captions/presets';
import {captionGlyphError} from './captions/glyphs';
import {captionFontAvailable,captionFontError,captionFontsReady,ensureCaptionFonts} from './captions/font';
import {clearTextRunProperties,normalizeTextRuns,resolveRunStyle,setTextRunStyle,textRunAt,textRunFonts,type RunStyle} from '../shared/text-runs';
import {clearTextSelection} from './text-selection';
import './captions/styles.css';

/** `selection`: the characters selected in the text box. Font, weight, size and color then apply to
 * just those characters; with nothing selected they apply to the whole text. */
/** `onPatchMany`: applies an update to every selected caption (style settings); `targets` are those
 * captions, used to show where they differ. */
interface Props {clip:Clip;disabled:boolean;onChange:(values:Partial<Clip>,coalesce?:EventTarget)=>void;onApplyMany:(values:CaptionAppearance)=>void;selectedTextCount:number;targets?:readonly Clip[];selection?:{from:number;to:number};onPatchMany?:(update:(clip:Clip)=>Partial<Clip>,coalesce?:EventTarget)=>void}

export default function CaptionStyleEditor({clip,disabled,onChange,onApplyMany,selectedTextCount,targets,selection,onPatchMany}:Props){
  const [presets,setPresets]=useState(readCaptionPresets),[name,setName]=useState(''),[selectedPreset,setSelectedPreset]=useState(''),[error,setError]=useState('');
  const [fontsReady,setFontsReady]=useState(captionFontsReady);
  useEffect(()=>{const refresh=()=>setPresets(readCaptionPresets());window.addEventListener('slu-caption-presets',refresh);return()=>window.removeEventListener('slu-caption-presets',refresh);},[]);
  // Every text clip has a style (older projects are converted when opened); the fallbacks only keep
  // a clip that somehow arrives without one editable.
  const style=clip.captionStyle??legacyTextCaptionStyle(clip),glyphError=captionGlyphError(clip.text||'');
  useEffect(()=>{let active=true;void ensureCaptionFonts().then(()=>{if(active)setFontsReady(true);},cause=>{if(active)setError(cause instanceof Error?cause.message:String(cause));});return()=>{active=false;};},[]);
  const reaticAvailable=fontsReady&&CAPTION_FONT_WEIGHTS.reatic.some(weight=>captionFontAvailable('reatic',weight)),fontError=fontsReady?textRunFonts(clip).map(f=>captionFontError(f.font,f.weight)).find(Boolean):undefined;
  // With several text clips selected every control applies to all of them; character ranges need a
  // single clip.
  const many=selectedTextCount>1&&!!onPatchMany;
  const all=(update:(target:Clip)=>Partial<Clip>,coalesce?:EventTarget)=>many?onPatchMany!(update,coalesce):onChange(update(clip),coalesce);
  const patch=(values:Partial<CaptionStyle>,coalesce?:EventTarget)=>many?onPatchMany!(c=>({captionStyle:{...(c.captionStyle??legacyTextCaptionStyle(c)),...values}}),coalesce):onChange({captionStyle:{...style,...values}},coalesce);
  const text=clip.text||'',range=!many&&selection&&selection.to>selection.from&&selection.to<=text.length?selection:undefined;
  const look=resolveRunStyle(clip,range?textRunAt(clip.textRuns,range.from):{}),styledRange=!!range&&!!clip.textRuns?.some(run=>run.from<range.to&&run.to>range.from);
  /** The weight `font` has that is closest to `weight` (a tie goes to the heavier one), among the
   * installed ones when any is installed. Gmarket Sans, for one, has only 500 and 700. */
  const fitWeight=(font:CaptionStyle['font'],weight:number):CaptionStyle['weight']=>{const every=CAPTION_FONT_WEIGHTS[font],usable=every.filter(w=>captionFontAvailable(font,w)),list=usable.length?usable:every;return list.reduce((best,w)=>{const d=Math.abs(w-weight),e=Math.abs(best-weight);return d<e||(d===e&&w>best)?w:best;});};
  // With characters selected the look applies to them. Otherwise it applies to the whole text of
  // every selected caption: each caption keeps its own font (a weight it lacks becomes the nearest
  // one it has), so one caption in another font cannot make the whole edit invalid.
  const setLook=(values:Partial<RunStyle>,coalesce?:EventTarget)=>{
    if(range){onChange({textRuns:setTextRunStyle(text,clip.textRuns,range.from,range.to,values.font!==undefined&&values.weight===undefined?{...values,weight:fitWeight(values.font,look.weight)}:values)},coalesce);return;}
    all(target=>{
      // Size and color are plain clip values; font and weight live in the style.
      const base=target.captionStyle??legacyTextCaptionStyle(target),next:Partial<Clip>={};
      if(values.size!==undefined)next.fontSize=values.size;if(values.color!==undefined)next.color=values.color;
      if(values.font!==undefined||values.weight!==undefined){const font=values.font??base.font;next.captionStyle={...base,font,weight:fitWeight(font,values.weight??base.weight)};}
      // One caption: the whole text takes the value, so per-character values of that property go.
      // Several captions: their per-character styles stay; only a weight the new font lacks is fitted.
      const keys=Object.keys(values) as (keyof RunStyle)[];
      if(!many)next.textRuns=clearTextRunProperties(target.text||'',target.textRuns,values.font!==undefined&&!keys.includes('weight')?[...keys,'weight']:keys);
      else if(target.textRuns&&next.captionStyle){const font=next.captionStyle.font;next.textRuns=normalizeTextRuns(target.text||'',target.textRuns.map(run=>run.weight===undefined?run:{...run,weight:fitWeight(run.font??font,run.weight)}));}
      return next;
    },coalesce);
  };
  // What the selected captions disagree on is shown as "여러 값" instead of the first caption's value.
  const differ=<T,>(pick:(target:Clip)=>T)=>many&&!!targets&&targets.some(target=>pick(target)!==pick(targets[0]));
  const styleOf=(target:Clip)=>target.captionStyle??legacyTextCaptionStyle(target);
  const mixedFont=differ(target=>styleOf(target).font),mixedWeight=differ(target=>styleOf(target).weight),mixedBackground=differ(target=>styleOf(target).background);
  const drop=(style.shadowDistance??0)>0;
  const apply=(id:'outline'|'line'|'plain')=>{setError('');all(target=>applyCaptionAppearance(target,builtInCaptionAppearance(id,target.fontSize)));};
  return <fieldset className="caption-style-editor" disabled={disabled}>
    {many&&<p className="field-note caption-many-note" role="status">선택한 자막 {selectedTextCount}개에 함께 적용합니다. 글자별 스타일과 문구는 자막을 하나만 선택해 바꾸세요.</p>}
    <>
      <div className="caption-style-presets">{([['outline','외곽선 강조'],['line','줄 배경'],['plain','간결한 자막']] as const).map(([id,label])=><button key={id} type="button" className={`caption-style-tile ${id}`} onClick={()=>apply(id)}><span aria-hidden="true">가나다</span><small>{label}</small></button>)}</div>
      {!many&&<p className={`field-note text-run-scope ${range?'active':''}`} role="status">{range?`선택한 ${[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text.slice(range.from,range.to))].length}글자에만 글꼴·크기·색상을 적용합니다.`:'텍스트 상자에서 일부를 드래그해 선택하면 그 글자만 글꼴·크기·색상을 바꿉니다.'}{range&&<button type="button" className="text-button tiny" onClick={clearTextSelection}>선택 해제 · 전체에 적용</button>}{styledRange&&<button type="button" className="text-button tiny" onClick={()=>setLook({font:undefined,weight:undefined,size:undefined,color:undefined})}>선택 글자 스타일 지우기</button>}</p>}
      <label className="inline-field"><span>글꼴</span><select aria-label="자막 글꼴" value={mixedFont?'':look.font} onChange={e=>setLook({font:e.target.value as CaptionStyle['font']})}>{mixedFont&&<option value="" disabled hidden>여러 글꼴</option>}<option value="noto-sans-kr">Noto Sans KR</option><option value="gmarket-sans">Gmarket Sans</option><option value="reatic" disabled={!reaticAvailable}>{!fontsReady?'리틱체 (확인 중)':reaticAvailable?'리틱체':'리틱체 (설치 필요)'}</option></select></label>
      {fontError&&<p className="inline-warning" role="alert">{fontError}</p>}
      {glyphError&&<p className="inline-warning" role="alert">{glyphError}</p>}
      <div className="field-grid"><NumberField force={many} label="글자 크기" value={look.size} min={4} max={1000} unit="px" onChange={v=>setLook({size:v})}/><label className="number-field"><span>굵기</span><select aria-label="자막 굵기" value={mixedWeight?'':look.weight} onChange={e=>setLook({weight:+e.target.value as CaptionStyle['weight']})}>{mixedWeight&&<option value="" disabled hidden>여러 값</option>}{CAPTION_FONT_WEIGHTS[look.font].map(weight=><option key={weight} value={weight} disabled={!captionFontAvailable(look.font,weight)}>{weight}</option>)}</select></label></div>
      <Color label="글자 색상" value={look.color} onChange={(color,field)=>setLook({color},field)}/>
      <div className="inline-field"><span>정렬</span><div className="segmented">{(['left','center','right'] as const).map(align=><button type="button" key={align} title={align==='left'?'왼쪽 정렬':align==='center'?'가운데 정렬':'오른쪽 정렬'} className={clip.align===align?'active':''} onClick={()=>all(()=>({align}))}>{align==='left'?<AlignLeft size={14}/>:align==='center'?<AlignCenter size={14}/>:<AlignRight size={14}/>}</button>)}</div></div>
      <Section title="자막 모양" initialOpen={false}>
        <div className="field-grid"><NumberField force={many} label="줄 간격" value={style.lineHeight} min={.8} max={3} step={.05} unit="배" onChange={lineHeight=>patch({lineHeight})}/><NumberField force={many} label="자간" value={style.letterSpacing} min={-5} max={40} step={.1} unit="px" onChange={letterSpacing=>patch({letterSpacing})}/><NumberField force={many} label="자막 최대 너비" value={style.maxWidth*100} min={10} max={100} unit="%" onChange={v=>patch({maxWidth:v/100})}/><NumberField force={many} label="외곽선 두께" value={style.outlineWidth} min={0} max={30} step={.5} unit="px" onChange={outlineWidth=>patch({outlineWidth})}/></div>
        <Color label="외곽선 색상" value={style.outlineColor} onChange={(outlineColor,field)=>patch({outlineColor},field)}/>
        <label className="inline-field"><span>배경</span><select aria-label="자막 배경 모양" value={mixedBackground?'':style.background} onChange={e=>patch({background:e.target.value as CaptionStyle['background']})}>{mixedBackground&&<option value="" disabled hidden>여러 값</option>}<option value="none">없음</option><option value="line">줄마다 박스</option><option value="box">전체 박스</option></select></label>
        {style.background!=='none'&&<><Color label="박스 색상" value={clip.textBackground} onChange={(textBackground,field)=>all(()=>({textBackground}),field)}/><div className="field-grid"><NumberField force={many} label="가로 여백" value={style.paddingX} min={0} max={160} unit="px" onChange={paddingX=>patch({paddingX})}/><NumberField force={many} label="세로 여백" value={style.paddingY} min={0} max={160} unit="px" onChange={paddingY=>patch({paddingY})}/><NumberField force={many} label="모서리 반경" value={style.radius} min={0} max={160} unit="px" onChange={radius=>patch({radius})}/></div></>}
      </Section>
      <Section title="그림자">
        <div className="preset-buttons caption-shadow-presets" role="group" aria-label="그림자 빠른 선택">
          <button type="button" className={!drop&&!style.shadowBlur?'active':''} onClick={()=>patch({shadowDistance:0,shadowBlur:0})}>없음</button>
          <button type="button" className={drop&&!style.shadowBlur?'active':''} onClick={()=>patch({shadowDistance:Math.max(2,Math.round(clip.fontSize*.07)),shadowAngle:45,shadowBlur:0,shadowColor:'#000000',shadowOpacity:.85})}>진한 45°</button>
          <button type="button" className={drop&&style.shadowBlur>0?'active':''} onClick={()=>patch({shadowDistance:Math.max(2,Math.round(clip.fontSize*.05)),shadowAngle:45,shadowBlur:Math.min(60,Math.max(2,Math.round(clip.fontSize*.08))),shadowColor:'#000000',shadowOpacity:.7})}>부드럽게</button>
        </div>
        <div className="field-grid"><NumberField force={many} label="그림자 거리" value={style.shadowDistance??0} min={0} max={100} step={.5} unit="px" onChange={shadowDistance=>patch({shadowDistance})}/><NumberField force={many} label="그림자 각도" value={style.shadowAngle??45} min={-360} max={360} step={1} unit="°" onChange={shadowAngle=>patch({shadowAngle})}/><NumberField force={many} label="그림자 흐림" value={style.shadowBlur} min={0} max={60} unit="px" onChange={shadowBlur=>patch({shadowBlur})}/><NumberField force={many} label="그림자 진하기" value={Math.round((style.shadowOpacity??1)*100)} min={0} max={100} step={1} unit="%" onChange={v=>patch({shadowOpacity:v/100})}/></div>
        <Color label="그림자 색상" value={style.shadowColor} onChange={(shadowColor,field)=>patch({shadowColor},field)}/>
        <p className="field-note">각도 45°는 오른쪽 아래입니다. 거리가 0이면 글자 둘레에 번지는 그림자(글로우)가 됩니다.</p>
      </Section>
      <Section title="스타일 저장 및 적용">
        <div className="caption-preset-save"><input aria-label="자막 스타일 이름" placeholder="스타일 이름" value={name} maxLength={40} onChange={e=>setName(e.target.value)}/><button type="button" className="button secondary" onClick={()=>{try{const preset=saveCaptionPreset(name,captureCaptionAppearance(clip));setPresets(readCaptionPresets());setSelectedPreset(preset.id);setName('');setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}}}>스타일 저장</button></div>
        <div className="caption-preset-save"><select aria-label="저장한 자막 스타일" value={selectedPreset} onChange={e=>setSelectedPreset(e.target.value)}><option value="">지금 이 자막의 스타일</option>{presets.map(preset=><option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><button type="button" className="icon-button" title="선택 스타일 삭제" disabled={!selectedPreset} onClick={()=>{try{deleteCaptionPreset(selectedPreset);setPresets(readCaptionPresets());setSelectedPreset('');setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}}}><Trash2 size={14}/></button></div>
        <button type="button" className="button secondary full" disabled={!selectedTextCount||(!selectedPreset&&selectedTextCount<2)} title={!selectedPreset&&selectedTextCount<2?'저장한 스타일을 고르거나, 자막을 여러 개 선택하면 이 자막의 스타일을 나머지에 입힙니다.':undefined} onClick={()=>{try{const preset=presets.find(preset=>preset.id===selectedPreset);onApplyMany(structuredClone(preset?.appearance||captureCaptionAppearance(clip)));setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}}}>선택 자막에 스타일 적용</button>
        {error&&<p className="inline-warning" role="alert">{error}</p>}
      </Section>
    </>
  </fieldset>;
}
function Color({label,value,onChange}:{label:string;value:string;onChange:(value:string,field:EventTarget)=>void}){return <label className="number-field caption-color"><span>{label}</span><input type="color" aria-label={label} value={value} onChange={e=>onChange(e.target.value,e.currentTarget)}/></label>;}
