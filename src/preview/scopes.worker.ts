import {analyzeScopes,type ScopeFrame} from '../../shared/scopes';
const worker=globalThis as unknown as {onmessage:((event:MessageEvent<ScopeFrame>)=>void)|null;postMessage:(message:unknown,transfer:Transferable[])=>void};
worker.onmessage=({data})=>{
  try{const {pixels,...frame}=data,analysis=analyzeScopes(new Uint8ClampedArray(pixels),frame.width,frame.height);worker.postMessage({...frame,analysis},[analysis.histogram.buffer,analysis.waveform.buffer,analysis.vectors.buffer]);}
  catch(error){worker.postMessage({error:error instanceof Error?error.message:String(error),revision:data.revision,serial:data.serial},[]);}
};
