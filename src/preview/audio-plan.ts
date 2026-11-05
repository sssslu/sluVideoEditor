import type {Project} from '../../shared/types';
import {continuousAudioGroups,type ContinuousAudioGroup} from '../../shared/audio-continuity';
import type {TransitionPlan} from '../../shared/transitions';
import {audioEnabled,type PlannedMedia} from './math';

export interface AudioPlannedMedia extends PlannedMedia {audioOnly?:boolean;suppressAudio?:boolean}
/** Editorial splits share one continuous audio decoder/EQ. Video pictures keep
 * their original independent clip identities and visual effects. */
export class PreviewAudioPlan {
  private members=new Map<string,{group:ContinuousAudioGroup;id:string}>();
  constructor(private project:Project,transitions:TransitionPlan){
    const media=new Map(project.media.map(m=>[m.id,m])),tracks=new Map(project.tracks.map(t=>[t.id,t])),ids=new Set(project.clips.map(c=>c.id));
    const audible=project.clips.filter(c=>c.text===undefined&&c.volume>0&&media.get(c.mediaId||'')?.hasAudio&&audioEnabled(project,tracks.get(c.trackId)!));
    for(const group of continuousAudioGroups(audible,new Set(transitions.transitions.flatMap(t=>[t.from.id,t.to.id])))){
      if(group.members.length===1)continue;
      const track=tracks.get(group.clip.trackId)!,asset=media.get(group.clip.mediaId!)!;let id=group.clip.id;
      if(track.type!=='audio'&&asset.kind!=='audio'){id=`#slu-continuous-audio:${group.clip.id}`;while(ids.has(id))id='#'+id;ids.add(id);}
      const value={group,id};for(const clip of group.members)this.members.set(clip.id,value);
    }
  }
  apply(items:PlannedMedia[],time:number):AudioPlannedMedia[]{
    const result:AudioPlannedMedia[]=[],included=new Set<string>();
    for(const item of items){const value=this.members.get(item.clip.id);if(!value){result.push(item);continue;}
      const {group,id}=value,audioOnly=item.track.type==='audio'||item.media.kind==='audio';
      if(!audioOnly)result.push({...item,suppressAudio:true});
      if(included.has(id))continue;included.add(id);const clip=id===group.clip.id?group.clip:{...group.clip,id},active=time>=clip.start&&time<clip.start+clip.duration;
      result.push({...item,clip,audioOnly:true,active,distance:active?0:clip.start-time,exposure:{clip,visualFrom:0,visualTo:0,audioFrom:0,audioTo:clip.duration,transitions:[]}});
    }
    // Each of the <=32 visual/media candidates contributes at most one audio
    // companion. Audio-only groups replace their members instead of adding nodes.
    return result;
  }
}
