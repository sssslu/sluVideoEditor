import {open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {availableParallelism} from 'node:os';
import type {InferenceSession} from 'onnxruntime-node';
import {assertTrackingFrame,assertTrackingBox,trackingInput,trackingOutput,type TrackingFrame,type TrackingBox,type TrackingMaps,type TrackingObservation} from './tracking-math';

export const TRACKING_MODEL_SHA256='2990f0b7cd44d92afa48cd97db6de7be113fc1d9594fddb74e2725c10478e91d';
export type TrackingBackend='cpu'|'dml';
export interface TrackingModelOptions {modelPath:string;backend?:'auto'|TrackingBackend;profilePrefix?:string;onBackend?:(backend:TrackingBackend,reason?:string)=>void}
export interface TrackingInference {infer(template:Float32Array,search:Float32Array):Promise<TrackingMaps>;close():Promise<void>}
export type TrackingInferenceFactory=(backend:TrackingBackend,options:TrackingModelOptions)=>Promise<TrackingInference>;

/** Native ORT is loaded only in the isolated tracking utility process. */
const nativeInference:TrackingInferenceFactory=async(backend,options)=>{
  const handle=await open(options.modelPath,'r'),bytes=Buffer.alloc(714727);
  let length=0;
  try{
    if((await handle.stat()).size!==714726)throw new Error('객체 추적 모델의 크기가 올바르지 않습니다.');
    while(length<bytes.length){const {bytesRead}=await handle.read(bytes,length,bytes.length-length,length);if(!bytesRead)break;length+=bytesRead;}
  }finally{await handle.close();}
  const model=bytes.subarray(0,length);
  if(length!==714726||createHash('sha256').update(model).digest('hex')!==TRACKING_MODEL_SHA256)throw new Error('객체 추적 모델이 손상되었습니다. 프로그램을 다시 설치하세요.');
  const ort=await import('onnxruntime-node');
  const session=await ort.InferenceSession.create(model,{executionProviders:[backend],executionMode:'sequential',enableMemPattern:false,intraOpNumThreads:Math.max(1,Math.min(4,availableParallelism()-1)),interOpNumThreads:1,...(options.profilePrefix?{enableProfiling:true,profileFilePrefix:options.profilePrefix+'-'+backend}:{})});
  const arrays=(output:InferenceSession.ReturnType):TrackingMaps=>{
    const read=(name:string,length:number)=>{const value=output[name];if(!value||value.type!=='float32'||!(value.data instanceof Float32Array)||value.data.length!==length)throw new Error('객체 추적 모델의 출력 형식이 올바르지 않습니다.');return value.data;};
    return {confidence:read('output1',256),size:read('output2',512),offset:read('output3',512)};
  };
  let closed=false;
  return {
    async infer(template,search){if(closed)throw new Error('추적 엔진이 닫혔습니다.');return arrays(await session.run({template:new ort.Tensor('float32',template,[1,3,128,128]),search:new ort.Tensor('float32',search,[1,3,256,256])}));},
    async close(){if(closed)return;closed=true;try{if(options.profilePrefix)session.endProfiling();}finally{await session.release();}}
  };
};

/** One object and one inference at a time. Re-anchoring replaces the template;
 * a failed update cannot mutate the last accepted position. GPU errors retry
 * the same tensor on CPU, with the original anchor and previous box intact. */
export class ObjectTracker {
  private inference?:TrackingInference;
  private template?:Float32Array;
  private search=new Float32Array(3*256*256);
  private box?:TrackingBox;
  private width=0;private height=0;
  private busy=false;private closed=false;
  private active:TrackingBackend='cpu';
  private constructor(private options:TrackingModelOptions,private factory:TrackingInferenceFactory){}
  static async create(options:TrackingModelOptions,factory:TrackingInferenceFactory=nativeInference):Promise<ObjectTracker>{
    if(!options||!['auto','cpu','dml'].includes(options.backend??'auto')||typeof options.modelPath!=='string')throw new Error('객체 추적 엔진 설정이 올바르지 않습니다.');
    const tracker=new ObjectTracker(options,factory),backend=options.backend==='cpu'?'cpu':'dml';
    try{await tracker.open(backend);}catch(error){if(options.backend==='dml'||backend==='cpu')throw error;await tracker.open('cpu',String(error));}
    return tracker;
  }
  get backend(){return this.active;}
  private async open(backend:TrackingBackend,reason?:string){this.inference=await this.factory(backend,this.options);this.active=backend;try{this.options.onBackend?.(backend,reason);}catch{/* An observer must not leak a native session. */}}
  private available(){if(this.closed)throw new Error('추적 엔진이 닫혔습니다.');if(this.busy)throw new Error('이전 추적 프레임을 처리 중입니다.');}
  anchor(frame:TrackingFrame,box:TrackingBox):TrackingObservation {
    this.available();assertTrackingFrame(frame);assertTrackingBox(box,frame.width,frame.height);
    const template=trackingInput(frame,box,2,128).data;
    this.template=template;this.box=[...box];this.width=frame.width;this.height=frame.height;
    return {box:[...box],score:1,status:'tracked'};
  }
  async update(frame:TrackingFrame):Promise<TrackingObservation>{
    this.available();assertTrackingFrame(frame);
    if(!this.template||!this.box)throw new Error('먼저 추적할 대상을 지정하세요.');
    if(frame.width!==this.width||frame.height!==this.height)throw new Error('추적 도중 영상의 크기가 변경되었습니다. 대상을 다시 지정하세요.');
    this.busy=true;
    try{
      const input=trackingInput(frame,this.box,4,256,this.search),infer=async()=>trackingOutput(await this.inference!.infer(this.template!,input.data),input,this.width,this.height,this.box!);
      let result:TrackingObservation;
      try{result=await infer();}catch(error){
        if(this.active!=='dml'||this.options.backend==='dml')throw error;
        const old=this.inference;this.inference=undefined;await old?.close().catch(()=>{});
        await this.open('cpu',String(error));result=await infer();
      }
      this.box=[...result.box];return result;
    }finally{this.busy=false;}
  }
  async close(){if(this.closed)return;if(this.busy)throw new Error('추적 프레임 처리 후 엔진을 닫으세요.');this.closed=true;const session=this.inference;this.inference=undefined;this.template=undefined;this.box=undefined;await session?.close();}
}
