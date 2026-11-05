import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import type {BrowserWindow,MessagePortMain} from 'electron';
import type {CaptionRasterFactory,CaptionRasterRequest,CaptionRasterResponse,CaptionRasterGroup} from './caption-raster-types';

const cancelled=()=>Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError'});
/** Electron is loaded lazily: the FFmpeg engine remains usable by Node tests. */
export const createCaptionRasterWithPaths=async(...[project,settings,signal,diagnostics,paths]:[...Parameters<CaptionRasterFactory>,{directory:string;preload:string}?]):ReturnType<CaptionRasterFactory>=>{
  if(signal?.aborted)throw cancelled();
  const electron=await import('electron');
  if(!electron.BrowserWindow)throw new Error('정확한 자막 내보내기는 SLU Studio 앱의 자막 렌더러가 필요합니다.');
  await electron.app.whenReady();
  const directory=paths?.directory||path.resolve(__dirname,'../dist'),html=path.join(directory,'caption-export.html');
  // A dedicated in-memory partition is reused so repeated exports do not
  // accumulate native Session objects. It never shares editor permissions.
  const session=electron.session.fromPartition('slu-caption-raster',{cache:false});
  session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  session.setPermissionCheckHandler(()=>false);
  session.webRequest.onBeforeRequest((details,callback)=>{
    try{const file=fileURLToPath(details.url),relative=path.relative(directory,file);callback({cancel:relative.startsWith('..')||path.isAbsolute(relative)});}catch{callback({cancel:true});}
  });
  let window:BrowserWindow|undefined,port:MessagePortMain|undefined,untransferredPort:MessagePortMain|undefined,closed=false,serial=0;
  const frames=new Map<string,{signature:string;rgba:Uint8Array}>();let cacheBytes=0,peakCacheBytes=0,transferredBytes=0,reusedFrames=0,renderedFrames=0;
  const pending=new Map<number,{resolve:(result:CaptionRasterResponse)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  let queue:Promise<unknown>=Promise.resolve();
  const closeWith=(error:Error)=>{
    if(closed)return;closed=true;
    for(const request of pending.values()){clearTimeout(request.timer);request.reject(error);}pending.clear();
    port?.close();untransferredPort?.close();untransferredPort=undefined;if(window&&!window.isDestroyed())window.destroy();signal?.removeEventListener('abort',abort);
    frames.clear();cacheBytes=0;diagnostics?.({event:'caption-renderer-close',peakCacheBytes,transferredBytes,reusedFrames,renderedFrames});
  };
  const abort=()=>closeWith(cancelled());
  signal?.addEventListener('abort',abort,{once:true});
  const request=(message:Omit<CaptionRasterRequest,'id'>):Promise<CaptionRasterResponse>=>{
    const run=async()=>{
      if(closed||signal?.aborted)throw cancelled();
      const id=++serial;
      return new Promise<CaptionRasterResponse>((resolve,reject)=>{
        const timer=setTimeout(()=>{const error=new Error('자막 렌더러가 응답하지 않습니다.');closeWith(error);},60000);
        pending.set(id,{resolve,reject,timer});port!.postMessage({...message,id});
      });
    };
    const result=queue.then(run);queue=result.catch(()=>{});return result;
  };
  try{
    window=new electron.BrowserWindow({show:false,width:32,height:32,webPreferences:{preload:paths?.preload||path.resolve(__dirname,'caption-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false,session,spellcheck:false}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.on('render-process-gone',(_event,details)=>closeWith(new Error(`자막 렌더러가 종료되었습니다 (${details.reason}).`)));
    window.on('closed',()=>{if(!closed)closeWith(new Error('자막 렌더러 창이 닫혔습니다.'));});
    const channel=new electron.MessageChannelMain();port=channel.port1;untransferredPort=channel.port2;
    port.on('close',()=>closeWith(new Error('자막 렌더러 연결이 종료되었습니다.')));
    port.on('message',event=>{
      const response=event.data as CaptionRasterResponse,waiting=pending.get(response?.id);if(!waiting)return;
      clearTimeout(waiting.timer);pending.delete(response.id);
      if(response.error)waiting.reject(new Error(response.error));else waiting.resolve(response);
    });port.start();
    await window.loadFile(html);if(closed||signal?.aborted)throw cancelled();
    window.webContents.postMessage('slu-caption:port',null,[channel.port2]);untransferredPort=undefined;
    // Only dimensions and frame timing are needed. Do not clone source paths,
    // all 10,000 clips, or the application's media permissions into the sandbox.
    await request({op:'init',project:{version:project.version,id:'caption-raster',name:'',width:project.width,height:project.height,fps:project.fps,background:project.background,updatedAt:'',media:[],tracks:[],clips:[]},settings} as Omit<CaptionRasterRequest,'id'>);
    diagnostics?.({event:'caption-renderer-start',pid:window.webContents.getOSProcessId(),sandbox:true});
    return {
      async prepare(clips){const id=randomUUID(),result=await request({op:'prepare',group:id,clips} as Omit<CaptionRasterRequest,'id'>),b=result.bounds;if(!b||![b.x,b.y,b.width,b.height].every(Number.isInteger)||b.x<0||b.y<0||b.width<1||b.height<1||b.x+b.width>settings.width||b.y+b.height>settings.height)throw new Error('자막 영역을 계산하지 못했습니다.');return {id,...b};},
      async frame(group,globalFrame){
        const cached=frames.get(group.id),result=await request({op:'frame',group:group.id,globalFrame,reuse:cached?.signature} as Omit<CaptionRasterRequest,'id'>);
        if(result.reused){if(!cached||result.signature!==cached.signature)throw new Error('자막 프레임 캐시가 올바르지 않습니다.');reusedFrames++;return cached.rgba;}
        if(!(result.rgba instanceof ArrayBuffer)||result.rgba.byteLength!==group.width*group.height*4||typeof result.signature!=='string')throw new Error('자막 프레임 크기가 올바르지 않습니다.');
        const rgba=new Uint8Array(result.rgba);renderedFrames++;transferredBytes+=rgba.byteLength;
        if(cached){frames.delete(group.id);cacheBytes-=cached.rgba.byteLength;}
        if(rgba.byteLength<=64*1024*1024){while(cacheBytes+rgba.byteLength>64*1024*1024&&frames.size){const [id,old]=frames.entries().next().value!;frames.delete(id);cacheBytes-=old.rgba.byteLength;}frames.set(group.id,{signature:result.signature,rgba});cacheBytes+=rgba.byteLength;peakCacheBytes=Math.max(peakCacheBytes,cacheBytes);}
        return rgba;
      },
      async release(group:CaptionRasterGroup){const cached=frames.get(group.id);if(cached){frames.delete(group.id);cacheBytes-=cached.rgba.byteLength;}if(!closed)await request({op:'release',group:group.id} as Omit<CaptionRasterRequest,'id'>);},
      async close(){closeWith(new Error('자막 렌더러를 닫았습니다.'));await queue;},
    };
  }catch(error){closeWith(error instanceof Error?error:new Error(String(error)));throw error;}
};
export const createCaptionRaster:CaptionRasterFactory=(...args)=>createCaptionRasterWithPaths(...args);
