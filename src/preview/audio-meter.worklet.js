// Sample every rendering quantum on the audio thread, including transients that
// would fall between UI polling frames. No sample buffers cross the message port.
// One outstanding message bounds the queue when the UI thread is busy.
class SLUAudioMeter extends AudioWorkletProcessor {
  constructor(){
    super();this.revision=0;this.sequence=0;this.waiting=false;this.frames=0;this.peak=[0,0,0,0];this.squares=[0,0,0,0];this.stopped=false;
    this.port.onmessage=({data})=>{
      if(data?.type==='stop'){this.stopped=true;return;}
      if(data?.type==='reset'&&Number.isSafeInteger(data.revision)){this.revision=data.revision;this.waiting=false;this.frames=0;this.peak.fill(0);this.squares.fill(0);}
      else if(data?.type==='ack'&&data.revision===this.revision&&data.sequence===this.sequence)this.waiting=false;
    };
  }
  process(inputs,outputs){
    if(this.stopped)return false;
    const frames=outputs[0]?.[0]?.length||inputs[0]?.[0]?.length||inputs[1]?.[0]?.length||0;
    // The output is deliberately silent; the audible mixer is never routed
    // through this processor and remains intact if analysis fails.
    for(const channel of outputs[0]||[])channel.fill(0);
    for(let bus=0;bus<2;bus++)for(let channel=0;channel<2;channel++){
      const index=bus*2+channel,data=inputs[bus]?.[channel];if(!data)continue;
      let peak=this.peak[index],sum=this.squares[index];
      for(let i=0;i<Math.min(frames,data.length);i++){const sample=Number.isFinite(data[i])?data[i]:0;peak=Math.max(peak,Math.abs(sample));sum+=sample*sample;}
      this.peak[index]=peak;this.squares[index]=sum;
    }
    this.frames+=frames;
    if(this.frames>=sampleRate/20&&!this.waiting){
      this.port.postMessage({revision:this.revision,sequence:++this.sequence,time:currentTime,frames:this.frames,peak:[...this.peak],rms:this.squares.map(sum=>Math.sqrt(sum/this.frames))});
      this.waiting=true;this.frames=0;this.peak.fill(0);this.squares.fill(0);
    }
    return true;
  }
}
registerProcessor('slu-audio-meter',SLUAudioMeter);
