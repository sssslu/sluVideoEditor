import {app,BrowserWindow} from 'electron';
import {appendFileSync,writeFileSync,existsSync} from 'node:fs';

/** Test-only supervision. A closed harness pipe must never invoke Electron's
 * uncaught-exception dialog, or leave an invisible renderer behind. */
export function electronTestLifecycle(){
  const control=new AbortController(),tasks=new Set<Promise<unknown>>(),cleanups=new Set<()=>Promise<unknown>>();let closing=false;
  const log=(error:unknown)=>{try{if(process.env.SLU_TEST_LOG)appendFileSync(process.env.SLU_TEST_LOG,`\nHarness failure: ${String(error)}\n`);}catch{/* The diagnostic sink itself may have closed. */}};
  const close=async(code:number,error?:unknown)=>{
    if(closing)return;closing=true;if(error)log(error);control.abort();clearInterval(parentWatch);
    const timeout=new Promise<void>(resolve=>{const timer=setTimeout(resolve,5000);timer.unref();});
    await Promise.race([Promise.allSettled([...tasks,...[...cleanups].map(cleanup=>cleanup())]),timeout]);
    for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.destroy();
    try{if(process.env.SLU_TEST_CLEANUP_REPORT)writeFileSync(process.env.SLU_TEST_CLEANUP_REPORT,JSON.stringify({code,windows:BrowserWindow.getAllWindows().length,error:error?String(error):undefined}));}catch{}
    app.exit(code);
  };
  process.stdout.on('error',error=>{void close(1,error);});process.stderr.on('error',error=>{void close(1,error);});
  process.on('uncaughtException',error=>{void close(1,error);});process.on('unhandledRejection',error=>{void close(1,error);});
  process.on('disconnect',()=>{void close(1,new Error('Test supervisor disconnected'));});
  process.on('SIGINT',()=>{void close(130);});process.on('SIGTERM',()=>{void close(143);});
  const parent=Number(process.env.SLU_TEST_PARENT_PID);
  const parentWatch=setInterval(()=>{if(process.env.SLU_TEST_SUPERVISOR_FILE&&!existsSync(process.env.SLU_TEST_SUPERVISOR_FILE)){void close(1,new Error('Test supervisor disconnected'));return;}if(parent>0)try{process.kill(parent,0);}catch{void close(1,new Error('Test supervisor exited'));}},250);parentWatch.unref();
  return {signal:control.signal,close,registerCleanup:(cleanup:()=>Promise<unknown>)=>cleanups.add(cleanup),track<T>(promise:Promise<T>):Promise<T>{tasks.add(promise);void promise.finally(()=>tasks.delete(promise)).catch(()=>{});return promise;}};
}
