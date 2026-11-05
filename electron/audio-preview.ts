import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {CancelledError,runProcess,type EngineContext} from './media';
import {requireSourceRevision} from './source-revision';
import {replaceWithRetry} from './project-store';

/** Chromium156's elementary MP3 demuxer can find a false frame header when
 * seeking (reproduced with both Symphonia and FFmpeg decoders). MP4 supplies
 * explicit packet boundaries and retains the MP3 priming edit. Stream-copy
 * only: original bytes and export audio stay untouched. The original duration
 * still bounds playback, including files with trailing MP3 encoder padding. */
export class AudioPreviewCache {
  private controller=new AbortController();
  private pending=new Map<string,Promise<string>>();
  private lanes:Promise<unknown>[]=[Promise.resolve(),Promise.resolve()];
  private next=0;
  constructor(private ctx:EngineContext){}
  async prepare(file:string,expected?:string):Promise<string>{
    if(this.controller.signal.aborted)throw new CancelledError();
    const revision=await requireSourceRevision(file,expected);
    const key=createHash('sha256').update(`mp3-preview-v1|${revision}`).digest('hex');
    const existing=this.pending.get(key);if(existing)return existing;
    const lane=this.next++%this.lanes.length;
    const work=this.lanes[lane].catch(()=>{}).then(()=>this.remux(file,revision,key));
    this.lanes[lane]=work;this.pending.set(key,work);
    try{return await work;}finally{if(this.pending.get(key)===work)this.pending.delete(key);}
  }
  private async remux(file:string,revision:string,key:string):Promise<string>{
    const signal=this.controller.signal;if(signal.aborted)throw new CancelledError();
    await requireSourceRevision(file,revision);
    await fs.mkdir(this.ctx.cacheDir,{recursive:true});
    const target=path.join(this.ctx.cacheDir,`${key}-audio-preview.mp4`);
    const cached=await fs.stat(target).catch(()=>undefined);if(cached?.isFile()&&cached.size>0)return target;
    const partial=path.join(this.ctx.cacheDir,`${key}-${randomUUID()}.partial.mp4`);
    try{
      await runProcess(this.ctx.ffmpeg,['-v','error','-nostdin','-y','-protocol_whitelist','file,pipe','-i',file,'-map','0:a:0','-vn','-map_metadata','-1','-c:a','copy','-movflags','+faststart','-f','mp4',partial],{signal,timeoutMs:120000,onSpawn:pid=>this.ctx.diagnostics?.({event:'audio-preview-start',pid})});
      await requireSourceRevision(file,revision);if(signal.aborted)throw new CancelledError();
      if(!(await fs.stat(partial)).size)throw new Error('오디오 미리보기 파일을 만들지 못했습니다.');
      await replaceWithRetry(partial,target);return target;
    }finally{await fs.rm(partial,{force:true}).catch(()=>{});}
  }
  async close(){this.controller.abort();await Promise.allSettled([...this.pending.values()]);}
}
