import type {Clip,SpeedPoint} from './types';

type SpeedClip=Pick<Clip,'duration'|'speed'|'in'|'speedCurve'>;
export const MAX_SPEED_POINTS=64;
/** Constant speed spans 10%–50000%. Curves stay within the audio stretcher's 0.1–16× range. */
export const MIN_SPEED=.1,MAX_SPEED=500,MAX_CURVE_SPEED=16;
/** 1.5 -> "150%", 1/3 -> "33.33%". */
export const speedPercent=(speed:number)=>`${Number((speed*100).toFixed(2))}%`;
export interface SpeedSegment {from:number;to:number;rate:number;slope:number;sourceStart:number;sourceEnd:number}

export function assertSpeedCurve(value:unknown):asserts value is SpeedPoint[] {
  if(!Array.isArray(value)||value.length<2||value.length>MAX_SPEED_POINTS)throw new Error('속도 곡선은 2~64개의 점이 필요합니다.');
  let previous=-1;
  for(const point of value){
    if(!point||typeof point!=='object'||!Number.isFinite(point.position)||point.position<0||point.position>1||point.position-previous<1e-12||!Number.isFinite(point.speed)||point.speed<MIN_SPEED||point.speed>MAX_CURVE_SPEED)throw new Error('속도 곡선의 위치 또는 속도가 유효하지 않습니다.');
    previous=point.position;
  }
  if(value[0].position!==0||value[value.length-1].position!==1)throw new Error('속도 곡선은 클립의 시작과 끝을 포함해야 합니다.');
}

export function speedCurveMean(points:readonly SpeedPoint[]):number {
  let sum=0;
  for(let i=1;i<points.length;i++)sum+=(points[i].position-points[i-1].position)*(points[i].speed+points[i-1].speed)/2;
  return sum;
}

/** Piecewise-linear rate, quadratic source-time mapping. No frame quantization here. */
export function speedSegments(clip:SpeedClip):SpeedSegment[] {
  const points=clip.speedCurve;
  if(!points)return [{from:0,to:clip.duration,rate:clip.speed,slope:0,sourceStart:0,sourceEnd:clip.duration*clip.speed}];
  let source=0;
  return points.slice(0,-1).map((point,i)=>{
    const next=points[i+1],from=point.position*clip.duration,to=next.position*clip.duration;
    const span=to-from,slope=(next.speed-point.speed)/span,sourceStart=source;
    source+=span*(point.speed+next.speed)/2;
    return {from,to,rate:point.speed,slope,sourceStart,sourceEnd:source};
  });
}

export function clipSpeedAt(clip:SpeedClip,localTime:number):number {
  const points=clip.speedCurve;
  if(!points)return clip.speed;
  const position=localTime/clip.duration;
  if(position<=0)return points[0].speed;
  for(let i=1;i<points.length;i++)if(position<=points[i].position){const a=points[i-1],b=points[i];return a.speed+(b.speed-a.speed)*(position-a.position)/(b.position-a.position);}
  return points[points.length-1].speed;
}

/** Offset from clip.in; values outside the clip extend its nearest endpoint rate. */
export function clipSourceOffset(clip:SpeedClip,localTime:number):number {
  if(!clip.speedCurve)return localTime*clip.speed;
  const segments=speedSegments(clip);
  if(localTime<0)return localTime*segments[0].rate;
  for(const part of segments)if(localTime<=part.to){const t=localTime-part.from;return part.sourceStart+part.rate*t+.5*part.slope*t*t;}
  const last=segments[segments.length-1];
  return last.sourceEnd+(localTime-clip.duration)*clipSpeedAt(clip,clip.duration);
}
export const clipSourceTime=(clip:SpeedClip,localTime:number):number=>clip.in+clipSourceOffset(clip,localTime);
export const clipSourceSpan=(clip:SpeedClip):number=>clipSourceOffset(clip,clip.duration);

/** Inverse of clipSourceTime, including endpoint extrapolation. */
export function clipTimelineTime(clip:SpeedClip,absoluteSourceTime:number):number {
  const offset=absoluteSourceTime-clip.in;
  if(!clip.speedCurve)return offset/clip.speed;
  const segments=speedSegments(clip);
  if(offset<0)return offset/segments[0].rate;
  for(const part of segments)if(offset<=part.sourceEnd){
    const source=Math.max(0,offset-part.sourceStart);
    // This stable quadratic root avoids cancellation for nearly constant rates.
    const local=Math.abs(part.slope)<1e-12?source/part.rate:2*source/(part.rate+Math.sqrt(Math.max(0,part.rate*part.rate+2*part.slope*source)));
    return part.from+local;
  }
  const last=segments[segments.length-1];
  return clip.duration+(offset-last.sourceEnd)/clipSpeedAt(clip,clip.duration);
}

/** Preserve the original curve over an arbitrary normalized trim interval. */
export function trimSpeedCurve(points:readonly SpeedPoint[],fromFraction:number,toFraction:number):SpeedPoint[] {
  if(!Number.isFinite(fromFraction)||!Number.isFinite(toFraction)||toFraction<=fromFraction)throw new Error('속도 곡선의 편집 구간이 유효하지 않습니다.');
  const clip:SpeedClip={duration:1,speed:1,in:0,speedCurve:[...points]},span=toFraction-fromFraction;
  const positions=[fromFraction,...points.filter(p=>p.position>fromFraction&&p.position<toFraction).map(p=>p.position),toFraction];
  const result:SpeedPoint[]=[];
  for(const position of positions){
    const point={position:(position-fromFraction)/span,speed:clipSpeedAt(clip,position)};
    while(result.length>=2){
      const a=result[result.length-2],b=result[result.length-1];
      const expected=a.speed+(point.speed-a.speed)*(b.position-a.position)/(point.position-a.position);
      if(Math.abs(expected-b.speed)>1e-10)break;
      result.pop();
    }
    result.push(point);
  }
  result[0].position=0;result[result.length-1].position=1;
  assertSpeedCurve(result);
  return result;
}
