import type {Clip,Project} from '../../shared/types';
import {interpolate} from '../../shared/project';
import {bindingTime,motionDelta,applyMotion} from '../../shared/motion';
import {MotionPageCache} from '../../shared/motion-pages';
import {visualTrackEnabled} from '../../shared/effects';
import type {MotionAnalysis} from '../../shared/tracking';
import {resolveMotionSources,MotionSourceTimeline} from '../../shared/motion-sources';
export class PreviewMotion {
  private pages:MotionPageCache;private projectId?:string;private failures=new Set<string>();private invalid=new Set<string>();
  private analyses=new Map<string,MotionAnalysis>();private sources=new Map<string,MotionSourceTimeline>();private revisions=new Map<string,string|undefined>();
  constructor(changed:()=>void,private issue:(message:string)=>void){this.pages=new MotionPageCache((path,time,limit)=>window.studio.readTrackingPath(path,time,limit),changed);}
  project(project:Project){if(this.projectId!==project.id){this.projectId=project.id;this.pages.clear();this.failures.clear();}this.invalid.clear();this.analyses=new Map((project.motionPaths||[]).map(a=>[a.id,a]));this.revisions=new Map(project.media.map(m=>[m.id,m.sourceRevision]));const clips=new Map(project.clips.map(c=>[c.id,c]));this.sources=new Map(project.clips.filter(c=>c.motionBinding).map(c=>[c.id,new MotionSourceTimeline(resolveMotionSources(project,c.motionBinding!,clips))]));}
  ready(project:Project,time:number){let ready=true;for(const c of project.clips)if(c.motionBinding&&time>=c.start&&time<c.start+c.duration&&visualTrackEnabled(project,project.tracks.find(t=>t.id===c.trackId))&&!this.resolve(project,c,time)&&!this.invalid.has(c.id))ready=false;return ready;}
  /** Undefined means loading/invalid: never draw a follower at a false position. */
  resolve(project:Project,clip:Clip,time:number):Clip|undefined {
    const b=clip.motionBinding;if(!b)return clip;
    try{
      const a=this.analyses.get(b.analysisId);if(!a)throw new Error('추적 경로가 프로젝트에 없습니다.');
      if(this.revisions.get(a.mediaId)!==a.sourceRevision)throw new Error('추적 원본 연결이 변경되었습니다. 추적 파일을 다시 연결하거나 다시 분석하세요.');
      const timeline=this.sources.get(clip.id)!,source=timeline.at(time).source;
      const sourceTime=bindingTime(project,b,a,time,source),sample=this.pages.peek(a,sourceTime);if(!sample){this.pages.request(a,sourceTime);return;}
      // Prefetch along the source clock, including variable playback rates.
      this.pages.request(a,bindingTime(project,b,a,time+.25,timeline.at(time+.25).source));
      const state=applyMotion(interpolate(clip,time-clip.start),motionDelta(project,b,a,sample,time,source));
      return {...clip,...state,keyframes:[]};
    }catch(error){this.invalid.add(clip.id);const message=(error instanceof Error?error.message:String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');if(!this.failures.has(message)){this.failures.add(message);this.issue(message);}return;}
  }
  dispose(){this.pages.clear();}
}
