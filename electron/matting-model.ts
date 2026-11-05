import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {availableParallelism} from 'node:os';
import path from 'node:path';
import type {InferenceSession} from 'onnxruntime-node';
import type {CutoutQuality} from '../shared/types';

export const MATTING_MODEL_SHA256='88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828';
export const MATTING_BYTE_MODEL_SHA256='5292c6ccbfe2fdf9a2280532885605dfb3553b6b261cae4d63d3e47c7ddd49c1';
export const MATTING_RESNET_MODEL_SHA256='25db300fcb6ee27f941a1b52c97856e8d1f13c7f35817f81a612f89af0e8a85c';
export const MATTING_RESNET_BYTE_MODEL_SHA256='f95503b9719810647c58a1c5136a9e3b052d3612ae93ee233edc3b56e50a6c32';
const mobileModel={size:14975696,sha256:MATTING_MODEL_SHA256,byteSize:14979595,byteSha256:MATTING_BYTE_MODEL_SHA256,byteFile:'person-matting-rvm-bgr.onnx',channels:[16,20,40,64]};
const resnetModel={size:107479165,sha256:MATTING_RESNET_MODEL_SHA256,byteSize:107483061,byteSha256:MATTING_RESNET_BYTE_MODEL_SHA256,byteFile:'person-matting-rvm-resnet50-bgr.onnx',channels:[16,32,64,128]};
const modelVariant=(quality:CutoutQuality|undefined)=>quality==='precision'?resnetModel:mobileModel;
export type MattingBackend='cpu'|'dml';
export interface MattingFrame {width:number;height:number;data:Uint8Array}
export interface MattingState {data:Float32Array;dims:readonly number[]}
export interface MattingInput {data:Float32Array;width:number;height:number;ratio:number}
export interface MattingPrediction {foreground:Float32Array;alpha:Float32Array;states:MattingState[]}
export interface MattingBytePrediction {bgra:Uint8Array;valid:boolean;states:MattingState[]}
export interface MattingOutput {width:number;height:number;data:Uint8Array;pts:number;backend:MattingBackend}
export interface MattingFrameTiming {pts:number;width:number;height:number;inputMs:number;inferenceMs:number;packMs:number;totalMs:number}
export interface MattingModelOptions {
 modelPath:string;gpuModelPath?:string;backend?:'auto'|MattingBackend;quality?:CutoutQuality;profilePrefix?:string;
 onBackend?:(backend:MattingBackend,reason?:string)=>void;
 onFrameTiming?:(timing:MattingFrameTiming)=>void;
}
export interface MattingInference {
 infer?(input:MattingInput,states:readonly MattingState[]):Promise<MattingPrediction>;
 inferFrame?(frame:MattingFrame,ratio:number,states:readonly MattingState[]):Promise<MattingBytePrediction>;
 close():Promise<void>;
}
export type MattingInferenceFactory=(backend:MattingBackend,options:MattingModelOptions)=>Promise<MattingInference>;

export function assertMattingFrame(frame:MattingFrame):void {
 if(!frame||!Number.isInteger(frame.width)||!Number.isInteger(frame.height)||frame.width<16||frame.height<16||frame.width>8192||frame.height>8192||frame.width*frame.height>4096*4096||!(frame.data instanceof Uint8Array)||frame.data.length!==frame.width*frame.height*3)throw new Error('배경 제거 영상의 크기 또는 픽셀 데이터가 올바르지 않습니다.');
}
export function mattingRatio(width:number,height:number,quality:CutoutQuality):number {
 return Math.fround(Math.min(1,(quality==='portrait'?512:768)/Math.max(width,height)));
}
const initialStates=():MattingState[]=>Array.from({length:4},()=>({data:new Float32Array(1),dims:[1,1,1,1]}));
const normalizedByte=Float32Array.from({length:256},(_,value)=>value/255);

/** Native ORT is loaded only inside the owned utility process. All tensors are
 * CPU-backed at this API boundary, so a GPU failure can retry the exact last
 * accepted recurrent state on CPU without restarting the temporal sequence. */
const nativeInference:MattingInferenceFactory=async(backend,options)=>{
 const variant=modelVariant(options.quality),byteModel=backend==='dml';
 const size=byteModel?variant.byteSize:variant.size,expected=byteModel?variant.byteSha256:variant.sha256;
 const modelPath=byteModel?(options.gpuModelPath??path.join(path.dirname(options.modelPath),variant.byteFile)):options.modelPath;
 const handle=await open(modelPath,'r'),bytes=Buffer.alloc(size+1);let length=0;
 try{
  if((await handle.stat()).size!==size)throw new Error('배경 제거 모델의 크기가 올바르지 않습니다.');
  while(length<bytes.length){const {bytesRead}=await handle.read(bytes,length,bytes.length-length,length);if(!bytesRead)break;length+=bytesRead;}
 }finally{await handle.close();}
 const model=bytes.subarray(0,length);
 if(length!==size||createHash('sha256').update(model).digest('hex')!==expected)throw new Error('배경 제거 모델이 손상되었습니다. 프로그램을 다시 설치하세요.');
 const ort=await import('onnxruntime-node');
 const session=await ort.InferenceSession.create(model,{executionProviders:[backend],executionMode:'sequential',enableMemPattern:false,intraOpNumThreads:Math.max(1,Math.min(4,availableParallelism()-1)),interOpNumThreads:1,...(options.profilePrefix?{enableProfiling:true,profileFilePrefix:options.profilePrefix+'-'+backend}:{})});
 let closed=false;
 const stateFeeds=(states:readonly MattingState[])=>Object.fromEntries(states.map((s,i)=>['r'+(i+1)+'i',new ort.Tensor('float32',s.data,s.dims)]));
 const tensor=(output:InferenceSession.ReturnType,name:string)=>{const t=output[name];if(!t||t.type!=='float32'||!(t.data instanceof Float32Array))throw new Error('배경 제거 모델의 출력 형식이 올바르지 않습니다.');return {data:t.data,dims:[...t.dims]};};
 const readStates=(output:InferenceSession.ReturnType)=>[1,2,3,4].map(i=>tensor(output,'r'+i+'o'));
 const run=async<T>(feeds:InferenceSession.FeedsType,read:(output:InferenceSession.ReturnType)=>T):Promise<T>=>{
   if(closed)throw new Error('배경 제거 엔진이 닫혔습니다.');
   let output:InferenceSession.ReturnType|undefined;
   try{
    output=await session.run(feeds);
    return read(output);
   }finally{
    // ORT Node returns CPU typed arrays. Disposing wrappers does not destroy
    // arrays still referenced by the accepted state/output (no GPU handles).
    for(const value of Object.values(feeds))value.dispose();
    if(output)for(const value of Object.values(output))value.dispose();
   }
 };
 return {
  ...(byteModel?{inferFrame:(frame:MattingFrame,ratio:number,states:readonly MattingState[])=>run({src_bgr:new ort.Tensor('uint8',frame.data,[1,frame.height,frame.width,3]),downsample_ratio:new ort.Tensor('float32',Float32Array.of(ratio),[1]),...stateFeeds(states)},output=>{
   const bytes=output.frame_bgra,valid=output.invalid_pixels;
   if(!bytes||bytes.type!=='uint8'||!(bytes.data instanceof Uint8Array)||bytes.dims.join(',')!==[1,frame.height,frame.width,4].join(',')||!valid||valid.type!=='int32'||!(valid.data instanceof Int32Array)||valid.data.length!==1||valid.dims.length!==0)throw new Error('배경 제거 모델의 출력 형식이 올바르지 않습니다.');
   return {bgra:bytes.data,valid:valid.data[0]===0,states:readStates(output)};
  })}:{infer:(input:MattingInput,states:readonly MattingState[])=>run({src:new ort.Tensor('float32',input.data,[1,3,input.height,input.width]),downsample_ratio:new ort.Tensor('float32',Float32Array.of(input.ratio),[1]),...stateFeeds(states)},output=>{
   const f=tensor(output,'fgr'),a=tensor(output,'pha');
   if(f.dims.join(',')!==[1,3,input.height,input.width].join(',')||a.dims.join(',')!==[1,1,input.height,input.width].join(','))throw new Error('배경 제거 모델의 출력 크기가 올바르지 않습니다.');
   return {foreground:f.data,alpha:a.data,states:readStates(output)};
  })}),
  async close(){if(closed)return;closed=true;try{if(options.profilePrefix)session.endProfiling();}finally{await session.release();}}
 };
};

function packPrediction(prediction:MattingPrediction|MattingBytePrediction,width:number,height:number,quality:CutoutQuality|undefined):Uint8Array {
 const pixels=width*height,{states}=prediction;
 const {channels}=modelVariant(quality);
 if(!Array.isArray(states)||states.length!==4)throw new Error('배경 제거 모델의 출력 크기가 올바르지 않습니다.');
 for(let i=0;i<4;i++){
  const s=states[i];
  if(!s||!(s.data instanceof Float32Array)||!Array.isArray(s.dims)||s.dims.length!==4||s.dims[0]!==1||s.dims[1]!==channels[i]||s.dims.some(n=>!Number.isInteger(n)||n<1)||s.dims[2]>Math.ceil(height/2**(i+1))||s.dims[3]>Math.ceil(width/2**(i+1))||s.dims.reduce((a,b)=>a*b,1)!==s.data.length)throw new Error('배경 제거의 프레임 기억 데이터가 올바르지 않습니다.');
  for(let j=0;j<s.data.length;j++)if(!Number.isFinite(s.data[j]))throw new Error('배경 제거의 프레임 기억에 유효하지 않은 값이 있습니다.');
 }
 if('bgra' in prediction){if(prediction.valid!==true)throw new Error('배경 제거의 픽셀에 유효하지 않은 값이 있습니다.');if(!(prediction.bgra instanceof Uint8Array)||prediction.bgra.length!==pixels*4)throw new Error('배경 제거 모델의 출력 크기가 올바르지 않습니다.');return prediction.bgra;}
 const {foreground,alpha}=prediction;
 if(!(foreground instanceof Float32Array)||foreground.length!==pixels*3||!(alpha instanceof Float32Array)||alpha.length!==pixels)throw new Error('배경 제거 모델의 출력 크기가 올바르지 않습니다.');
 // Float32 values multiplied by 255 are exact in JS doubles. The only exact
 // half-integer in [0,255] reachable this way is 127.5, which rounds to 128 in
 // both Math.round and Uint8ClampedArray. Hardware clamping therefore preserves
 // every output byte, without four min/max/round calls for each UHD pixel.
 const result=new Uint8ClampedArray(pixels*4);
 for(let i=0;i<pixels;i++){
  const r=foreground[i],g=foreground[pixels+i],b=foreground[2*pixels+i],a=alpha[i];
  // Four finite float32 numbers cannot overflow a double sum. Any nonfinite
  // component makes it Infinity or NaN, including opposing infinities.
  if(!Number.isFinite(r+g+b+a))throw new Error('배경 제거의 픽셀에 유효하지 않은 값이 있습니다.');
  result[i*4]=b*255;result[i*4+1]=g*255;result[i*4+2]=r*255;result[i*4+3]=a*255;
 }
 return new Uint8Array(result.buffer);
}

/** One ordered source sequence. Call reset explicitly at a new shot or seek;
 * never feed discontinuous frames into the old recurrent state. Foreground is
 * straight BGRA, preserving the model's edge colors instead of original RGB.
 * State, timestamp and dimensions commit only after the whole frame succeeds. */
export class PersonMatting {
 private inference?:MattingInference;private states=initialStates();private input?:Float32Array;private bytes?:Uint8Array;
 private active:MattingBackend='cpu';private width=0;private height=0;private lastPts=-Infinity;
 private closed=false;private busy=false;
 private constructor(private options:MattingModelOptions,private factory:MattingInferenceFactory){}
 static async create(options:MattingModelOptions,factory:MattingInferenceFactory=nativeInference):Promise<PersonMatting>{
  if(!options||typeof options.modelPath!=='string'||!options.modelPath||!['auto','cpu','dml'].includes(options.backend??'auto')||!['portrait','fullbody','precision'].includes(options.quality??'portrait'))throw new Error('배경 제거 엔진 설정이 올바르지 않습니다.');
  const matting=new PersonMatting({...options},factory),backend=options.backend==='cpu'?'cpu':'dml';
  try{await matting.open(backend);}catch(error){if(options.backend==='dml'||backend==='cpu')throw error;await matting.open('cpu',String(error));}
  return matting;
 }
 get backend(){return this.active;}
 private async open(backend:MattingBackend,reason?:string){const inference=await this.factory(backend,this.options);if(!inference.infer&&!inference.inferFrame){await inference.close();throw new Error('배경 제거 엔진의 입력 형식이 올바르지 않습니다.');}this.inference=inference;this.active=backend;try{this.options.onBackend?.(backend,reason);}catch{}}
 private available(){if(this.closed)throw new Error('배경 제거 엔진이 닫혔습니다.');if(this.busy)throw new Error('이전 배경 제거 프레임을 처리 중입니다.');}
 reset(){this.available();this.states=initialStates();this.input=undefined;this.bytes=undefined;this.width=0;this.height=0;this.lastPts=-Infinity;}
 async process(frame:MattingFrame,pts:number):Promise<MattingOutput>{
  this.available();assertMattingFrame(frame);
  if(!Number.isSafeInteger(pts)||pts<=this.lastPts)throw new Error('배경 제거 프레임은 원본 시각 순서대로 처리해야 합니다.');
  const {width,height}=frame;if(this.width&&(this.width!==width||this.height!==height))throw new Error('배경 제거 도중 영상 크기가 변경되었습니다. 새 구간으로 시작하세요.');
  this.busy=true;
  try{
   const began=performance.now();let inputMs=0,inferenceMs=0,packMs=0,owned:MattingFrame|undefined,input:MattingInput|undefined;
   const pixels=width*height,ratio=mattingRatio(width,height,this.options.quality??'portrait');
   const infer=async()=>{
    const prepare=performance.now(),byteInput=!!this.inference!.inferFrame;
    if(byteInput&&!owned){this.bytes=this.bytes?.length===pixels*3?this.bytes:new Uint8Array(pixels*3);this.bytes.set(frame.data);owned={width,height,data:this.bytes};}
    if(!byteInput&&!input){const data=this.input?.length===pixels*3?this.input:new Float32Array(pixels*3),source=owned?.data??frame.data;this.input=data;for(let i=0;i<pixels;i++){data[i]=normalizedByte[source[i*3+2]];data[pixels+i]=normalizedByte[source[i*3+1]];data[2*pixels+i]=normalizedByte[source[i*3]];}input={data,width,height,ratio};}
    inputMs+=performance.now()-prepare;
    const start=performance.now();let prediction:MattingPrediction|MattingBytePrediction;
    try{prediction=byteInput?await this.inference!.inferFrame!(owned!,ratio,this.states):await this.inference!.infer!(input!,this.states);}finally{inferenceMs+=performance.now()-start;}
    const packStart=performance.now();let bgra:Uint8Array;try{bgra=packPrediction(prediction,width,height,this.options.quality);}finally{packMs+=performance.now()-packStart;}return {prediction,bgra};
   };
   let accepted;
   try{accepted=await infer();}catch(error){
    if(this.active!=='dml'||this.options.backend==='dml')throw error;
    const old=this.inference;this.inference=undefined;await old?.close().catch(()=>{});await this.open('cpu',String(error));accepted=await infer();
   }
   this.states=accepted.prediction.states;this.width=width;this.height=height;this.lastPts=pts;
   try{this.options.onFrameTiming?.({pts,width,height,inputMs,inferenceMs,packMs,totalMs:performance.now()-began});}catch{}
   return {width,height,data:accepted.bgra,pts,backend:this.active};
  }finally{this.busy=false;}
 }
 async close(){if(this.closed)return;if(this.busy)throw new Error('배경 제거 프레임 처리 후 엔진을 닫으세요.');this.closed=true;const session=this.inference;this.inference=undefined;this.input=undefined;this.bytes=undefined;this.states=[];await session?.close();}
}
