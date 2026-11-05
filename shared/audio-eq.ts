import type {AudioEQ,EQBand,EQKind,Project} from './types';

export const EQ_KINDS:EQKind[]=['highpass','lowshelf','peaking','highshelf','lowpass'];
export function defaultEQ():AudioEQ {return {enabled:true,output:0,bands:[
  {type:'highpass',enabled:false,frequency:80,gain:0,q:Math.SQRT1_2},
  {type:'lowshelf',enabled:true,frequency:120,gain:0,q:Math.SQRT1_2},
  {type:'peaking',enabled:true,frequency:500,gain:0,q:1},
  {type:'peaking',enabled:true,frequency:2500,gain:0,q:1},
  {type:'highshelf',enabled:true,frequency:8000,gain:0,q:Math.SQRT1_2},
  {type:'lowpass',enabled:false,frequency:16000,gain:0,q:Math.SQRT1_2}
]};}
export function assertAudioEQ(value:unknown):asserts value is AudioEQ {
  const eq=value as AudioEQ,number=(n:unknown,min:number,max:number)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
  if(!eq||typeof eq!=='object'||typeof eq.enabled!=='boolean'||!number(eq.output,-18,18)||!Array.isArray(eq.bands)||eq.bands.length!==6||eq.bands.some(b=>!b||typeof b!=='object'||typeof b.enabled!=='boolean'||!EQ_KINDS.includes(b.type)||!number(b.frequency,20,20000)||!number(b.gain,-18,18)||!number(b.q,.1,10)))throw new Error('EQ는 6개 밴드, 20–20000 Hz, ±18 dB, Q 0.1–10 범위가 필요합니다.');
}
export interface BiquadCoefficients {b:[number,number,number];a:[number,number,number]}
/** RBJ/W3C Audio EQ Cookbook. Shelves use monotonic slope S=1; Q is for peak/pass filters.
 * https://www.w3.org/TR/audio-eq-cookbook/ */
export function bandCoefficients(band:EQBand,rate:number):BiquadCoefficients|undefined {
  if(!band.enabled||(!['highpass','lowpass'].includes(band.type)&&band.gain===0))return;
  const w=2*Math.PI*Math.min(band.frequency,rate*.49)/rate,c=Math.cos(w),s=Math.sin(w),A=10**(band.gain/40),alpha=s/(2*band.q);
  let b0:number,b1:number,b2:number,a0:number,a1:number,a2:number;
  if(band.type==='peaking'){b0=1+alpha*A;b1=-2*c;b2=1-alpha*A;a0=1+alpha/A;a1=-2*c;a2=1-alpha/A;}
  else if(band.type==='highpass'||band.type==='lowpass'){
    const high=band.type==='highpass';b0=(1+(high?c:-c))/2;b1=(high?-2:2)*b0;b2=b0;a0=1+alpha;a1=-2*c;a2=1-alpha;
  }else{
    const t=s*Math.sqrt(2*A),p=A+1,m=A-1;
    if(band.type==='lowshelf'){b0=A*(p-m*c+t);b1=2*A*(m-p*c);b2=A*(p-m*c-t);a0=p+m*c+t;a1=-2*(m+p*c);a2=p+m*c-t;}
    else{b0=A*(p+m*c+t);b1=-2*A*(m+p*c);b2=A*(p+m*c-t);a0=p-m*c+t;a1=2*(m-p*c);a2=p-m*c-t;}
  }
  return {b:[b0/a0,b1/a0,b2/a0],a:[1,a1/a0,a2/a0]};
}
export function compileEQ(eq:AudioEQ|undefined,rate:number){
  if(!Number.isFinite(rate)||rate<8000)throw new Error('Unsupported EQ sample rate');
  return {filters:eq?.enabled?eq.bands.flatMap(b=>{const c=bandCoefficients(b,rate);return c?[c]:[];}):[],gain:eq?.enabled?10**(eq.output/20):1};
}
export function eqResponse(eq:AudioEQ|undefined,frequency:number,rate=48000):number {
  const {filters,gain}=compileEQ(eq,rate),w=2*Math.PI*Math.min(frequency,rate*.5)/rate;
  const power=(v:number[])=>{const real=v[0]+v[1]*Math.cos(w)+v[2]*Math.cos(2*w),imag=v[1]*Math.sin(w)+v[2]*Math.sin(2*w);return real*real+imag*imag;};
  return 20*Math.log10(Math.max(1e-12,gain))+filters.reduce((db,f)=>db+10*Math.log10(Math.max(1e-24,power(f.b))/Math.max(1e-24,power(f.a))),0);
}
/** Double state, float32 between stages like native WebAudio IIR nodes.
 * One instance per continuous clip, after time stretching and before gain/fades. */
export class AudioEQProcessor {
  private stages:{c:BiquadCoefficients;z1:Float64Array;z2:Float64Array}[];private gain:number;
  constructor(eq:AudioEQ|undefined,rate=48000,private channels=2){const compiled=compileEQ(eq,rate);this.gain=compiled.gain;this.stages=compiled.filters.map(c=>({c,z1:new Float64Array(channels),z2:new Float64Array(channels)}));}
  get active(){return this.stages.length>0||this.gain!==1;}
  process(samples:Float32Array){
    for(const {c,z1,z2} of this.stages){const [b0,b1,b2]=c.b,[,a1,a2]=c.a;
      for(let i=0;i<samples.length;i++){const ch=i%this.channels,x=Number.isFinite(samples[i])?samples[i]:0,y=b0*x+z1[ch];z1[ch]=b1*x-a1*y+z2[ch];z2[ch]=b2*x-a2*y;samples[i]=y;}
    }
    if(this.gain!==1)for(let i=0;i<samples.length;i++)samples[i]*=this.gain;
  }
}
export function patchAudioEQs(project:Project,ids:ReadonlySet<string>,update:(current:AudioEQ)=>AudioEQ|undefined):Project {
  const clips=project.clips.map(clip=>{
    const media=project.media.find(m=>m.id===clip.mediaId);
    if(!ids.has(clip.id)||clip.text!==undefined||!media?.hasAudio||media.kind==='image'||project.tracks.find(t=>t.id===clip.trackId)?.locked)return clip;
    const audioEQ=update(clip.audioEQ||defaultEQ());if(audioEQ)assertAudioEQ(audioEQ);return {...clip,audioEQ};
  });
  return clips.every((c,i)=>c===project.clips[i])?project:{...project,version:10,clips};
}
export function eqFFmpegFilters(eq:AudioEQ|undefined,rate=48000):string[]{
  const {filters,gain}=compileEQ(eq,rate);
  return [...filters.flatMap(({b,a})=>[`biquad=b0=${b[0]}:b1=${b[1]}:b2=${b[2]}:a0=1:a1=${a[1]}:a2=${a[2]}:precision=f64:transform=tdii`,'aformat=sample_fmts=fltp']),...(gain!==1?[`volume=${gain}:precision=float`]:[])];
}
