import type {Project,Keyframe,Clip} from '../shared/types';
import type {MotionAnalysis} from '../shared/tracking';
import {MotionPageCache} from '../shared/motion-pages';
import {applyMotion,bindingTime,motionDelta} from '../shared/motion';
import {resolveMotionSources,MotionSourceTimeline} from '../shared/motion-sources';
import {interpolate} from '../shared/project';
import {compileTransitions} from '../shared/transitions';
import {MotionFileReader} from './tracking-file';
import {sameAnalysis} from './tracking-registry';
import {readSourceRevision,requireSourceRevision} from './source-revision';
import {CancelledError} from './media';
import {verifyDigest} from './file-digest';
const scales=new WeakMap<Clip,number>();
const rotates=new WeakSet<Clip>();
export const renderMotionMaximumScale=(clip:Clip)=>scales.get(clip);
export const renderMotionRotates=(clip:Clip)=>rotates.has(clip);

/** Only a bounded output window receives generated motion keys. They never
 * enter the saved project or consume its 1,000 editable-keyframe allowance. */
export class RenderMotion {
  private revisions=new Map<string,string>();private analyses=new Map<string,MotionAnalysis>();private pages:MotionPageCache;
  private maximumScale=new Map<string,number>();
  private sources=new Map<string,MotionSourceTimeline>();
  constructor(private project:Project,private signal?:AbortSignal){
    const clips=new Map(project.clips.map(c=>[c.id,c]));for(const c of project.clips)if(c.motionBinding){const a=project.motionPaths?.find(a=>a.id===c.motionBinding!.analysisId);if(!a)throw new Error('내보낼 추적 경로가 없습니다.');this.analyses.set(a.id,a);this.sources.set(c.id,new MotionSourceTimeline(resolveMotionSources(project,c.motionBinding,clips)));}
    this.pages=new MotionPageCache(async(file,time,limit)=>{
      this.abort();const revision=this.revisions.get(file);if(!revision)throw new Error('추적 출력 경로가 준비되지 않았습니다.');await requireSourceRevision(file,revision);
      const reader=await MotionFileReader.open(file);try{const a=this.analyses.get(reader.metadata.id);if(!a||!sameAnalysis(a,reader.metadata))throw new Error('추적 파일과 프로젝트 정보가 일치하지 않습니다.');const page=await reader.range(time,limit);this.abort();await requireSourceRevision(file,revision);return {metadata:reader.metadata,...page};}finally{await reader.close();}
    });
  }
  private abort(){if(this.signal?.aborted)throw new CancelledError();}
  async prepare(){for(const a of this.analyses.values()){
    this.abort();const source=this.project.media.find(m=>m.id===a.mediaId);if(!source||source.sourceRevision!==a.sourceRevision)throw new Error('추적 원본이 변경되었습니다. 다시 분석하거나 움직임 연결을 해제하세요.');await requireSourceRevision(source.path,a.sourceRevision);
    const revision=await readSourceRevision(a.path),reference=this.project.fileReferences?.find(r=>r.kind==='tracking'&&r.id===a.id);if(reference)await verifyDigest(a.path,reference,this.signal);
    const reader=await MotionFileReader.open(a.path);try{if(!sameAnalysis(a,reader.metadata))throw new Error('추적 파일과 프로젝트 정보가 일치하지 않습니다.');}finally{await reader.close();}await requireSourceRevision(a.path,revision);this.revisions.set(a.path,revision);
  }
    const plan=compileTransitions(this.project),areas=new Map<string,number>();
    for(const c of this.project.clips){const b=c.motionBinding;if(!b||c.text!==undefined)continue;this.abort();const a=this.analyses.get(b.analysisId)!,manual=c.keyframes.length?Math.max(...c.keyframes.map(k=>k.scale)):c.scale;let maximum=manual;
      if(b.followScale){
        // Keep independent global bounds: correlating scale/area per split
        // piece would shrink the scratch canvas merely because of a split.
        const timeline=this.sources.get(c.id)!;let largestArea=0,largestGeometry=0;
        for(const {source:s} of timeline.sources){const crop=s.crop||{left:0,right:0,top:0,bottom:0},sw=Math.max(1,a.sourceWidth*(1-crop.left-crop.right)),sh=Math.max(1,a.sourceHeight*(1-crop.top-crop.bottom)),fit=(s.fit==='cover'?Math.max:Math.min)(this.project.width/sw,this.project.height/sh);largestGeometry=Math.max(largestGeometry,fit*(s.keyframes.length?Math.max(...s.keyframes.map(k=>k.scale)):s.scale));}
        const exposure=plan.byClip.get(c.id)!;for(const range of timeline.ranges(c.start+exposure.visualFrom,c.start+exposure.visualTo)){const s=range.value.source;
        const from=bindingTime(this.project,b,a,range.from,s),to=bindingTime(this.project,b,a,range.to,s),key=a.id+'|'+from+'|'+to;let area=areas.get(key);
        if(area===undefined){
          area=0;const reader=await MotionFileReader.open(a.path);try{let index=await reader.indexAt(from),last=-Infinity,done=false;while(!done){this.abort();const page=await reader.samplesFrom(index,4096);for(const sample of page.samples){if(sample.time<=last)throw new Error('추적 경로 시각이 정렬되어 있지 않습니다.');last=sample.time;if(sample.time>to){done=true;break;}area=Math.max(area,sample.box.width*sample.box.height);}if(page.nextIndex===undefined)break;index=page.nextIndex;}}finally{await reader.close();}areas.set(key,area);
        }
        largestArea=Math.max(largestArea,area);
        }
        maximum=manual*Math.sqrt(largestArea*a.sourceWidth*a.sourceHeight)*largestGeometry/b.reference.size;
      }
      // All windows use one scratch geometry. Varying padding or rotation
      // canvas dimensions changes FFmpeg's pixel center and creates cut jumps.
      this.maximumScale.set(c.id,Math.min(8,maximum));
    }
    await this.verify();
  }
  async window(firstFrame:number,frames:number,fps:number):Promise<Project>{
    if(!this.analyses.size)return this.project;
    if(!Number.isInteger(frames)||frames<1||frames>721)throw new Error('추적 출력 구간은 최대 721프레임입니다.');
    const plan=compileTransitions(this.project),from=firstFrame/fps,to=(firstFrame+frames)/fps,clips=[];
    for(const c of this.project.clips){this.abort();const b=c.motionBinding,exposure=plan.byClip.get(c.id)!;
      if(!b||c.start+exposure.visualFrom>=to||c.start+exposure.visualTo<=from){clips.push(c);continue;}
      const a=this.analyses.get(b.analysisId)!,keyframes:Keyframe[]=[],sources=this.sources.get(c.id)!;
      for(let frame=firstFrame;frame<firstFrame+frames;frame++){
        this.abort();const time=frame/fps,local=time-c.start,source=sources.at(time).source,sample=await this.pages.get(a,bindingTime(this.project,b,a,time,source)),state=applyMotion(interpolate(c,local),motionDelta(this.project,b,a,sample,time,source));
        if(![state.x,state.y,state.scale].every(Number.isFinite)||Math.abs(state.x)>1e6||Math.abs(state.y)>1e6||state.scale<.000001||state.scale>8)throw new Error(`“${c.name}” 추적 결과의 확대·위치가 출력 범위를 벗어납니다. 크기 따라가기를 끄거나 확대를 줄이세요.`);
        // The key boundary lies halfway between output frames. FFmpeg's
        // floating-point time conversion cannot select the previous frame.
        keyframes.push({...state,time:local-.5/fps,easing:'hold',easingStart:undefined,easingEnd:undefined});
      }
      const resolved={...c,keyframes};const maximum=this.maximumScale.get(c.id);if(maximum!==undefined)scales.set(resolved,maximum);if(c.rotation!==0||c.keyframes.some(k=>k.rotation!==0))rotates.add(resolved);clips.push(resolved);
    }
    return {...this.project,clips};
  }
  async verify(){for(const a of this.analyses.values()){this.abort();await requireSourceRevision(a.path,this.revisions.get(a.path));await requireSourceRevision(this.project.media.find(m=>m.id===a.mediaId)!.path,a.sourceRevision);}}
}
