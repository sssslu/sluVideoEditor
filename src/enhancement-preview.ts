import type {JobEvent,StudioAPI} from '../shared/types';

type JobAPI=Pick<StudioAPI,'onJob'|'cancelJob'|'discardEnhancementPreview'>;

/** Subscribe before IPC. A closed dialog still owns a pending request and its
 * late result until the job reaches a terminal state. */
export function ownEnhancementJob(api:JobAPI,start:()=>Promise<{jobId:string}>,preview:boolean,onEvent:(event:JobEvent)=>void,onError:(error:unknown)=>void){
  let id:string|undefined,disposed=false,terminal=false,cancelled=false,resultId:string|undefined;
  const pending=new Map<string,JobEvent>(),discarded=new Set<string>();
  const discard=(mediaId:string)=>{
    if(discarded.has(mediaId))return;
    discarded.add(mediaId);
    void api.discardEnhancementPreview(mediaId).catch(onError);
  };
  const accept=(event:JobEvent)=>{
    if(event.id!==id||terminal)return;
    terminal=event.status!=='running';
    if(preview&&event.media)resultId=event.media.id;
    if(!disposed)onEvent(event);
    if(disposed&&resultId)discard(resultId);
    if(terminal)unsubscribe();
  };
  const unsubscribe=api.onJob(event=>{
    if(preview?(event.type!=='enhance'||event.preview!==true):event.type!=='enhancement-install')return;
    if(id)accept(event);
    else pending.set(event.id,event);
  });
  const cancel=()=>{
    if(!id||terminal||cancelled)return;
    cancelled=true;
    void api.cancelJob(id).catch(onError);
  };
  const started=Promise.resolve().then(start).then(result=>{
    id=result.jobId;
    const early=pending.get(id);pending.clear();
    if(early)accept(early);
    if(disposed)cancel();
  },error=>{
    terminal=true;pending.clear();unsubscribe();
    if(!disposed)onError(error);
  });
  return {
    started,
    dispose(){
      disposed=true;
      if(resultId)discard(resultId);
      cancel();
    },
  };
}
