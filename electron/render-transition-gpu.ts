import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {CompiledTransition} from '../shared/transitions';
import {transitionDirection} from '../shared/transitions';
import {runProcess,type EngineContext} from './media';
import {alphaPremultiply,alphaUnpremultiply} from './alpha-filters';

const literal=(value:number)=>{const text=Number(value.toPrecision(17)).toString();return /[.e]/i.test(text)?text:`${text}.0`;};
/** Direct planar16-bit OpenCL input retains premultiplied alpha. Double
 * coordinates preserve the CPU half-open edge decisions at fractional cuts;
 * GPUs without fp64 are rejected by the capability probe and use CPU paths. */
export function transitionOpenClSource(item:Pick<CompiledTransition,'transition'|'start'|'end'>,firstFrame:number,fps:number):string {
  const [dx,dy]=transitionDirection(item.transition.direction),kind=item.transition.kind;
  let ease='p';if(item.transition.easing==='ease-in')ease='p*p';if(item.transition.easing==='ease-out')ease='1.0-(1.0-p)*(1.0-p)';if(item.transition.easing==='ease-in-out')ease='p<0.5?2.0*p*p:1.0-2.0*(1.0-p)*(1.0-p)';if(item.transition.easing==='hold')ease='p>=1.0?1.0:0.0';
  let operation='value=sample_pixel(a,uv)*(1.0-p)+sample_pixel(b,uv)*p;';
  if(kind==='slide')operation=`value=sample_pixel(a,uv-p*(double2)(${dx}.0*size.x,${dy}.0*size.y))+sample_pixel(b,uv+(1.0-p)*(double2)(${dx}.0*size.x,${dy}.0*size.y));`;
  if(kind==='zoom')operation='double2 center=size*0.5;value=sample_pixel(a,(uv+0.5-center)/(1.0+0.25*p)+center-0.5)*(1.0-p)+sample_pixel(b,(uv+0.5-center)/(0.75+0.25*p)+center-0.5)*p;';
  if(kind==='wipe')operation=`double axis=(uv.${dx?'x':'y'}+0.5)/size.${dx?'x':'y'};value=${(dx||dy)<0?'axis>=1.0-p':'axis<p'}?sample_pixel(b,uv):sample_pixel(a,uv);`;
  return `#pragma OPENCL EXTENSION cl_khr_fp64 : enable
#pragma OPENCL FP_CONTRACT OFF
const sampler_t nearest=CLK_NORMALIZED_COORDS_FALSE|CLK_ADDRESS_CLAMP_TO_EDGE|CLK_FILTER_NEAREST;
double4 sample_pixel(read_only image2d_t image,double2 pixel){
  int2 dim=get_image_dim(image);
  if(pixel.x<-.5||pixel.y<-.5||pixel.x>=(double)dim.x-.5||pixel.y>=(double)dim.y-.5)return (double4)(0);
  pixel=clamp(pixel,(double2)(0),convert_double2(dim-1));
  int2 lo=convert_int2(floor(pixel)),hi=min(lo+1,dim-1);double2 f=pixel-convert_double2(lo);
  double4 a=convert_double4(read_imagef(image,nearest,lo)),b=convert_double4(read_imagef(image,nearest,(int2)(hi.x,lo.y)));
  double4 c=convert_double4(read_imagef(image,nearest,(int2)(lo.x,hi.y))),d=convert_double4(read_imagef(image,nearest,hi));
  return (a*(1.0-f.x)+b*f.x)*(1.0-f.y)+(c*(1.0-f.x)+d*f.x)*f.y;
}
kernel void slu_transition(write_only image2d_t dst,uint index,read_only image2d_t a,read_only image2d_t b){
  int2 xy=(int2)(get_global_id(0),get_global_id(1));int2 dim=get_image_dim(dst);if(xy.x>=dim.x||xy.y>=dim.y)return;
  double2 uv=convert_double2(xy),size=convert_double2(dim);
  double p=clamp((((double)index+${literal(firstFrame)})/${literal(fps)}-${literal(item.start)})/${literal(item.end-item.start)},0.0,1.0);p=${ease};
  if(p<=0.0){write_imagef(dst,xy,read_imagef(a,nearest,xy));return;}
  if(p>=1.0){write_imagef(dst,xy,read_imagef(b,nearest,xy));return;}
  double4 value;${operation}
  write_imagef(dst,xy,convert_float4(clamp(value,(double4)(0),(double4)(1))));
}
`;
}

export function appendOpenClTransition(graph:string[],from:string,to:string,output:string,shader:string):void {
  for(const [input,side] of [[from,'A'],[to,'B']])graph.push(`[${input}]${alphaPremultiply.join(',')},hwupload[${output}Gpu${side}]`);
  graph.push(`[${output}GpuA][${output}GpuB]program_opencl=source=${shader}:kernel=slu_transition:inputs=2:shortest=1,hwdownload,format=gbrap16le,${alphaUnpremultiply.join(',')}[${output}]`);
}

const capabilityCache=new Map<string,Promise<string|undefined>>();
export async function transitionGpuDevice(ctx:EngineContext,signal?:AbortSignal):Promise<string|undefined>{
  if(ctx.gpuProcessing===false)return;
  if(signal?.aborted)throw Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError'});
  const cached=capabilityCache.get(ctx.ffmpeg);if(cached)return cached;
  const pending=(async()=>{
    await fs.mkdir(ctx.cacheDir,{recursive:true});const work=await fs.mkdtemp(path.join(ctx.cacheDir,'transition-gpu-'));
    try{
      const transition={id:'probe',fromClipId:'a',toClipId:'b',kind:'slide' as const,durationFrames:30};await fs.writeFile(path.join(work,'probe.cl'),transitionOpenClSource({transition,start:0,end:1},0,30));
      const candidates=['opencl=sluTransition:,device_type=gpu,device_name=NVIDIA','opencl=sluTransition:,device_type=gpu'];
      for(const device of candidates){try{
        const graph='[0:v]format=gbrap16le,split[a0][b0];[a0]hwupload[a];[b0]hwupload[b];[a][b]program_opencl=source=probe.cl:kernel=slu_transition:inputs=2:shortest=1,hwdownload,format=gbrap16le[out]';
        const result=await runProcess(ctx.ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-init_hw_device',device,'-filter_hw_device','sluTransition','-filter_complex_threads','1','-f','lavfi','-i','color=red:s=32x18:r=30:d=0.1','-filter_complex',graph,'-map','[out]','-frames:v','2','-pix_fmt','gbrap16le','-c:v','rawvideo','-f','rawvideo','pipe:1'],{cwd:work,signal,timeoutMs:15000,maxOutputBytes:65536});
        if(result.stdout.length!==32*18*8*2)throw new Error('GPU 전환 프레임 확인에 실패했습니다.');
        ctx.diagnostics?.({event:'transition-gpu-probe',available:true,device,precision:'fp64 coordinates / UNORM16 planes'});return device;
      }catch(error){if(signal?.aborted||(error as Error)?.name==='AbortError')throw error;}}
      ctx.diagnostics?.({event:'transition-gpu-probe',available:false});return;
    }finally{if(path.dirname(path.resolve(work))===path.resolve(ctx.cacheDir)&&path.basename(work).startsWith('transition-gpu-'))await fs.rm(work,{recursive:true,force:true}).catch(()=>{});}
  })();capabilityCache.set(ctx.ffmpeg,pending);pending.catch(()=>capabilityCache.delete(ctx.ffmpeg));return pending;
}
