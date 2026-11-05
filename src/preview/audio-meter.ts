import {validAudioLevels,type AudioLevelFrame} from '../../shared/audio-levels';

const modulePromises=new WeakMap<BaseAudioContext,Promise<void>>();
/** A parallel, silent tap. Disposing it never disconnects the audible path. */
export class AudioLevelTap {
  private node?:AudioWorkletNode;private stopped=false;private revision=0;private lastSequence=0;
  constructor(private context:AudioContext,private before:AudioNode,private after:AudioNode,private onFrame:(frame:AudioLevelFrame)=>void,private onError:()=>void){void this.connect();}
  private async connect(){
    try{
      let promise=modulePromises.get(this.context);
      if(!promise){promise=this.context.audioWorklet.addModule(new URL('./audio-meter.worklet.js?no-inline',import.meta.url));modulePromises.set(this.context,promise);void promise.catch(()=>modulePromises.delete(this.context));}
      await promise;if(this.stopped||this.context.state==='closed')return;
      const node=new AudioWorkletNode(this.context,'slu-audio-meter',{numberOfInputs:2,numberOfOutputs:1,outputChannelCount:[1],channelCount:2,channelCountMode:'explicit',channelInterpretation:'speakers'});this.node=node;
      node.port.onmessage=({data})=>{
        if(this.stopped)return;
        if(validAudioLevels(data)&&data.revision===this.revision&&data.sequence>this.lastSequence){this.lastSequence=data.sequence;this.onFrame(data);}
        node.port.postMessage({type:'ack',revision:data?.revision,sequence:data?.sequence});
      };
      node.onprocessorerror=()=>{if(!this.stopped){this.dispose();this.onError();}};
      node.port.postMessage({type:'reset',revision:this.revision});
      this.before.connect(node,0,0);this.after.connect(node,0,1);node.connect(this.context.destination);
    }catch{if(!this.stopped){this.dispose();this.onError();}}
  }
  reset(){this.revision++;this.lastSequence=0;this.node?.port.postMessage({type:'reset',revision:this.revision});}
  dispose(){this.stopped=true;const node=this.node;this.node=undefined;if(!node)return;node.port.onmessage=null;node.onprocessorerror=null;node.port.postMessage({type:'stop'});try{this.before.disconnect(node);}catch{}try{this.after.disconnect(node);}catch{}node.disconnect();node.port.close();}
}

export interface AudioMeterSnapshot {frame?:AudioLevelFrame;epoch:number;error?:string}
export class AudioMeterFeed {
  private value:AudioMeterSnapshot={epoch:0};private listeners=new Set<()=>void>();
  getSnapshot=()=>this.value;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  publish(frame?:AudioLevelFrame,error?:string){this.value={frame,error,epoch:this.value.epoch+(frame?0:1)};for(const listener of this.listeners)listener();}
}
