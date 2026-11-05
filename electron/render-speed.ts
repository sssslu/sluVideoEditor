import type {Clip} from '../shared/types';
import {clipSpeedAt,speedSegments} from '../shared/speed';

const numeric=(value:number)=>Number(value.toPrecision(15)).toString();

/** Invert the integral of a piecewise-linear timeline speed exactly. source
 * is an FFmpeg expression measured in seconds relative to clip.in. */
export function speedTimelineExpression(clip:Clip,source:string):string {
  const segments=speedSegments(clip),last=segments.at(-1)!;
  if(!clip.speedCurve)return `((${source})/${numeric(clip.speed)})`;
  const branch=(from:number,to:number):string=>{
    if(from!==to){const middle=Math.floor((from+to)/2);return `if(lte((${source}),${numeric(segments[middle].sourceEnd)}),${branch(from,middle)},${branch(middle+1,to)})`;}
    const segment=segments[from],offset=`max(0,(${source})-${numeric(segment.sourceStart)})`;
    const local=Math.abs(segment.slope)<1e-12?`(${offset})/${numeric(segment.rate)}`:`2*(${offset})/(${numeric(segment.rate)}+sqrt(max(0,${numeric(segment.rate**2)}+${numeric(2*segment.slope)}*(${offset}))))`;
    return `${numeric(segment.from)}+(${local})`;
  };
  const after=`(${numeric(clip.duration)}+((${source})-${numeric(last.sourceEnd)})/${numeric(clipSpeedAt(clip,clip.duration))})`;
  return `if(lt((${source}),0),(${source})/${numeric(segments[0].rate)},if(gt((${source}),${numeric(last.sourceEnd)}),${after},${branch(0,segments.length-1)}))`;
}
