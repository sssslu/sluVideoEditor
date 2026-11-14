// Test-only PCM measurements at the preview mixer's output, before its limiter.
export async function installAudioProbe(page) {
  await page.evaluate(()=>{
    const runtime=document.querySelector('.preview-gpu-stage').previewRuntime;
    runtime.makeAudio();
    const splitter=runtime.audio.createChannelSplitter(2);
    runtime.master.connect(splitter);
    const channels=[0,1].map(channel=>{
      const analyser=runtime.audio.createAnalyser();
      analyser.fftSize=2048;
      splitter.connect(analyser,channel);
      return {analyser,samples:new Float32Array(analyser.fftSize)};
    });
    window.__audioLevels=()=>channels.map(({analyser,samples})=>{
      analyser.getFloatTimeDomainData(samples);
      let peak=0,squares=0;
      for(const sample of samples){peak=Math.max(peak,Math.abs(sample));squares+=sample*sample;}
      return {peak:20*Math.log10(Math.max(1e-6,peak)),rms:20*Math.log10(Math.max(1e-6,Math.sqrt(squares/samples.length)))};
    });
  });
}
