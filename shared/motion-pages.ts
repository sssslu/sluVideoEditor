import type {MotionAnalysis,MotionSample} from './tracking';
import {motionSampleAt} from './motion';
export interface MotionPage {metadata:MotionAnalysis;startIndex:number;samples:MotionSample[];nextIndex?:number}
export type MotionPageRead=(path:string,time:number,limit:number)=>Promise<MotionPage>;
/** Bounded immutable pages, usable by renderer prefetch and sequential export.
 * The final sample is only known up to its timestamp unless this is EOF. */
export class MotionPageCache {
  private pages=new Map<string,MotionPage>();private pending=new Map<string,Promise<void>>();private errors=new Map<string,Error>();private generation=0;
  constructor(private read:MotionPageRead,private changed:()=>void=()=>{},private pageLimit=64){}
  private key(a:MotionAnalysis){return a.id+'|'+a.path+'|'+a.sourceRevision;}
  peek(a:MotionAnalysis,time:number):MotionSample|undefined{
    const key=this.key(a),error=this.errors.get(key);if(error)throw error;
    for(const [pageKey,page] of this.pages){const samples=page.samples;if(!pageKey.startsWith(key+'@')||!samples.length||(page.startIndex!==0&&time<samples[0].time-1e-9)||(page.nextIndex!==undefined&&time>samples.at(-1)!.time+1e-9))continue;
      this.pages.delete(pageKey);this.pages.set(pageKey,page);return motionSampleAt(samples,time);
    }
  }
  request(a:MotionAnalysis,time:number):void {
    if(this.peek(a,time))return;const key=this.key(a),requestKey=key+'@'+time;if(this.pending.has(requestKey)||this.pending.size>=4)return;
    const generation=this.generation,promise=this.read(a.path,time,512).then(page=>{
      if(generation!==this.generation)return;
      if(page.metadata.id!==a.id||page.metadata.sourceRevision!==a.sourceRevision||!page.samples.length||page.samples.length>512)throw new Error('추적 경로 응답이 프로젝트와 일치하지 않습니다.');
      if((page.startIndex>0&&time<page.samples[0].time-1e-9)||(page.nextIndex!==undefined&&time>page.samples.at(-1)!.time+1e-9))throw new Error('추적 경로 응답에 요청한 프레임이 없습니다.');
      this.pages.set(key+'@'+page.startIndex,page);while(this.pages.size>this.pageLimit)this.pages.delete(this.pages.keys().next().value!);
    }).catch(error=>{if(generation===this.generation){this.errors.set(key,error instanceof Error?error:new Error(String(error)));while(this.errors.size>this.pageLimit)this.errors.delete(this.errors.keys().next().value!);}}).finally(()=>{if(generation===this.generation){this.pending.delete(requestKey);this.changed();}});
    this.pending.set(requestKey,promise);
  }
  async get(a:MotionAnalysis,time:number):Promise<MotionSample>{
    for(;;){const sample=this.peek(a,time);if(sample)return sample;this.request(a,time);const pending=this.pending.get(this.key(a)+'@'+time);if(pending)await pending;else if(this.pending.size)await Promise.race(this.pending.values());else throw new Error('추적 경로를 읽지 못했습니다.');}
  }
  clear(){this.generation++;this.pages.clear();this.pending.clear();this.errors.clear();}
  stats(){return {pages:this.pages.size,pending:this.pending.size,errors:this.errors.size,samples:[...this.pages.values()].reduce((n,p)=>n+p.samples.length,0)};}
}
