export class CancelledError extends Error {
  constructor(){super('작업을 취소했습니다.');this.name='AbortError';}
}

interface Entry<T> {controller:AbortController;promise:Promise<T>;waiting:number;settled:boolean}

/** Reuse a probe without lending one job's cancellation signal to another.
 * The native probe stops only when its last waiting caller cancels. */
export class ProbeCache<T> {
  private entries=new Map<string,Entry<T>>();
  constructor(private capacity=256){
    if(!Number.isSafeInteger(capacity)||capacity<1)throw new RangeError('Probe cache capacity must be positive');
  }
  get(key:string,probe:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T> {
    if(signal?.aborted)return Promise.reject(new CancelledError());
    let entry=this.entries.get(key);
    if(!entry){
      const current:Entry<T>={controller:new AbortController(),promise:undefined!,waiting:0,settled:false};
      current.promise=Promise.resolve().then(()=>{
        if(current.controller.signal.aborted)throw new CancelledError();
        return probe(current.controller.signal);
      }).then(value=>{
        current.settled=true;
        if(current.controller.signal.aborted)throw new CancelledError();
        return value;
      },error=>{current.settled=true;throw error;});
      void current.promise.catch(()=>{if(this.entries.get(key)===current)this.entries.delete(key);});
      if(this.entries.size>=this.capacity)this.entries.delete(this.entries.keys().next().value!);
      this.entries.set(key,current);entry=current;
    }
    const shared=entry;shared.waiting++;
    return new Promise<T>((resolve,reject)=>{
      let finished=false;
      const release=()=>{
        if(finished)return false;finished=true;signal?.removeEventListener('abort',abort);
        if(--shared.waiting===0&&!shared.settled){
          // Remove before aborting: a reentrant/new caller must not join a
          // probe already being stopped. A late rejection cannot erase it.
          if(this.entries.get(key)===shared)this.entries.delete(key);
          shared.controller.abort();
          return 'stopping' as const;
        }
        return 'released' as const;
      };
      const abort=()=>{
        const released=release();if(!released)return;
        const cancelled=()=>reject(new CancelledError());
        // runProcess settles only after the native child closes. The final
        // caller must retain that lifecycle guarantee when it stops the probe.
        if(released==='stopping')void shared.promise.then(cancelled,cancelled);else cancelled();
      };
      signal?.addEventListener('abort',abort,{once:true});
      shared.promise.then(value=>{if(release())resolve(value);},error=>{if(release())reject(error);});
    });
  }
}
