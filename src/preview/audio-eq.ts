import {compileEQ} from '../../shared/audio-eq';
import type {AudioEQ} from '../../shared/types';
interface Chain {nodes:AudioNode[];head:AudioNode;gain:GainNode;level:number}
/** Native audio-thread filters. At most two graphs and one pending edit per clip.
 * Edits warm the replacement for40ms, then crossfade20ms; no growing timer/node list. */
export class PreviewAudioEQ {
  private current:Chain;private outgoing?:Chain;private timer?:ReturnType<typeof setTimeout>;private end=0;private pending?:{eq:AudioEQ|undefined};private value?:AudioEQ;private key:string;private disposed=false;
  constructor(private context:BaseAudioContext,private input:AudioNode,private output:AudioNode,eq?:AudioEQ){this.value=eq;this.key=JSON.stringify(eq)||'';this.current=this.create(eq);}
  private create(eq:AudioEQ|undefined,initial=true){
    const {filters,gain}=compileEQ(eq,this.context.sampleRate),nodes:AudioNode[]=[];
    try{for(const c of filters)nodes.push(this.context.createIIRFilter(c.b,c.a));const volume=this.context.createGain();volume.gain.value=initial?gain:0;nodes.push(volume);
      for(let i=1;i<nodes.length;i++)nodes[i-1].connect(nodes[i]);this.input.connect(nodes[0]);volume.connect(this.output);return {nodes,head:nodes[0],gain:volume,level:gain};
    }catch(error){for(const node of nodes)node.disconnect();throw error;}
  }
  private disconnect(chain:Chain){try{this.input.disconnect(chain.head);}catch{}for(const node of chain.nodes)node.disconnect();}
  set(eq:AudioEQ|undefined){if(this.disposed)return;const key=JSON.stringify(eq)||'';if(key===this.key)return;this.key=key;this.value=eq;
    if(this.context.state!=='running'){this.replace();return;}if(this.outgoing){this.pending={eq};return;}this.transition(eq);
  }
  private transition(eq:AudioEQ|undefined){
    const next=this.create(eq,false),previous=this.current,now=this.context.currentTime,warm=now+.04;this.end=warm+.02;
    next.gain.gain.setValueAtTime(0,warm);next.gain.gain.linearRampToValueAtTime(next.level,this.end);
    previous.gain.gain.setValueAtTime(previous.level,warm);previous.gain.gain.linearRampToValueAtTime(0,this.end);
    this.outgoing=previous;this.current=next;this.timer=setTimeout(()=>this.finish(),70);
  }
  private finish(){if(this.disposed)return;if(this.context.state!=='running'){this.replace();return;}if(this.context.currentTime<this.end){this.timer=setTimeout(()=>this.finish(),30);return;}
    if(this.outgoing)this.disconnect(this.outgoing);this.outgoing=undefined;this.timer=undefined;const pending=this.pending;this.pending=undefined;if(pending)this.transition(pending.eq);
  }
  private replace(){const next=this.create(this.value);clearTimeout(this.timer);this.timer=undefined;this.pending=undefined;this.disconnect(this.current);if(this.outgoing)this.disconnect(this.outgoing);this.outgoing=undefined;this.current=next;}
  reset(){if(!this.disposed)this.replace();}
  dispose(){this.disposed=true;clearTimeout(this.timer);this.timer=undefined;this.pending=undefined;this.disconnect(this.current);if(this.outgoing)this.disconnect(this.outgoing);this.outgoing=undefined;}
}
