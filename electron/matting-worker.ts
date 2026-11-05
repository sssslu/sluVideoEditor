import {PersonMatting,type MattingModelOptions,type MattingFrame} from './matting-model';

const port=process.parentPort;
if(!port)throw new Error('배경 제거 작업 프로세스에서만 실행할 수 있습니다.');
let engine:PersonMatting|undefined,busy=false;
const message=(value:unknown)=>{try{port.postMessage(value);}catch{process.exit(1);}};
const description=(error:unknown)=>(error instanceof Error?error.message:String(error)).slice(0,4000);
process.on('uncaughtException',error=>{message({type:'fatal',error:description(error)});process.exit(1);});
process.on('unhandledRejection',error=>{message({type:'fatal',error:description(error)});process.exit(1);});

// No console pipe: broken parent stdout must never open an EPIPE dialog.
const parentPid=Number(process.argv[2]);
if(!Number.isSafeInteger(parentPid)||parentPid<=0)throw new Error('배경 제거 작업의 부모 프로세스가 올바르지 않습니다.');
setInterval(()=>{try{process.kill(parentPid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')process.exit(0);}},1000).unref();

port.on('message',async(event:Electron.MessageEvent)=>{
 const request=event.data as {id:number;method:string;options?:MattingModelOptions;frame?:MattingFrame;pts?:number};
 if(!request||!Number.isSafeInteger(request.id)||request.id<1){message({type:'fatal',error:'배경 제거 작업 요청이 올바르지 않습니다.'});process.exit(1);}
 if(busy){message({id:request.id,error:'이전 배경 제거 프레임을 처리 중입니다.'});return;}
 busy=true;
 try{
  let result:unknown;
  if(request.method==='open'){
   if(engine)throw new Error('배경 제거 엔진이 이미 열려 있습니다.');
   const {modelPath,gpuModelPath,backend,quality,profilePrefix}=request.options||{} as MattingModelOptions;
   engine=await PersonMatting.create({modelPath,gpuModelPath,backend,quality,profilePrefix,onBackend:(backend,reason)=>message({type:'backend',backend,reason}),...(profilePrefix?{onFrameTiming:(timing:import('./matting-model').MattingFrameTiming)=>message({type:'timing',timing})}:{})});
   result={backend:engine.backend};
  }else{
   if(!engine)throw new Error('배경 제거 엔진을 먼저 여세요.');
   if(request.method==='process')result=await engine.process(request.frame!,request.pts!);
   else if(request.method==='reset'){engine.reset();result=null;}
   else if(request.method==='close'){await engine.close();engine=undefined;result=null;}
   else throw new Error('지원하지 않는 배경 제거 작업입니다.');
  }
  message({id:request.id,result});
 }catch(error){message({id:request.id,error:description(error)});}
 finally{busy=false;}
});
