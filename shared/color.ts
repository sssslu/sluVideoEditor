import type {ColorChannel,ColorCurves,ColorGrade,ColorHsl,ColorLut,ColorPoint,HslBand} from './types';

export const COLOR_CHANNELS:ColorChannel[]=['master','red','green','blue'];
export const HSL_BANDS:HslBand[]=['red','yellow','green','cyan','blue','magenta'];
export const HSL_LUT_SIZE=33;
export const CURVE_SAMPLES=4096;
export const MAX_LUT_BYTES=16*1024*1024;
export const MAX_PROJECT_LUT_VALUES=2_000_000;
export const IDENTITY_CURVE:ColorPoint[]=[{x:0,y:0},{x:1,y:1}];
export const clampColor=(value:number)=>Math.max(0,Math.min(1,value));
const finite=(v:unknown,min:number,max:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const label=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f]/.test(v);
const littleEndian=new Uint8Array(new Uint32Array([0x12345678]).buffer)[0]===0x78;
const decodedLuts=new Map<string,Float32Array>(),decodedObjects=new WeakMap<ColorLut,{data:string;values:WeakRef<Float32Array>}>();let decodedBytes=0;
export function encodeLutData(values:ArrayLike<number>):string {
  const floats=Float32Array.from(values),bytes=new Uint8Array(floats.buffer);if(!littleEndian){const view=new DataView(bytes.buffer);for(let i=0;i<floats.length;i++)view.setFloat32(i*4,values[i],true);}
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
}
/** Packed numbers keep project IPC small. Decode once, with a 48MiB resident cache. */
export function lutValues(lut:ColorLut):Float32Array {
  const previous=decodedObjects.get(lut),retained=previous?.data===lut.data?previous.values.deref():undefined;if(retained)return retained;
  let values=decodedLuts.get(lut.data);
  if(values){decodedLuts.delete(lut.data);decodedLuts.set(lut.data,values);}
  else{
    const binary=atob(lut.data),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);values=new Float32Array(bytes.buffer);
    if(!littleEndian){const view=new DataView(bytes.buffer);values=Float32Array.from({length:bytes.length/4},(_,i)=>view.getFloat32(i*4,true));}
    if(values.length!==3*lut.size**3||!values.every(v=>finite(v,-16,16)))throw new Error('LUT에 잘못된 숫자 데이터가 있습니다.');
    const cost=lut.data.length*2+values.byteLength;decodedLuts.set(lut.data,values);decodedBytes+=cost;
    for(const [key,value]of decodedLuts){if(decodedBytes<=48*1024*1024)break;decodedLuts.delete(key);decodedBytes-=key.length*2+value.byteLength;}
  }
  if(values.length!==3*lut.size**3)throw new Error('LUT 크기와 데이터 개수가 다릅니다.');decodedObjects.set(lut,{data:lut.data,values:new WeakRef(values)});return values;
}
export function assertColorLut(value:unknown):asserts value is ColorLut {
  if(!object(value)||!label(value.id,128)||!label(value.name,200)||!Number.isInteger(value.size)||!finite(value.size,2,65))throw new Error('올바르지 않은 LUT 정보입니다.');
  const lut=value as unknown as ColorLut;
  for(const domain of [lut.domainMin,lut.domainMax])if(!Array.isArray(domain)||domain.length!==3||!domain.every(v=>finite(v,-16,16)))throw new Error('LUT 입력 범위가 잘못되었습니다.');
  if(lut.domainMin.some((v,i)=>lut.domainMax[i]-v<.000001)||lut.encoding!=='f32le'||typeof lut.data!=='string'||lut.data.length!==Math.ceil(12*lut.size**3/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(lut.data))throw new Error('LUT 데이터 또는 입력 범위가 잘못되었습니다.');
  lutValues(lut);
}
export function assertColorGrade(value:unknown,luts:ReadonlySet<string>):asserts value is ColorGrade {
  if(!object(value)||typeof value.enabled!=='boolean'||!finite(value.intensity,0,1)||(value.lutId!==undefined&&(typeof value.lutId!=='string'||!luts.has(value.lutId))))throw new Error('색 보정 설정 또는 LUT 참조가 잘못되었습니다.');
  if(value.hsl!==undefined){
    if(!object(value.hsl)||Object.keys(value.hsl).some(key=>!HSL_BANDS.includes(key as HslBand)))throw new Error('HSL 색상군이 잘못되었습니다.');
    for(const adjustment of Object.values(value.hsl)){
      if(!object(adjustment)||Object.keys(adjustment).some(key=>!['hue','saturation','lightness'].includes(key))||!finite(adjustment.hue,-60,60)||!finite(adjustment.saturation,-1,1)||!finite(adjustment.lightness,-1,1))throw new Error('HSL은 색조 ±60°, 채도와 명도 ±100% 범위가 필요합니다.');
    }
  }
  if(value.curves===undefined)return;
  if(!object(value.curves)||Object.keys(value.curves).some(k=>!COLOR_CHANNELS.includes(k as ColorChannel)))throw new Error('색상 곡선 채널이 잘못되었습니다.');
  for(const points of Object.values(value.curves)){
    if(!Array.isArray(points)||points.length<2||points.length>16||points[0]?.x!==0||points.at(-1)?.x!==1)throw new Error('색상 곡선은 양 끝점을 포함해 2–16개 점이 필요합니다.');
    for(let i=0;i<points.length;i++)if(!object(points[i])||!finite(points[i].x,0,1)||!finite(points[i].y,0,1)||(i>0&&points[i].x-points[i-1].x<.0001-1e-12))throw new Error('색상 곡선의 점이 잘못되었습니다.');
  }
}

/** Strict bounded 3D .cube reader. Ambiguous/mixed 1D+3D files must not silently change the look. */
export function parseCube(text:string,name='LUT'):Omit<ColorLut,'id'> {
  if(text.length>MAX_LUT_BYTES||text.includes('\0'))throw new Error('LUT 파일은 16MiB 이하의 텍스트여야 합니다.');
  let size=0,title=name.replace(/[\x00-\x1f]/g,' ').trim().slice(0,200)||'LUT',started=false;
  let domainMin:[number,number,number]=[0,0,0],domainMax:[number,number,number]=[1,1,1];
  const seen=new Set<string>(),data:number[]=[];
  const number=(s:string)=>{if(!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s))throw new Error('LUT에 숫자가 아닌 값이 있습니다.');const n=Number(s);if(!finite(n,-16,16))throw new Error('LUT 값은 -16–16 범위여야 합니다.');return n;};
  for(const original of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
    if(original.length>4096)throw new Error('LUT 데이터 줄이 너무 깁니다.');
    const line=original.trim();if(!line||line.startsWith('#'))continue;
    if(line.startsWith('TITLE')){const match=/^TITLE\s+"([^"\x00-\x1f]{1,200})"\s*(?:#.*)?$/.exec(line);if(started||seen.has('TITLE')||!match)throw new Error('LUT 제목이 잘못되었습니다.');seen.add('TITLE');title=match[1];continue;}
    const fields=line.split('#')[0].trim().split(/\s+/),key=fields[0];
    if(/^[A-Z][A-Z0-9_]*$/.test(key)){
      if(started||seen.has(key))throw new Error('LUT 헤더의 순서 또는 중복 항목이 잘못되었습니다.');seen.add(key);
      if(key==='LUT_3D_SIZE'){size=Number(fields[1]);if(fields.length!==2||!/^\d+$/.test(fields[1])||!Number.isInteger(size)||size<2||size>65)throw new Error('3D LUT 크기는 2–65여야 합니다.');}
      else if(key==='DOMAIN_MIN'||key==='DOMAIN_MAX'){if(fields.length!==4||seen.has('LUT_3D_INPUT_RANGE'))throw new Error('LUT 입력 범위가 모호합니다.');const values=fields.slice(1).map(number) as [number,number,number];if(key==='DOMAIN_MIN')domainMin=values;else domainMax=values;}
      else if(key==='LUT_3D_INPUT_RANGE'){if(fields.length!==3||seen.has('DOMAIN_MIN')||seen.has('DOMAIN_MAX'))throw new Error('LUT 입력 범위가 모호합니다.');domainMin=[number(fields[1]),number(fields[1]),number(fields[1])];domainMax=[number(fields[2]),number(fields[2]),number(fields[2])];}
      else throw new Error(`지원하지 않는 LUT 항목: ${key}. 3D .cube 파일을 사용하세요.`);
    }else{
      started=true;if(!size||fields.length!==3||data.length>=size**3*3)throw new Error('LUT 크기와 색상 데이터 개수가 다릅니다.');for(const value of fields)data.push(number(value));
    }
  }
  const result={name:title,size,domainMin,domainMax,encoding:'f32le' as const,data:encodeLutData(data)};assertColorLut({...result,id:'import'});return result;
}

/** Shape-preserving cubic Hermite interpolation: no overshoot between neighboring points. */
export function curveEvaluator(points:ColorPoint[]=IDENTITY_CURVE):(x:number)=>number {
  const n=points.length,d=points.slice(1).map((p,i)=>(p.y-points[i].y)/(p.x-points[i].x)),m=new Array<number>(n);
  m[0]=d[0];m[n-1]=d[n-2];
  for(let i=1;i<n-1;i++){
    if(d[i-1]*d[i]<=0)m[i]=0;
    else{const a=points[i].x-points[i-1].x,b=points[i+1].x-points[i].x,w1=2*b+a,w2=b+2*a;m[i]=(w1+w2)/(w1/d[i-1]+w2/d[i]);}
  }
  return x=>{x=clampColor(x);let i=0;while(i<n-2&&x>points[i+1].x)i++;const h=points[i+1].x-points[i].x,t=(x-points[i].x)/h,t2=t*t,t3=t2*t;return clampColor((2*t3-3*t2+1)*points[i].y+(t3-2*t2+t)*h*m[i]+(-2*t3+3*t2)*points[i+1].y+(t3-t2)*h*m[i+1]);};
}
const curvesCache=new WeakMap<ColorCurves,Float32Array>();
export function curveTable(curves:ColorCurves):Float32Array {
  const cached=curvesCache.get(curves);if(cached)return cached;
  const master=curveEvaluator(curves.master),channels=[curves.red,curves.green,curves.blue].map(p=>curveEvaluator(p)),table=new Float32Array(CURVE_SAMPLES*3);
  for(let i=0;i<CURVE_SAMPLES;i++){const x=master(i/(CURVE_SAMPLES-1));for(let c=0;c<3;c++)table[i*3+c]=channels[c](x);}
  curvesCache.set(curves,table);return table;
}
export function sampleCurve(table:Float32Array,value:number,channel:number):number {const x=clampColor(value)*(CURVE_SAMPLES-1),i=Math.floor(x),j=Math.min(i+1,CURVE_SAMPLES-1);return table[i*3+channel]+(table[j*3+channel]-table[i*3+channel])*(x-i);}

/** Four-vertex tetrahedral interpolation, independent of GPU texture filtering support. */
export function sampleLut(lut:ColorLut,r:number,g:number,b:number,out:number[]=[0,0,0],data=lutValues(lut)):number[] {
  const n=lut.size,k=n-1,x=clampColor((r-lut.domainMin[0])/(lut.domainMax[0]-lut.domainMin[0]))*k,y=clampColor((g-lut.domainMin[1])/(lut.domainMax[1]-lut.domainMin[1]))*k,z=clampColor((b-lut.domainMin[2])/(lut.domainMax[2]-lut.domainMin[2]))*k;
  const ix=Math.min(Math.floor(x),n-2),iy=Math.min(Math.floor(y),n-2),iz=Math.min(Math.floor(z),n-2),dx=x-ix,dy=y-iy,dz=z-iz;
  let a:number,bp:number,f1:number,f2:number,f3:number;
  if(dx>=dy){if(dy>=dz){a=1;bp=1+n;f1=dx;f2=dy;f3=dz;}else if(dx>=dz){a=1;bp=1+n*n;f1=dx;f2=dz;f3=dy;}else{a=n*n;bp=1+n*n;f1=dz;f2=dx;f3=dy;}}
  else{if(dx>=dz){a=n;bp=1+n;f1=dy;f2=dx;f3=dz;}else if(dy>=dz){a=n;bp=n+n*n;f1=dy;f2=dz;f3=dx;}else{a=n*n;bp=n+n*n;f1=dz;f2=dy;f3=dx;}}
  const base=(ix+n*(iy+n*iz))*3,p1=base+3*a,p2=base+3*bp,p3=base+3*(1+n+n*n);
  for(let c=0;c<3;c++)out[c]=clampColor(data[base+c]*(1-f1)+data[p1+c]*(f1-f2)+data[p2+c]*(f2-f3)+data[p3+c]*f3);
  return out;
}
export function hasColorHsl(hsl:ColorHsl|undefined):boolean {
  return !!hsl&&HSL_BANDS.some(band=>{const value=hsl[band];return !!value&&(value.hue!==0||value.saturation!==0||value.lightness!==0);});
}

/** Adjacent hue bands overlap with smoothstep weights. A chroma ramp protects
 * gray and near-gray pixels; saturation gain remains proportional to input.
 * HSL operates on the same display-referred RGB as the existing curve stage.
 */
export function adjustHslColor(hsl:ColorHsl,r:number,g:number,b:number,out:number[]=[0,0,0]):number[] {
  const maximum=Math.max(r,g,b),minimum=Math.min(r,g,b),chroma=maximum-minimum;
  if(chroma<1e-12){out[0]=r;out[1]=g;out[2]=b;return out;}
  let hue=maximum===r?(g-b)/chroma:maximum===g?(b-r)/chroma+2:(r-g)/chroma+4;
  hue=(hue+6)%6;
  const left=Math.floor(hue),fraction=hue-left,weight=fraction*fraction*(3-2*fraction);
  const a=hsl[HSL_BANDS[left]],next=hsl[HSL_BANDS[(left+1)%6]];
  const strength=Math.min(1,chroma/.1),protection=strength*strength*(3-2*strength);
  const hueShift=((a?.hue??0)*(1-weight)+(next?.hue??0)*weight)*protection;
  const saturationGain=((a?.saturation??0)*(1-weight)+(next?.saturation??0)*weight)*protection;
  const lightnessGain=((a?.lightness??0)*(1-weight)+(next?.lightness??0)*weight)*protection;
  let lightness=(maximum+minimum)/2;
  const saturation=clampColor(chroma/(1-Math.abs(2*lightness-1))*(1+saturationGain));
  lightness+=lightnessGain>=0?(1-lightness)*lightnessGain:lightness*lightnessGain;
  hue=(hue+hueShift/60+6)%6;
  const adjustedChroma=(1-Math.abs(2*lightness-1))*saturation;
  const secondary=adjustedChroma*(1-Math.abs(hue%2-1)),base=lightness-adjustedChroma/2;
  const sector=Math.floor(hue);
  out[0]=base+(sector===0||sector===5?adjustedChroma:sector===1||sector===4?secondary:0);
  out[1]=base+(sector===1||sector===2?adjustedChroma:sector===0||sector===3?secondary:0);
  out[2]=base+(sector===3||sector===4?adjustedChroma:sector===2||sector===5?secondary:0);
  return out;
}

const hslLuts=new WeakMap<ColorHsl,WeakRef<ColorLut>>();
/** Generated tables are transient. Projects store only the six band settings. */
export function hslColorLut(hsl:ColorHsl|undefined):ColorLut|undefined {
  if(!hasColorHsl(hsl))return;
  const cached=hslLuts.get(hsl!)?.deref();if(cached)return cached;
  const size=HSL_LUT_SIZE,values=new Float32Array(3*size**3),rgb=[0,0,0];let offset=0;
  for(let blue=0;blue<size;blue++)for(let green=0;green<size;green++)for(let red=0;red<size;red++){
    adjustHslColor(hsl!,red/(size-1),green/(size-1),blue/(size-1),rgb);
    values.set(rgb,offset);offset+=3;
  }
  const lut:ColorLut={id:'generated-hsl',name:'HSL',size,domainMin:[0,0,0],domainMax:[1,1,1],encoding:'f32le',data:encodeLutData(values)};
  hslLuts.set(hsl!,new WeakRef(lut));return lut;
}

export function hasColorGrade(grade:ColorGrade|undefined):boolean{return !!grade?.enabled&&(hasColorHsl(grade.hsl)||!!grade.curves&&Object.keys(grade.curves).length>0||!!grade.lutId&&grade.intensity>0);}
export function applyColorPixels(data:Uint8ClampedArray,grade:ColorGrade,lut?:ColorLut){
  if(!hasColorGrade(grade))return;const table=grade.curves?curveTable(grade.curves):undefined,out=[0,0,0],mix=lut?grade.intensity:0,values=lut&&mix?lutValues(lut):undefined,hsl=hslColorLut(grade.hsl),hslValues=hsl?lutValues(hsl):undefined;
  for(let i=0;i<data.length;i+=4){if(!data[i+3])continue;let r=data[i]/255,g=data[i+1]/255,b=data[i+2]/255;if(hsl){sampleLut(hsl,r,g,b,out,hslValues);[r,g,b]=out;}if(table){r=sampleCurve(table,r,0);g=sampleCurve(table,g,1);b=sampleCurve(table,b,2);}if(lut&&mix){sampleLut(lut,r,g,b,out,values);r+=(out[0]-r)*mix;g+=(out[1]-g)*mix;b+=(out[2]-b)*mix;}data[i]=r*255;data[i+1]=g*255;data[i+2]=b*255;}
}
