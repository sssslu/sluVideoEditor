import {ObjectTracker,type TrackingModelOptions} from './tracking-model';
import type {TrackingBox,TrackingFrame} from './tracking-math';

// This entry point runs in Electron's isolated utility process. It has no file
// write API, renderer connection, network requests or child decoder processes.
const port=process.parentPort;
if(!port)throw new Error('객체 추적 작업 프로세스에서만 실행할 수 있습니다.');
let tracker:ObjectTracker|undefined,busy=false;
const message=(value:unknown)=>{try{port.postMessage(value);}catch{process.exit(1);}};
const description=(error:unknown)=>(error instanceof Error?error.message:String(error)).slice(0,4000);
process.on('uncaughtException',error=>{message({type:'fatal',error:description(error)});process.exit(1);});
process.on('unhandledRejection',error=>{message({type:'fatal',error:description(error)});process.exit(1);});

// The parent may be terminated rather than exiting normally. No inherited
// console pipe is used (the earlier EPIPE failure must not return here).
const parentPid=Number(process.argv[2]);
if(!Number.isSafeInteger(parentPid)||parentPid<=0)throw new Error('추적 작업의 부모 프로세스가 올바르지 않습니다.');
setInterval(()=>{try{process.kill(parentPid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')process.exit(0);}},1000).unref();

port.on('message',async(event:Electron.MessageEvent)=>{
  const request=event.data as {id:number;method:string;options?:TrackingModelOptions;frame?:TrackingFrame;box?:TrackingBox};
  if(!request||!Number.isSafeInteger(request.id)||request.id<1){message({type:'fatal',error:'추적 작업 요청이 올바르지 않습니다.'});process.exit(1);}
  if(busy){message({id:request.id,error:'이전 추적 프레임을 처리 중입니다.'});return;}
  busy=true;
  try{
    let result:unknown;
    if(request.method==='open'){
      if(tracker)throw new Error('추적 엔진이 이미 열려 있습니다.');
      const {modelPath,backend,profilePrefix}=request.options||{} as TrackingModelOptions;
      tracker=await ObjectTracker.create({modelPath,backend,profilePrefix,onBackend:(backend,reason)=>message({type:'backend',backend,reason})});
      result={backend:tracker.backend};
    }else{
      if(!tracker)throw new Error('추적 엔진을 먼저 여세요.');
      if(request.method==='anchor')result=tracker.anchor(request.frame!,request.box!);
      else if(request.method==='update')result=await tracker.update(request.frame!);
      else if(request.method==='close'){await tracker.close();tracker=undefined;result=null;}
      else throw new Error('지원하지 않는 추적 작업입니다.');
    }
    message({id:request.id,result});
  }catch(error){message({id:request.id,error:description(error)});}
  finally{busy=false;}
});
