import type {Clip,Keyframe} from '../shared/types';
import {interpolate} from '../shared/project';
import {keyframeProgress} from '../shared/effects';

export type KeyframeProperty='x'|'y'|'scale'|'rotation'|'opacity';
export const keyframeProperties:Record<KeyframeProperty,{label:string;unit:string;factor:number;min:number;max:number;span:number;step:number}>={
  x:{label:'위치 X',unit:'px',factor:1,min:-16384,max:16384,span:200,step:1},
  y:{label:'위치 Y',unit:'px',factor:1,min:-16384,max:16384,span:200,step:1},
  scale:{label:'크기',unit:'%',factor:100,min:.01,max:8,span:1,step:.01},
  rotation:{label:'회전',unit:'°',factor:1,min:-3600,max:3600,span:90,step:1},
  opacity:{label:'불투명도',unit:'%',factor:100,min:0,max:1,span:1,step:.01},
};

export function sortedKeyframes(clip:Clip):Keyframe[]{return [...clip.keyframes].sort((a,b)=>a.time-b.time);}

export function keyframeValueRange(clip:Clip,property:KeyframeProperty):[number,number]{
  const config=keyframeProperties[property];
  if(property==='opacity')return [0,1];
  const values=[clip[property],...clip.keyframes.map(key=>key[property])];
  const low=Math.min(...values),high=Math.max(...values),span=Math.max(config.span,(high-low)*1.25);
  return [Math.max(config.min,(low+high-span)/2),Math.min(config.max,(low+high+span)/2)];
}

/** Sample the same easing interval as playback, including cropped curves. */
export function keyframeCurve(clip:Clip,property:KeyframeProperty):{time:number;value:number}[]{
  const keys=sortedKeyframes(clip);
  if(!keys.length)return [{time:0,value:clip[property]},{time:clip.duration,value:clip[property]}];
  const points=[{time:0,value:keys[0][property]}];
  for(let index=0;index<keys.length;index++){
    const left=keys[index],right=keys[index+1];
    points.push({time:left.time,value:left[property]});
    if(!right)continue;
    if(left.easing==='hold'){
      points.push({time:right.time,value:left[property]});
      continue;
    }
    const count=Math.max(2,Math.ceil((right.time-left.time)/clip.duration*96));
    for(let step=1;step<count;step++){
      const fraction=step/count,progress=keyframeProgress(left,fraction);
      points.push({time:left.time+(right.time-left.time)*fraction,value:left[property]+(right[property]-left[property])*progress});
    }
  }
  points.push({time:clip.duration,value:keys.at(-1)![property]});
  return points;
}

/** Move one coupled keyframe without crossing its neighbors or changing other values. */
export function editKeyframe(clip:Clip,index:number,property:KeyframeProperty,values:{time?:number;value?:number},fps:number):Keyframe[]{
  const keys=sortedKeyframes(clip),key=keys[index],config=keyframeProperties[property];
  if(!key||!Number.isFinite(fps)||fps<=0)throw new Error('키프레임을 찾을 수 없습니다.');
  const next={...key};
  if(values.value!==undefined){
    if(!Number.isFinite(values.value))throw new Error('키프레임 값이 올바르지 않습니다.');
    next[property]=Math.max(config.min,Math.min(config.max,values.value));
  }
  if(values.time!==undefined&&values.time!==key.time){
    if(!Number.isFinite(values.time))throw new Error('키프레임 시간이 올바르지 않습니다.');
    const previous=keys[index-1],following=keys[index+1];
    const first=previous?(Math.floor(previous.time*fps+1e-8)+1)/fps:0;
    const last=following?(Math.ceil(following.time*fps-1e-8)-1)/fps:clip.duration;
    // Very close legacy keys can leave no available frame. Keep their time.
    if(first<=last)next.time=Math.max(first,Math.min(last,Math.round(values.time*fps)/fps));
  }
  keys[index]=next;
  return keys;
}

export function toggleKeyframe(clip:Clip,time:number,fps:number):Keyframe[]{
  const keys=sortedKeyframes(clip),local=Math.max(0,Math.min(clip.duration,Math.round(time*fps)/fps));
  const index=keys.findIndex(key=>Math.abs(key.time-local)<.5/fps);
  if(index>=0)return keys.filter((_,at)=>at!==index);
  if(keys.length>=1000)throw new Error('클립당 최대 1,000개 키프레임을 지원합니다.');
  const {easingStart,easingEnd,...value}=interpolate(clip,local);
  return [...keys,{...value,time:local,easing:'linear' as const}].sort((a,b)=>a.time-b.time);
}
