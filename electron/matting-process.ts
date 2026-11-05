import {utilityProcess,type UtilityProcess} from 'electron';
import path from 'node:path';
import {assertMattingFrame,type MattingBackend,type MattingModelOptions,type MattingFrame,type MattingOutput} from './matting-model';

export interface MattingProcessOptions extends Omit<MattingModelOptions,'onBackend'|'onFrameTiming'> {
 signal?:AbortSignal;workerPath?:string;requestTimeoutMs?:number;
 diagnostics?:(event:Record<string,unknown>)=>void;
}
const cancelled=()=>Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError'});
export class MattingProcessError extends Error {constructor(message:string){super(message);this.name='MattingProcessError';}}

/** At most one frame crosses the process boundary. Model state stays in the
 * worker. Cancellation waits for that owned process to exit, including during
 * a blocked native call. The caller separately owns decoding/encoding. */
export class MattingProcess {
 private child:UtilityProcess;
 private pending?:{id:number;resolve:(result:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
 private sequence=0;private ending=false;private exited=false;private failure?:Error;
 private finishExit!:()=>void;private exitPromise:Promise<void>;private abort:()=>void;
 private active:MattingBackend='cpu';private pid?:number;
 private frameBusy=false;
 private constructor(private options:MattingProcessOptions){
  this.exitPromise=new Promise(resolve=>{this.finishExit=resolve;});
  this.child=utilityProcess.fork(options.workerPath||path.join(__dirname,'matting-worker.cjs'),[String(process.pid)],{stdio:'ignore',serviceName:'SLU Background Removal'});
  this.abort=()=>this.fail(cancelled());
  this.child.on('spawn',()=>{this.pid=this.child.pid;this.diagnostic({event:'matting-process-start',pid:this.pid});if(this.ending)this.child.kill();});
  this.child.on('message',message=>{
   if(message?.type==='backend'&&['cpu','dml'].includes(message.backend)){this.active=message.backend;this.diagnostic({event:'matting-backend',backend:message.backend,reason:message.reason});return;}
   if(message?.type==='timing'&&message.timing){this.diagnostic({event:'matting-frame-timing',...message.timing});return;}
   if(message?.type==='fatal'){this.fail(new MattingProcessError(String(message.error)));return;}
   const pending=this.pending;if(!pending||message?.id!==pending.id)return;
   clearTimeout(pending.timer);this.pending=undefined;
   if(typeof message.error==='string')pending.reject(new MattingProcessError(message.error));else pending.resolve(message.result);
  });
  this.child.on('exit',code=>{
   this.exited=true;this.options.signal?.removeEventListener('abort',this.abort);
   if(this.pending||!this.ending)this.fail(new MattingProcessError(`배경 제거 프로세스가 종료되었습니다 (${code}).`));
   this.diagnostic({event:'matting-process-exit',pid:this.pid,code});this.finishExit();
  });
  options.signal?.addEventListener('abort',this.abort,{once:true});if(options.signal?.aborted)this.abort();
 }
 static async create(options:MattingProcessOptions):Promise<MattingProcess>{
  if(options.signal?.aborted)throw cancelled();
  if(options.requestTimeoutMs!==undefined&&(!Number.isFinite(options.requestTimeoutMs)||options.requestTimeoutMs<100||options.requestTimeoutMs>180000))throw new Error('배경 제거 작업 시간 제한이 올바르지 않습니다.');
  const engine=new MattingProcess(options);
  try{
   const result=await engine.request('open',{options:{modelPath:options.modelPath,gpuModelPath:options.gpuModelPath,backend:options.backend,quality:options.quality,profilePrefix:options.profilePrefix}});
   if(!result||!['cpu','dml'].includes(result.backend))throw new MattingProcessError('배경 제거 엔진의 응답이 올바르지 않습니다.');
   return engine;
  }
  catch(error){engine.fail(error instanceof Error?error:new Error(String(error)));await engine.close();throw error;}
 }
 get backend(){return this.active;}
 private diagnostic(event:Record<string,unknown>){try{this.options.diagnostics?.(event);}catch{}}
 private fail(error:Error){
  this.failure??=error;this.ending=true;
  if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(this.failure);this.pending=undefined;}
  if(!this.exited)this.child.kill();
 }
 private request(method:string,payload:Record<string,unknown>={}):Promise<any>{
  if(this.failure)return Promise.reject(this.failure);
  if(this.ending)return Promise.reject(new Error('배경 제거 작업이 이미 종료되었습니다.'));
  if(this.pending)return Promise.reject(new Error('이전 배경 제거 프레임을 처리 중입니다.'));
  const id=++this.sequence;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>this.fail(new MattingProcessError('배경 제거 엔진이 응답하지 않아 작업을 중단했습니다.')),this.options.requestTimeoutMs??60000);
   this.pending={id,resolve,reject,timer};
   try{this.child.postMessage({id,method,...payload});}catch(error){this.fail(error instanceof Error?error:new Error(String(error)));}
  });
 }
 async process(frame:MattingFrame,pts:number):Promise<MattingOutput>{
  assertMattingFrame(frame);if(!Number.isSafeInteger(pts))throw new Error('배경 제거 프레임 시각이 올바르지 않습니다.');
  if(this.frameBusy)throw new Error('이전 배경 제거 프레임을 처리 중입니다.');this.frameBusy=true;
  const {width,height}=frame;
  const check=(result:any)=>{if(!result||result.width!==width||result.height!==height||result.pts!==pts||!['cpu','dml'].includes(result.backend))throw new MattingProcessError('배경 제거 프로세스가 잘못된 프레임을 반환했습니다.');return result;};
  try{
   const result=check(await this.request('process',{frame,pts}));
   if(!(result.data instanceof Uint8Array)||result.data.length!==width*height*4)throw new MattingProcessError('배경 제거 프로세스가 잘못된 프레임을 반환했습니다.');return result;
  }catch(error){this.fail(error instanceof Error?error:new Error(String(error)));throw error;}finally{this.frameBusy=false;}
 }
 async reset():Promise<void>{if(this.frameBusy)throw new Error('이전 배경 제거 프레임을 처리 중입니다.');await this.request('reset');}
 async close():Promise<void>{
  if(!this.exited&&!this.ending&&!this.pending&&!this.frameBusy){try{await this.request('close');}catch{}}
  this.fail(this.failure||new Error('배경 제거 작업이 종료되었습니다.'));await this.exitPromise;
 }
}
