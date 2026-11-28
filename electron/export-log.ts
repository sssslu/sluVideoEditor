import {promises as fs} from 'node:fs';
import path from 'node:path';

const KEPT=new Set(['render-plan','gpu-fallback','encoder-fallback','window-padded','stream-metrics']);
const MAX_BYTES=512*1024;
const brief=(value:unknown):unknown=>typeof value==='string'?value.slice(0,2000):value;

/** A short local history of exports, `export-log.jsonl` in the user-data folder: what was asked for,
 * which encoder ran, every restart with its reason, windows that had to be padded, how long it took
 * and how it ended. An export that restarts or crawls can then be explained afterwards instead of
 * guessed at. The file stays on this computer and is cut to its newer half when it passes 512 KB. */
export function exportLog(directory:string,request:Record<string,unknown>){
  const file=path.join(directory,'export-log.jsonl'),started=Date.now();
  let queue:Promise<void>=Promise.resolve();
  const write=(entry:Record<string,unknown>)=>{
    queue=queue.then(async()=>{
      try{
        await fs.mkdir(directory,{recursive:true});
        const size=await fs.stat(file).then(stat=>stat.size,()=>0);
        if(size>MAX_BYTES){const lines=(await fs.readFile(file,'utf8')).split('\n').filter(Boolean);await fs.writeFile(file,lines.slice(Math.ceil(lines.length/2)).join('\n')+'\n','utf8');}
        await fs.appendFile(file,JSON.stringify({time:new Date().toISOString(),...Object.fromEntries(Object.entries(entry).map(([key,value])=>[key,brief(value)]))})+'\n','utf8');
      }catch{/* A log that cannot be written must never fail an export. */}
    });
  };
  write({event:'export-start',...request});
  return {
    diagnostics:(event:Record<string,unknown>)=>{if(KEPT.has(String(event.event)))write(event);},
    /** Resolves when everything, including this last line, is on disk. */
    finish:(outcome:'complete'|'failed'|'cancelled',message?:string)=>{write({event:'export-end',outcome,seconds:Math.round((Date.now()-started)/100)/10,message});return queue;}
  };
}
