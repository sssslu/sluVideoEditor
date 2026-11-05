/** Statistics of the displayed SDR composite. Channels: Y', R', G', B'. */
export interface ScopeAnalysis {width:number;height:number;samples:number;histogram:Uint32Array;waveWidth:number;waveHeight:number;waveform:Uint16Array;vectorSize:number;vectors:Uint16Array;min:number[];max:number[];mean:number[]}
export interface ScopeFrame {revision:number;serial:number;time:number;width:number;height:number;pixels:ArrayBuffer}
export interface ScopeResult extends Omit<ScopeFrame,'pixels'> {analysis:ScopeAnalysis}
export function analyzeScopes(pixels:Uint8ClampedArray,width:number,height:number):ScopeAnalysis {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>320||height>180||pixels.length!==width*height*4)throw new Error('Invalid scope frame dimensions');
  const histogram=new Uint32Array(4*256),waveWidth=Math.min(256,width),waveHeight=128,waveform=new Uint16Array(4*waveWidth*waveHeight),vectorSize=128,vectors=new Uint16Array(vectorSize**2),min=[255,255,255,255],max=[0,0,0,0],sum=[0,0,0,0];let samples=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;if(!pixels[i+3])continue;
    const r=pixels[i],g=pixels[i+1],b=pixels[i+2],luma=(2126*r+7152*g+722*b)/10000,values=[Math.round(luma),r,g,b],column=Math.min(waveWidth-1,Math.floor(x*waveWidth/width));samples++;
    for(let c=0;c<4;c++){const v=values[c];histogram[c*256+v]++;waveform[(c*waveHeight+(127-(v>>1)))*waveWidth+column]++;min[c]=Math.min(min[c],v);max[c]=Math.max(max[c],v);sum[c]+=v;}
    const cb=.5+(b-luma)/(255*1.8556),cr=.5+(r-luma)/(255*1.5748),vx=Math.max(0,Math.min(127,Math.round(cb*127))),vy=Math.max(0,Math.min(127,Math.round((1-cr)*127)));vectors[vy*128+vx]++;
  }
  return {width,height,samples,histogram,waveWidth,waveHeight,waveform,vectorSize,vectors,min:samples?min:[0,0,0,0],max,mean:sum.map(v=>samples?v/samples:0)};
}
