import {utilityProcess,type UtilityProcess} from 'electron';
import path from 'node:path';
import {assertTrackingFrame,assertTrackingBox,type TrackingFrame,type TrackingBox,type TrackingObservation} from './tracking-math';
import type {TrackingBackend,TrackingModelOptions} from './tracking-model';

export interface TrackingProcessOptions extends Omit<TrackingModelOptions,'onBackend'> {
  signal?:AbortSignal;workerPath?:string;requestTimeoutMs?:number;
  diagnostics?:(event:Record<string,unknown>)=>void;
}
const cancelled=()=>Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError'});
export class TrackingProcessError extends Error {constructor(message:string){super(message);this.name='TrackingProcessError';}}

/** At most one frame is in flight. Native inference never runs on the editor
 * main thread. Cancellation, timeout and native crashes terminate only this
 * owned utility process; the caller owns and closes its decoder separately. */
export class TrackingProcess {
  private child:UtilityProcess;
  private pending?:{id:number;resolve:(result:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
  private sequence=0;private ending=false;private exited=false;private failure?:Error;
  private finishExit!:()=>void;private exitPromise:Promise<void>;
  private abort:()=>void;private active:TrackingBackend='cpu';
  private constructor(private options:TrackingProcessOptions){
    this.exitPromise=new Promise(resolve=>{this.finishExit=resolve;});
    this.child=utilityProcess.fork(options.workerPath||path.join(__dirname,'tracking-worker.cjs'),[String(process.pid)],{stdio:'ignore',serviceName:'SLU Object Tracking'});
    this.abort=()=>this.fail(cancelled());
    this.child.on('spawn',()=>{this.diagnostic({event:'tracking-process-start',pid:this.child.pid});if(this.ending)this.child.kill();});
    this.child.on('message',message=>{
      if(message?.type==='backend'&&['cpu','dml'].includes(message.backend)){this.active=message.backend;this.diagnostic({event:'tracking-backend',backend:message.backend,reason:message.reason});return;}
      if(message?.type==='fatal'){this.fail(new TrackingProcessError(String(message.error)));return;}
      const pending=this.pending;if(!pending||message?.id!==pending.id)return;
      clearTimeout(pending.timer);this.pending=undefined;
      if(typeof message.error==='string')pending.reject(new TrackingProcessError(message.error));else pending.resolve(message.result);
    });
    this.child.on('exit',code=>{
      this.exited=true;this.options.signal?.removeEventListener('abort',this.abort);
      if(this.pending||!this.ending)this.fail(new TrackingProcessError(`객체 추적 프로세스가 종료되었습니다 (${code}).`));
      this.diagnostic({event:'tracking-process-exit',code});this.finishExit();
    });
    options.signal?.addEventListener('abort',this.abort,{once:true});if(options.signal?.aborted)this.abort();
  }
  static async create(options:TrackingProcessOptions):Promise<TrackingProcess>{
    if(options.signal?.aborted)throw cancelled();
    if(options.requestTimeoutMs!==undefined&&(!Number.isFinite(options.requestTimeoutMs)||options.requestTimeoutMs<100||options.requestTimeoutMs>180000))throw new Error('추적 작업 시간 제한이 올바르지 않습니다.');
    const tracker=new TrackingProcess(options);
    try{await tracker.request('open',{options:{modelPath:options.modelPath,backend:options.backend,profilePrefix:options.profilePrefix}});return tracker;}
    catch(error){await tracker.close();throw error;}
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
    if(this.ending)return Promise.reject(new Error('추적 작업이 이미 종료되었습니다.'));
    if(this.pending)return Promise.reject(new Error('이전 추적 프레임을 처리 중입니다.'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(new TrackingProcessError('추적 엔진이 응답하지 않아 작업을 중단했습니다.')),this.options.requestTimeoutMs??60000);
      this.pending={id,resolve,reject,timer};
      try{this.child.postMessage({id,method,...payload});}catch(error){this.fail(error instanceof Error?error:new Error(String(error)));}
    });
  }
  async anchor(frame:TrackingFrame,box:TrackingBox):Promise<TrackingObservation>{assertTrackingFrame(frame);assertTrackingBox(box,frame.width,frame.height);return this.request('anchor',{frame,box});}
  async update(frame:TrackingFrame):Promise<TrackingObservation>{assertTrackingFrame(frame);return this.request('update',{frame});}
  async close():Promise<void>{
    if(this.exited)return;
    if(!this.ending&&!this.pending){try{await this.request('close');}catch{/* The exit/crash path already rejected its request. */}}
    this.fail(this.failure||new Error('추적 작업이 종료되었습니다.'));await this.exitPromise;
  }
}
