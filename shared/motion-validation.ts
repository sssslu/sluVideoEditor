import type {Project} from './types';
import {assertMotionAnalysis,type MotionSource} from './tracking';
import {assertSpeedCurve} from './speed';
import {motionLinks,MAX_MOTION_SOURCES,MAX_PROJECT_MOTION_SOURCES} from './motion-sources';

const finite=(v:unknown,a:number,b:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=a&&v<=b;
const object=(v:unknown)=>!!v&&typeof v==='object'&&!Array.isArray(v);
function assertSource(s:MotionSource){
  if(!object(s)||!finite(s.start,-86400,172800)||!finite(s.duration,.01,86400)||!finite(s.in,0,864000)||!finite(s.speed,.1,16)||!finite(s.x,-16384,16384)||!finite(s.y,-16384,16384)||!finite(s.scale,.01,8)||!finite(s.rotation,-3600,3600)||!['contain','cover'].includes(s.fit)||typeof s.flipH!=='boolean'||typeof s.flipV!=='boolean'||!Array.isArray(s.keyframes)||s.keyframes.length>1000)throw new Error('추적 원본의 변형 정보가 올바르지 않습니다.');
  if(s.speedCurve!==undefined)assertSpeedCurve(s.speedCurve);
  const crop=s.crop;if(crop!==undefined&&(!object(crop)||![crop.left,crop.right,crop.top,crop.bottom].every(v=>finite(v,0,.98))||crop.left+crop.right>.98||crop.top+crop.bottom>.98))throw new Error('추적 원본의 자르기 영역이 올바르지 않습니다.');
  const times=new Set<number>();for(const k of s.keyframes){if(!object(k)||!finite(k.time,0,s.duration+.001)||times.has(k.time)||!finite(k.x,-16384,16384)||!finite(k.y,-16384,16384)||!finite(k.scale,.01,8)||!finite(k.rotation,-3600,3600)||!finite(k.opacity,0,1)||(k.easing!==undefined&&!['linear','ease-in','ease-out','ease-in-out','hold'].includes(k.easing))||(k.easingStart!==undefined&&!finite(k.easingStart,0,1))||(k.easingEnd!==undefined&&!finite(k.easingEnd,0,1))||(k.easingStart!==undefined&&k.easingEnd!==undefined&&k.easingStart>k.easingEnd))throw new Error('추적 원본의 키프레임이 올바르지 않습니다.');times.add(k.time);}
}
export function assertProjectMotion(p:Project){
  const paths=p.motionPaths;if(paths!==undefined&&(!Array.isArray(paths)||paths.length>1000||p.version<8))throw new Error('추적 경로는 프로젝트 형식 8과 최대 1,000개 항목을 지원합니다.');
  const assets=new Map(p.media.map(m=>[m.id,m])),clips=new Map(p.clips.map(c=>[c.id,c])),analyses=new Map<string,NonNullable<Project['motionPaths']>[number]>();
  for(const a of paths||[]){assertMotionAnalysis(a);if(analyses.has(a.id)||assets.get(a.mediaId)?.kind!=='video')throw new Error('추적 경로의 ID 또는 원본 영상 연결이 올바르지 않습니다.');analyses.set(a.id,a);}
  let total=0;for(const c of p.clips){const b=c.motionBinding;if(b===undefined)continue;const a=analyses.get(b?.analysisId);
    if(p.version<8||!object(b)||!a||!object(b.source)||b.source.mediaId!==a.mediaId||!object(b.reference)||!finite(b.reference.x,-1e9,1e9)||!finite(b.reference.y,-1e9,1e9)||!finite(b.reference.size,1e-8,1e9)||!finite(b.reference.width,1,32768)||!finite(b.reference.height,1,32768)||!['contain','cover'].includes(b.reference.fit)||typeof b.followScale!=='boolean'||(c.text===undefined&&assets.get(c.mediaId||'')?.kind!=='image'))throw new Error('자막·이미지의 추적 연결이 올바르지 않습니다.');
    if(b.segments!==undefined&&(!Array.isArray(b.segments)||b.segments.length>=MAX_MOTION_SOURCES))throw new Error('추적 원본 조각은 연결당 최대 10,000개입니다.');
    const links=motionLinks(b);total+=links.length;if(total>MAX_PROJECT_MOTION_SOURCES)throw new Error('프로젝트의 추적 원본 참조는 최대 50,000개입니다.');const linked=new Set<string>();
    for(const link of links){if(!object(link)||!object(link.source)||link.source.mediaId!==a.mediaId)throw new Error('추적 원본 조각 정보가 올바르지 않습니다.');assertSource(link.source);
      if(link.sourceClipId!==undefined){const s=clips.get(link.sourceClipId);if(linked.has(link.sourceClipId)||!s||s.id===c.id||s.motionBinding||s.mediaId!==a.mediaId||s.text!==undefined)throw new Error('추적 원본 클립 연결이 올바르지 않습니다.');linked.add(link.sourceClipId);}
    }
  }
}
