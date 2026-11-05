import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,promises as fs} from 'node:fs';
import path from 'node:path';
import {CancelledError} from './media';
import {insideDirectory,localFilePath} from './file-policy';

export interface EnhancementProcessOptions {
  pythonExecutable:string;
  workerPath:string;
  runtimeRoot:string;
  jobDirectory:string;
  width:number;
  height:number;
  scale:2|4;
  maximumFrames:number;
  maximumBytes:number;
  signal?:AbortSignal;
  progress?:(progress:number,message:string)=>void;
  diagnostics?:(event:Record<string,unknown>)=>void;
  requestTimeoutMs?:number;
}

export interface EnhancementBatch {
  outputFirstFrame:number;
  frameCount:number;
  pts:number[];
  outputFile:string|null;
  bytes:number;
  sha256:string|null;
  width:number;
  height:number;
  complete:boolean;
}

/** A single owned Python worker. Raw chunks stay on disk and only one request
 * can be in flight. Cancellation terminates native inference before cleanup. */
export class EnhancementProcess {
  private child:ChildProcessWithoutNullStreams;
  private pending?:{id:number;resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};
  private sequence=0;
  private failure?:Error;
  private ending=false;
  private exited=false;
  private done:Promise<void>;
  private inputFrames=0;
  private outputFrames=0;
  private waitingPts:number[]=[];
  private lastInputPts=-1;
  private complete=false;
  private processing=false;
  private stderr='';
  private abort:()=>void;
  inputCapacity=5;

  private constructor(private options:EnhancementProcessOptions) {
    this.child=spawn(options.pythonExecutable,[
      '-I','-B','-u',options.workerPath,'--runtime-root',options.runtimeRoot,
      '--job-dir',options.jobDirectory,'--parent-pid',String(process.pid),
    ],{
      windowsHide:true,shell:false,cwd:options.jobDirectory,stdio:['pipe','pipe','pipe'],
      env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'},
    });
    this.abort=()=>this.fail(new CancelledError());
    this.child.once('error',error=>this.fail(error));
    this.child.stdin.on('error',error=>this.fail(error));
    this.child.stdout.on('error',error=>this.fail(error));
    this.child.stderr.on('error',error=>this.fail(error));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data',(chunk:string)=>{this.stderr=(this.stderr+chunk).slice(-8000);});
    this.child.stdout.setEncoding('utf8');
    let buffered='';
    this.child.stdout.on('data',(chunk:string)=>{
      buffered+=chunk;
      if(buffered.length>65536){this.fail(new Error('화질 향상 엔진 응답이 너무 큽니다.'));return;}
      let newline:number;
      while((newline=buffered.indexOf('\n'))>=0) {
        const line=buffered.slice(0,newline).trim();
        buffered=buffered.slice(newline+1);
        if(!line)continue;
        try { this.receive(JSON.parse(line)); }
        catch(error) { this.fail(error instanceof Error?error:new Error(String(error))); }
      }
    });
    this.done=new Promise(resolve=>this.child.once('close',code=>{
      this.exited=true;
      options.signal?.removeEventListener('abort',this.abort);
      if(this.pending||!this.ending)this.fail(new Error('화질 향상 엔진이 종료되었습니다 ('+code+'). '+this.stderr));
      this.diagnostic({event:'enhancement-worker-exit',pid:this.child.pid,code});
      resolve();
    }));
    options.signal?.addEventListener('abort',this.abort,{once:true});
    if(options.signal?.aborted)this.abort();
    this.diagnostic({event:'enhancement-worker-start',pid:this.child.pid});
  }

  static async create(options:EnhancementProcessOptions):Promise<EnhancementProcess> {
    if(options.signal?.aborted)throw new CancelledError();
    for(const file of [options.pythonExecutable,options.workerPath,options.runtimeRoot,options.jobDirectory]) {
      if(!localFilePath(file)||!path.isAbsolute(file))throw new Error('화질 향상 실행 경로가 올바르지 않습니다.');
    }
    if(!Number.isInteger(options.width)||!Number.isInteger(options.height)||options.width<1||options.height<1||
      ![2,4].includes(options.scale)||Math.max(options.width,options.height)*options.scale>7680||
      options.width*options.height*options.scale**2>33177600||
      !Number.isSafeInteger(options.maximumFrames)||options.maximumFrames<1||options.maximumFrames>999999999||
      !Number.isSafeInteger(options.maximumBytes)||options.maximumBytes<options.maximumFrames*options.width*options.height*3||
      (options.requestTimeoutMs!==undefined&&(!Number.isFinite(options.requestTimeoutMs)||options.requestTimeoutMs<100||options.requestTimeoutMs>1800000))) {
      throw new Error('화질 향상 처리 범위가 올바르지 않습니다.');
    }
    const engine=new EnhancementProcess(options);
    try {
      const result=await engine.request('init',{config:{
        protocolVersion:1,width:options.width,height:options.height,scale:options.scale,
        seed:42,chunkFrames:9,overlapFrames:4,
        maximumFrames:options.maximumFrames,maximumBytes:options.maximumBytes,
      }});
      if(result?.protocolVersion!==1||result.backend!=='cuda'||result.model!=='seedvr2-3b-fp16'||
        result.inputCapacity!==5||result.chunkFrames!==9||result.overlapFrames!==4||
        result.hardware?.inferenceStrategy!=='independent-frames-v1'||result.hardware.modelTemporalFrames!==1||
        result.hardware.transportWindowFrames!==9||result.hardware.overlapReuseFrames!==4||
        result.outputWidth!==options.width*options.scale||result.outputHeight!==options.height*options.scale) {
        throw new Error('화질 향상 엔진 초기화 응답이 올바르지 않습니다.');
      }
      engine.diagnostic({event:'enhancement-worker-ready',...result});
      return engine;
    } catch(error) {
      engine.fail(error instanceof Error?error:new Error(String(error)));
      await engine.close();
      throw error;
    }
  }

  private diagnostic(event:Record<string,unknown>) {try{this.options.diagnostics?.(event);}catch{}}

  private receive(message:any) {
    if(message?.type==='progress') {
      if(typeof message.progress!=='number'||!Number.isFinite(message.progress)||typeof message.message!=='string')throw new Error('화질 향상 진행 응답이 올바르지 않습니다.');
      try{this.options.progress?.(Math.max(0,Math.min(1,message.progress)),message.message.slice(0,500));}catch{}
      return;
    }
    const pending=this.pending;
    if(!pending||message?.id!==pending.id)throw new Error('화질 향상 엔진 응답 순서가 올바르지 않습니다.');
    clearTimeout(pending.timer);
    this.pending=undefined;
    if(typeof message.error==='string')pending.reject(new Error(message.error.slice(0,8000)));
    else if(message.result&&typeof message.result==='object')pending.resolve(message.result);
    else pending.reject(new Error('화질 향상 엔진 응답이 비어 있습니다.'));
  }

  private fail(error:Error) {
    this.failure??=error;
    this.ending=true;
    if(this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending=undefined;
    }
    if(!this.exited)this.child.kill();
  }

  private request(method:string,fields:Record<string,unknown>={}):Promise<any> {
    if(this.failure)return Promise.reject(this.failure);
    if(this.ending||this.pending)return Promise.reject(new Error('이전 화질 향상 작업이 아직 끝나지 않았습니다.'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(new Error('화질 향상 엔진의 응답 시간이 초과되었습니다.')),this.options.requestTimeoutMs??900000);
      this.pending={id,resolve,reject,timer};
      this.child.stdin.write(JSON.stringify({id,method,...fields})+'\n',error=>{if(error)this.fail(error);});
    });
  }

  async process(inputFile:string|null,pts:number[],last:boolean):Promise<EnhancementBatch> {
    if(this.complete||this.pending||this.processing||!Array.isArray(pts)||typeof last!=='boolean')throw new Error('화질 향상 프레임 처리 순서가 올바르지 않습니다.');
    const count=pts.length;
    const expectedName='input-'+String(this.inputFrames).padStart(9,'0')+'.bgr';
    if(count>this.inputCapacity||(!last&&count!==this.inputCapacity)||
      (count?inputFile!==expectedName:!last||inputFile!==null)||
      this.inputFrames+count>this.options.maximumFrames||
      (this.inputFrames+count)*this.options.width*this.options.height*3>this.options.maximumBytes||
      pts.some((value,index)=>!Number.isSafeInteger(value)||value<0||value<=(index?pts[index-1]:this.lastInputPts))) {
      throw new Error('화질 향상 입력 프레임이 올바르지 않습니다.');
    }
    this.processing=true;
    this.waitingPts.push(...pts);
    try {
      const result=await this.request('process',{firstFrame:this.inputFrames,frameCount:count,pts,inputFile,last}) as EnhancementBatch;
      this.inputFrames+=count;
      if(count)this.lastInputPts=pts[count-1];
      const expectedFrames=last?this.waitingPts.length:Math.max(0,this.waitingPts.length-4);
      if(!result||result.outputFirstFrame!==this.outputFrames||result.frameCount!==expectedFrames||!Array.isArray(result.pts)||
        result.pts.length!==result.frameCount||result.pts.some((value,index)=>value!==this.waitingPts[index])||
        result.width!==this.options.width*this.options.scale||result.height!==this.options.height*this.options.scale||
        result.bytes!==result.width*result.height*4*result.frameCount||result.complete!==last) {
        throw new Error('화질 향상 결과의 프레임 시각 또는 크기가 일치하지 않습니다.');
      }
      if(result.frameCount) {
        const expected='output-'+String(this.outputFrames).padStart(9,'0')+'.bgra';
        if(result.outputFile!==expected||typeof result.sha256!=='string'||!/^[a-f0-9]{64}$/.test(result.sha256))throw new Error('화질 향상 결과 파일이 올바르지 않습니다.');
        const file=path.join(this.options.jobDirectory,expected),info=await fs.lstat(file),canonical=await fs.realpath(file);
        if(!info.isFile()||info.isSymbolicLink()||info.size!==result.bytes||!insideDirectory(canonical,await fs.realpath(this.options.jobDirectory)))throw new Error('화질 향상 결과 파일 연결이 올바르지 않습니다.');
        const hash=createHash('sha256');
        for await(const bytes of createReadStream(file)){if(this.options.signal?.aborted)throw new CancelledError();hash.update(bytes);}
        if(hash.digest('hex')!==result.sha256)throw new Error('화질 향상 결과 파일 무결성 검사에 실패했습니다.');
      } else if(result.outputFile!==null||result.sha256!==null)throw new Error('비어 있는 화질 향상 결과에 파일이 포함되어 있습니다.');
      this.outputFrames+=result.frameCount;
      this.waitingPts.splice(0,result.frameCount);
      if(last&&this.outputFrames!==this.inputFrames)throw new Error('화질 향상 결과의 전체 프레임 수가 일치하지 않습니다.');
      this.complete=last;
      return result;
    } catch(error) {
      this.fail(error instanceof Error?error:new Error(String(error)));
      throw error;
    } finally {
      this.processing=false;
    }
  }

  async close():Promise<void> {
    if(!this.exited&&!this.ending&&!this.pending&&!this.processing) {
      try{await this.request('close');}catch{}
    }
    this.fail(this.failure??new Error('화질 향상 작업을 종료했습니다.'));
    await this.done;
  }
}
