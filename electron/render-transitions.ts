import type {CompiledTransition} from '../shared/transitions';
import {transitionDirection} from '../shared/transitions';
import {alphaPremultiply,alphaUnpremultiply} from './alpha-filters';

const number=(value:number)=>Number(value.toPrecision(15)).toString();

/** FFmpeg time is window-local; callers supply an explicit global clock. */
export function transitionProgressExpression(item:CompiledTransition,clock:string):string {
  const p=`clip(((${clock})-${number(item.start)})/${number(item.end-item.start)},0,1)`;
  switch(item.transition.easing){
    case 'ease-in':return `pow(${p},2)`;
    case 'ease-out':return `1-pow(1-${p},2)`;
    case 'ease-in-out':return `if(lt(${p},0.5),2*pow(${p},2),1-2*pow(1-${p},2))`;
    case 'hold':return `gte(${p},1)`;
    default:return p;
  }
}

/** Runtime blend opacity uses the optimized native plane loop; evaluate the
 * easing once per frame instead of once per pixel and color component. */
export function transitionOpacityCommands(item:CompiledTransition,output:string,clock='T'):string {
  return `0-86401 [expr] blend@${output} all_opacity '1-(${transitionProgressExpression(item,clock)})';\n`;
}

/** Inputs are straight RGBA on equal, transparent, full-canvas targets. The
 * blend is encoded RGB, premultiplied in16-bit precision, and unpremultiplied
 * only at the final output boundary before the existing scene compositor. */
export function appendTransitionPair(graph:string[],item:CompiledTransition,from:string,to:string,output:string,width:number,height:number,clock:string|{warp:string;blend:string}='T',opacityCommandFile?:string,initialOpacity=1,wipeTiming?:{fps:number;frames:number;startFrame:number}):void {
  // geq's N starts at0; blend's N starts at1. Separate explicit frame clocks
  // avoid a one-frame mismatch and floating-point window-boundary differences.
  const p=transitionProgressExpression(item,typeof clock==='string'?clock:clock.blend),warpP=transitionProgressExpression(item,typeof clock==='string'?clock:clock.warp),kind=item.transition.kind,[dx,dy]=transitionDirection(item.transition.direction);
  const a=`${output}A`,b=`${output}B`,mixed=`${output}Mixed`;
  const sample=(x:string,y:string)=>{
    // Texture coordinates describe pixel centres. The half-open canvas avoids
    // double contribution when a moving push seam crosses a pixel centre.
    const visible='gte(ld(1),-0.5)*lt(ld(1),W-0.5)*gte(ld(2),-0.5)*lt(ld(2),H-0.5)';
    // geq's expression registers are local to each plane/slice. Every row
    // starts at X=0, so ease once per row and reuse coordinates within a pixel
    // instead of expanding the same easing tree throughout each sample.
    const prefix=`if(eq(X,0),st(0,${warpP}));st(1,${x});st(2,${y});`;
    return `geq=${(['r','g','b','a'] as const).map(channel=>`${channel}='${prefix}if(${visible},${channel==='a'?'alpha':channel}(ld(1),ld(2)),0)'`).join(':')}:interpolation=bilinear`;
  };
  let aWarp='',bWarp='';
  if(kind==='slide'){
    aWarp=sample(`X-ld(0)*${dx*width}`,`Y-ld(0)*${dy*height}`);
    bWarp=sample(`X+(1-ld(0))*${dx*width}`,`Y+(1-ld(0))*${dy*height}`);
  }else if(kind==='zoom'){
    const coordinate=(axis:'X'|'Y',size:number,scale:string)=>`(${axis}+0.5-${number(size/2)})/(${scale})+${number(size/2)}-0.5`;
    aWarp=sample(coordinate('X',width,'1+0.25*ld(0)'),coordinate('Y',height,'1+0.25*ld(0)'));
    bWarp=sample(coordinate('X',width,'0.75+0.25*ld(0)'),coordinate('Y',height,'0.75+0.25*ld(0)'));
  }
  const nativeBlend=!!opacityCommandFile&&(kind==='dissolve'||kind==='zoom');
  const nativeWipe=kind==='wipe'&&!!wipeTiming;
  for(const [input,label,warp] of [[from,a,aWarp],[to,b,bWarp]] as const){
    graph.push(`[${input}]${alphaPremultiply.join(',')}${warp?`,${warp}`:''}[${label}]`);
  }
  let expression:string;
  if(kind==='slide')expression='min(65535,A+B)';
  else if(kind==='wipe'){
    const axis=dx?`(X+0.5)/${width}`:`(Y+0.5)/${height}`,sign=dx||dy;
    const mask=`if(lte(${p},0),0,if(gte(${p},1),1,${sign<0?`gte(${axis},1-(${p}))`:`lt(${axis},${p})`}))`;
    expression=`A*(1-(${mask}))+B*(${mask})`;
  }else expression=`A*(1-(${p}))+B*(${p})`;
  // sendcmd serializes evaluated numbers with C %g (six significant digits).
  // Match that representation at a window's first frame as well.
  if(nativeWipe){
    // A wipe varies along one axis only. Evaluate a two-pixel strip, expand it
    // with nearest-neighbour sampling, then use the native masked merge loop.
    // This avoids evaluating the same edge expression at every canvas pixel.
    const axis=dx?`(X+0.5)/${width}`:`(Y+0.5)/${height}`,negative=(dx||dy)<0,mask=`65535*if(lte(${warpP},0),0,if(gte(${warpP},1),1,${negative?`gte(${axis},1-(${warpP}))`:`lt(${axis},${warpP})`}))`;
    graph.push(`color=c=black:s=${dx?width:2}x${dy?height:2}:r=${number(wipeTiming!.fps)}:d=${number(wipeTiming!.frames/wipeTiming!.fps)},trim=end_frame=${wipeTiming!.frames},format=gbrap16le,geq=r='${mask}':g='${mask}':b='${mask}':a='${mask}',scale=${width}:${height}:flags=neighbor,setpts=PTS+${wipeTiming!.startFrame}[${output}Mask]`);
    graph.push(`[${a}][${b}][${output}Mask]maskedmerge=planes=15[${mixed}]`);
  }else graph.push(`[${a}][${b}]${nativeBlend?`blend@${output}=all_mode=normal:all_opacity=${Number(initialOpacity.toPrecision(6))}`:kind==='slide'?'blend=all_mode=addition':`blend=all_expr='${expression}'`}:shortest=1[${mixed}]`);
  // Commands run AFTER the blend and set the next frame's opacity. Sending
  // from either input allows framesync/lookahead to advance command state
  // ahead of the paired frame, especially when one clip feeds two pairs.
  graph.push(`[${mixed}]${nativeBlend?`sendcmd=f=${opacityCommandFile},`:''}${alphaUnpremultiply.join(',')}[${output}]`);
}
