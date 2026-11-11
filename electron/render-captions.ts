import type {Clip,Project} from '../shared/types';
import {visualTrackEnabled} from '../shared/effects';
import type {CaptionRasterSession,CaptionRasterGroup} from './caption-raster-types';
import {RawStreamBridge} from './render-stream';

/** `slot`: how many picture layers lie beneath the group; it is drawn right after them. */
export interface CaptionLayerGroup {rich:boolean;clips:Clip[];slot:number}
export function captionLayerGroups(project:Project,start:number,end:number,slotOf:(clip:Clip)=>number=()=>Infinity):CaptionLayerGroup[]{
  const tracks=new Map(project.tracks.map((track,index)=>[track.id,{track,index}]));
  const clips=project.clips.filter(clip=>clip.text!==undefined&&clip.start<end-1e-9&&clip.start+clip.duration>start+1e-9&&visualTrackEnabled(project,tracks.get(clip.trackId)?.track)).sort((a,b)=>tracks.get(a.trackId)!.index-tracks.get(b.trackId)!.index||a.start-b.start);
  const groups:CaptionLayerGroup[]=[];
  for(const clip of clips){const rich=!!(clip.captionStyle||clip.motionBinding),slot=slotOf(clip),last=groups.at(-1);if(last&&last.rich===rich&&last.slot===slot)last.clips.push(clip);else groups.push({rich,clips:[clip],slot});}
  return groups;
}
/** One window owns its loopback inputs. Each producer awaits socket drain
 * before requesting another image from the isolated renderer. */
export class CaptionWindowStreams {
  private streams:Array<{group:CaptionRasterGroup;bridge:RawStreamBridge}>=[];
  private pumps:Promise<void>[]=[];
  private frameBytes=0;
  constructor(private raster:CaptionRasterSession,private fail:(error:Error)=>void,private signal?:AbortSignal){}
  async add(clips:Clip[]){
    const group=await this.raster.prepare(clips);this.frameBytes+=group.width*group.height*4;
    if(this.frameBytes>256*1024*1024){await this.raster.release(group);throw new Error('동시에 겹친 고급·기존 자막의 렌더 버퍼가 256 MB를 초과합니다. 일부 자막 스타일을 통일하거나 해상도를 줄여 주세요.');}
    const bridge=new RawStreamBridge(this.fail);this.streams.push({group,bridge});await bridge.open(this.signal);return {group,url:bridge.consumerUrl};
  }
  start(firstFrame:number,frames:number){
    this.pumps=this.streams.map(({group,bridge})=>(async()=>{
      for(let frame=firstFrame;frame<firstFrame+frames;frame++){
        if(this.signal?.aborted)throw Object.assign(new Error('작업을 취소했습니다.'),{name:'AbortError'});
        const rgba=await this.raster.frame(group,frame);await bridge.write(Buffer.from(rgba.buffer,rgba.byteOffset,rgba.byteLength));
      }
      await bridge.end();
    })().catch(error=>{this.fail(error instanceof Error?error:new Error(String(error)));throw error;}));
    for(const pump of this.pumps)void pump.catch(()=>{});
    return Promise.all(this.pumps);
  }
  async close(){for(const {bridge} of this.streams)bridge.close(Object.assign(new Error('자막 스트림을 닫았습니다.'),{name:'AbortError'}));await Promise.allSettled(this.pumps);for(const {group} of this.streams)await this.raster.release(group).catch(()=>{});this.streams=[];}
}
