export interface AudioLevelFrame {revision:number;sequence:number;time:number;frames:number;peak:number[];rms:number[]}
export const levelDb=(value:number)=>Number.isFinite(value)&&value>0?Math.max(-120,20*Math.log10(value)):-120;
export const levelPercent=(db:number)=>Math.max(0,Math.min(100,(db+60)/60*100));
export function validAudioLevels(value:unknown):value is AudioLevelFrame {
  const v=value as AudioLevelFrame;
  return !!v&&Number.isSafeInteger(v.revision)&&v.revision>=0&&Number.isSafeInteger(v.sequence)&&v.sequence>0&&Number.isFinite(v.time)&&v.time>=0&&Number.isSafeInteger(v.frames)&&v.frames>0&&
    [v.peak,v.rms].every(a=>Array.isArray(a)&&a.length===4&&a.every(n=>Number.isFinite(n)&&n>=0))&&v.rms.every((n,i)=>n<=v.peak[i]+1e-6);
}

/** Peak hold is a visual aid. The overload latch persists until an explicit reset. */
export class AudioPeakHold {
  private values=[-120,-120,-120,-120];private until=[0,0,0,0];private previous=0;
  readonly overload=[false,false,false,false];readonly maximum=[-120,-120,-120,-120];
  update(peak:number[],now:number){
    const elapsed=Math.max(0,Math.min(10,now-this.previous));this.previous=now;
    for(let i=0;i<4;i++){
      const db=levelDb(peak[i]);this.maximum[i]=Math.max(this.maximum[i],db);this.overload[i]||=peak[i]>1;
      if(db>=this.values[i]){this.values[i]=db;this.until[i]=now+1.5;}
      else if(now>this.until[i])this.values[i]=Math.max(db,this.values[i]-20*Math.min(elapsed,now-this.until[i]));
    }
    return [...this.values];
  }
}
