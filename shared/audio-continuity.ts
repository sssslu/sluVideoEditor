import type {Clip,SpeedPoint} from './types';
import {clipSourceTime,clipSpeedAt,MAX_SPEED_POINTS} from './speed';

export interface ContinuousAudioGroup {clip:Clip;members:Clip[]}
const near=(a:number,b:number)=>Math.abs(a-b)<1e-8;
function joinCurve(a:Clip,b:Clip):SpeedPoint[]|undefined|null {
  if(!a.speedCurve&&!b.speedCurve)return near(a.speed,b.speed)?undefined:null;
  if(!a.speedCurve||!b.speedCurve||!near(clipSpeedAt(a,a.duration),clipSpeedAt(b,0)))return null;
  const duration=a.duration+b.duration,points=[...a.speedCurve.map(p=>({position:p.position*a.duration/duration,speed:p.speed})),...b.speedCurve.slice(1).map(p=>({position:(a.duration+p.position*b.duration)/duration,speed:p.speed}))];
  points[0].position=0;points[points.length-1].position=1;
  const compact:SpeedPoint[]=[];
  for(const point of points){compact.push(point);while(compact.length>=3){const n=compact.length,[l,m,r]=compact.slice(n-3),expected=l.speed+(r.speed-l.speed)*(m.position-l.position)/(r.position-l.position);if(Math.abs(expected-m.speed)>1e-10)break;compact.splice(n-2,1);}}
  return compact.length<=MAX_SPEED_POINTS?compact:null;
}
/** Rejoin untouched splits for audio processing only. Timeline/visual clips stay
 * independent. This avoids resetting a recursive EQ (and time-stretcher) at a
 * purely editorial cut; different effects, envelopes, sources or transitions
 * remain separate. Shared by export and planned preview continuity work. */
export function continuousAudioGroups(clips:readonly Clip[],transitionClipIds:ReadonlySet<string>):ContinuousAudioGroup[]{
  const groups:ContinuousAudioGroup[]=[],lastByTrack=new Map<string,ContinuousAudioGroup>();
  for(const clip of [...clips].sort((a,b)=>a.start-b.start)){
    const group=lastByTrack.get(clip.trackId),a=group?.clip,eq=clip.audioEQ;
    const filtered=eq?.enabled&&eq.bands.some(b=>b.enabled&&(['highpass','lowpass'].includes(b.type)||b.gain!==0));
    const compatible=filtered&&a&&!transitionClipIds.has(a.id)&&!transitionClipIds.has(clip.id)&&a.mediaId===clip.mediaId&&near(a.start+a.duration,clip.start)&&near(clipSourceTime(a,a.duration),clip.in)&&a.volume===clip.volume&&a.fadeIn===clip.fadeIn&&a.fadeOut===clip.fadeOut&&a.sourceClipDuration!==undefined&&a.sourceClipDuration===clip.sourceClipDuration&&near((a.sourceClipOffset??0)+a.duration,clip.sourceClipOffset??0)&&JSON.stringify(a.audioEQ)===JSON.stringify(eq);
    const curve=compatible?joinCurve(a,clip):null;
    if(compatible&&curve!==null){group!.clip={...a,duration:a.duration+clip.duration,speedCurve:curve};group!.members.push(clip);}
    else{const next={clip,members:[clip]};groups.push(next);lastByTrack.set(clip.trackId,next);}
  }
  return groups;
}
