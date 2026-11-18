import type {CaptionStyle} from '../../shared/types';
import {missingCaptionFont} from '../../shared/caption-font-error';

/** Private family names keep bundled fonts separate from the two explicitly supported local faces. */
export const CAPTION_FONT_FAMILY='SLU Noto Sans KR';
export const CAPTION_DISPLAY_FAMILY='SLU Gmarket Sans';
export const CAPTION_LOCAL_FAMILY='SLU REATIC';
export const CAPTION_EMOJI_FAMILY='SLU Noto Color Emoji';
export const CAPTION_FONT_STACK=`"${CAPTION_FONT_FAMILY}","${CAPTION_EMOJI_FAMILY}"`;
export const CAPTION_FONT_HASH='194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252';
export const CAPTION_DISPLAY_HASH='ff7c354dd1a324e4cecc1223c4f71e74fa81be7027e0c7f6324c475909cacefc:c6b9a2c10bfdb55975948ce191f9cf638955b5cfdc99149969add5b579262fc1';

export function captionFontStack(font:CaptionStyle['font']) {
  if(font==='reatic')return `"${CAPTION_LOCAL_FAMILY}",${CAPTION_FONT_STACK}`;
  return font==='gmarket-sans'?`"${CAPTION_DISPLAY_FAMILY}",${CAPTION_FONT_STACK}`:CAPTION_FONT_STACK;
}

let pending:Promise<void>|undefined,loaded=false;
const localWeights=new Set<CaptionStyle['weight']>();
export function captionFontAvailable(font:CaptionStyle['font'],weight:CaptionStyle['weight']):boolean {
  return font!=='reatic'||localWeights.has(weight);
}
export function captionFontError(font:CaptionStyle['font'],weight:CaptionStyle['weight']):string|undefined {
  if(captionFontAvailable(font,weight))return undefined;
  return `리틱체 ${weight===700?'Bold':'Regular'} (${weight})가 설치되어 있지 않습니다. 원본 글꼴을 설치한 뒤 앱을 다시 실행하거나 다른 글꼴을 선택하세요. 이 자막은 미리보기와 출력에 사용할 수 없습니다.`;
}
/** Both Vite entries use the same bundled assets and optional installed REATIC faces.
 * No font download or arbitrary user-selected file is permitted by this loader. */
export function ensureCaptionFonts():Promise<void>{
  if(pending)return pending;
  pending=(async()=>{
    const url=new URL('../assets/fonts/NotoSansKR-VF.ttf',import.meta.url).href,emojiUrl=new URL('../assets/fonts/NotoColorEmoji.ttf',import.meta.url).href;
    try{
      const face=new FontFace(CAPTION_FONT_FAMILY,`url(${JSON.stringify(url)})`,{style:'normal',weight:'100 900',display:'block'});
      const emojiFace=new FontFace(CAPTION_EMOJI_FAMILY,`url(${JSON.stringify(emojiUrl)})`,{style:'normal',weight:'100 900',display:'block'});
      const mediumUrl=new URL('../assets/fonts/GmarketSansTTFMedium.ttf',import.meta.url).href;
      const boldUrl=new URL('../assets/fonts/GmarketSansTTFBold.ttf',import.meta.url).href;
      const medium=new FontFace(CAPTION_DISPLAY_FAMILY,`url(${JSON.stringify(mediumUrl)})`,{style:'normal',weight:'400 500',display:'block'});
      const bold=new FontFace(CAPTION_DISPLAY_FAMILY,`url(${JSON.stringify(boldUrl)})`,{style:'normal',weight:'600 800',display:'block'});
      const faces=[face,emojiFace,medium,bold];
      await Promise.all(faces.map(font=>font.load()));
      for(const font of faces)document.fonts.add(font);
      await Promise.all([400,500,600,700,800].map(weight=>document.fonts.load(`${weight} 32px "${CAPTION_FONT_FAMILY}"`,'한국어 Caption')));
      await document.fonts.load(`400 32px "${CAPTION_EMOJI_FAMILY}"`,'👩‍💻👨‍👩‍👧‍👦👍🏽');
      await Promise.all([500,700].map(weight=>document.fonts.load(`${weight} 32px "${CAPTION_DISPLAY_FAMILY}"`,'한국어 Caption')));
      if(faces.some(font=>font.status!=='loaded')||!document.fonts.check(`700 32px ${CAPTION_FONT_STACK}`,'한국어 Caption 👩‍💻'))throw new Error('FontFace did not become ready');
      // A missing local face must never make the bundled caption families fail.
      // Layout checks the requested weight separately to reject synthetic substitutes.
      await Promise.all(([['Regular',400],['Bold',700]] as const).map(async([name,weight])=>{
        try{
          const local=new FontFace(CAPTION_LOCAL_FAMILY,`local("REATIC-${name}"), local("REATIC ${name}"), local("리틱체 ${name}")`,{style:'normal',weight:String(weight),display:'block'});
          await local.load();if(local.status!=='loaded')return;
          document.fonts.add(local);localWeights.add(weight);
        }catch{/* Optional local fonts are reported only when selected. */}
      }));
      loaded=true;
    }catch(error){throw new Error('자막 글꼴을 불러오지 못했습니다. 앱 파일을 확인한 뒤 다시 실행해 주세요.',{cause:error});}
  })();return pending;
}
export function captionFontsReady(){return loaded;}
export function requireCaptionFonts(font?:CaptionStyle['font'],weight?:CaptionStyle['weight']){
  if(!loaded)throw new Error('자막 글꼴을 불러오는 중입니다.');
  const message=font&&weight?captionFontError(font,weight):undefined;
  if(message)throw missingCaptionFont(message);
}
