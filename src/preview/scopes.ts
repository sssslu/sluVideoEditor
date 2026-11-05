import type {ScopeFrame,ScopeResult} from '../../shared/scopes';

/** Read immediately after composition: WebGL's default buffer is not preserved.
 * At most one worker frame, one deferred redraw, and eight samples per second.
 */
export class ScopeSampler {
  private canvas=document.createElement('canvas');private context=this.canvas.getContext('2d',{alpha:false,willReadFrequently:true})!;
  private worker:Worker;private busy=false;private closed=false;private revision=0;private serial=0;private next=0;private timer?:ReturnType<typeof setTimeout>;private refresh=false;
  constructor(private onResult:(result:ScopeResult)=>void,private onError:(message:string)=>void,private requestDraw:()=>void){
    this.worker=new Worker(new URL('./scopes.worker.ts',import.meta.url),{type:'module'});
    this.worker.onmessage=({data}:MessageEvent<ScopeResult&{error?:string}>)=>{if(this.closed)return;this.busy=false;if(data.revision===this.revision){if(data.error)this.fail(data.error);else this.onResult(data);}if(this.refresh){this.refresh=false;this.schedule();}};
    this.worker.onerror=event=>{event.preventDefault();this.fail('스코프 분석을 실행하지 못했습니다.');};
  }
  private fail(message:string){if(this.closed)return;this.dispose();this.onError(message);}
  invalidate(){this.revision++;if(this.busy)this.refresh=true;}
  private schedule(){if(this.timer!==undefined||this.closed)return;this.timer=setTimeout(()=>{this.timer=undefined;if(!this.closed)this.requestDraw();},Math.max(0,this.next-performance.now()));}
  capture(source:HTMLCanvasElement,time:number,playing:boolean){
    if(this.closed)return;const now=performance.now();
    if(this.busy){if(!playing)this.refresh=true;return;}
    if(now<this.next){if(!playing)this.schedule();return;}
    try{
      const scale=Math.min(1,320/source.width,180/source.height),width=Math.max(1,Math.floor(source.width*scale)),height=Math.max(1,Math.floor(source.height*scale));
      if(this.canvas.width!==width||this.canvas.height!==height){this.canvas.width=width;this.canvas.height=height;}
      this.context.drawImage(source,0,0,width,height);const pixels=this.context.getImageData(0,0,width,height).data.buffer as ArrayBuffer;
      const frame:ScopeFrame={revision:this.revision,serial:++this.serial,time,width,height,pixels};this.busy=true;this.next=now+125;this.worker.postMessage(frame,[pixels]);
    }catch(error){this.fail(error instanceof Error?error.message:String(error));}
  }
  dispose(){if(this.closed)return;this.closed=true;clearTimeout(this.timer);this.worker.terminate();this.canvas.width=1;this.canvas.height=1;}
}
