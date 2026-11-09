import type {Clip,Keyframe,MediaAsset,Project,Track} from '../../shared/types';
import {PreviewMotion} from './motion';
import {projectDuration,interpolate} from '../../shared/project';
import {clipSpeedAt,clipTimelineTime} from '../../shared/speed';
import {compileTransitions,transitionGain,visualNodesAt,type ClipExposure,type TransitionPlan} from '../../shared/transitions';
import {audioEnabled,clamp,clipState,fadeAt,planMedia,sourceTime,visualEnabled,type PreviewClip} from './math';
import {GLCompositor,hitTest,type Compositor,type Geometry,type HitRegion,type VisualFrame,type VisualRenderNode,type VideoFrameSource} from './renderer';
import {HANDLE_RADIUS,ROTATE_RADIUS,pickHandle,regionCorners,rotateHandle,type Box,type Guide,type Handle,type Point} from './transform-handles';
import {CPUCompositor} from './fallback';
import {ensureCaptionFonts,captionFontsReady} from './text';
import {captionGlyphError} from '../captions/glyphs';
import {ScopeSampler} from './scopes';
import type {ScopeResult} from '../../shared/scopes';
import type {AudioLevelFrame} from '../../shared/audio-levels';
import {AudioLevelTap} from './audio-meter';
import {PreviewAudioEQ} from './audio-eq';
import {PreviewAudioPlan} from './audio-plan';
import {toPreviewTime,fromPreviewTime,previewClockOffset,needsPreviewProxy,previewSourceKey,previewMediaPath,usesPreviewProxy} from '../../shared/media-clock';

export interface PreviewStats {mode:'WebGL2'|'CPU';fps:number;renderMs:number;p95Ms:number;renderedFrames:number;missedFrames:number;droppedVideoFrames:number;totalVideoFrames:number;decoders:number;width:number;height:number;time:number;playing:boolean;seeking:boolean;waitingProxySources:string[];audioContext:string;maxGain:number;maxSourceLagSeconds:number}
export interface RuntimeCallbacks {onTime:(time:number)=>void;onEnded:()=>void;onStats:(stats:PreviewStats)=>void;onIssue:(media:MediaAsset|undefined,message:string)=>void;onMediaReady?:(media:MediaAsset)=>void;onScopes?:(result:ScopeResult|undefined)=>void;onScopeError?:(message:string)=>void;onAudioLevels?:(frame:AudioLevelFrame|undefined)=>void;onAudioMeterError?:(message:string)=>void}
/** Overlay size in CSS pixels, the frame's offset inside it, and CSS pixels per project pixel. */
export interface PreviewViewport {width:number;height:number;left:number;top:number;scale:number}
export interface PreviewTarget {clip:Clip;state:Keyframe;geometry:Geometry;dragScale:number;locked:boolean;handle?:Handle}
interface Decoder {waitingForProxy:boolean;audioOnly?:boolean;suppressAudio?:boolean;clip:PreviewClip;exposure:ClipExposure;media:MediaAsset;track:Track;url:string;element:HTMLMediaElement|HTMLImageElement;key:string;loaded:boolean;failed:boolean;destroyed:boolean;version:number;frameCallback?:number;lastCallback:number;lastImageTime:number;presentedTime?:number;lagSince?:number;desired:number;pendingSeek?:number;active:boolean;playing:boolean;lastCorrection:number;gain?:GainNode;eq?:PreviewAudioEQ;audioSource?:MediaElementAudioSourceNode;lastGain:number;playPending:boolean}

export class PreviewRuntime {
  renderer:Compositor;private mediaHost:HTMLDivElement;private overlay:HTMLCanvasElement;
  private motion=new PreviewMotion(()=>{this.force=true;this.wake();},message=>this.callbacks.onIssue(undefined,message));
  private project?:Project;private transitions?:TransitionPlan;private audioPlan?:PreviewAudioPlan;private nodes=new Map<string,Decoder>();private generation=0;private duration=0;
  private frame=0;private running=false;private waitingToStart=false;private anchorTime=0;private anchorClock=0;private seekId=-1;
  private proxy=true;private quality=720;private muted=false;private selected=new Set<string>();private destroyed=false;
  private dirty=true;private force=true;private lastPlan=-Infinity;private nextBoundary=Infinity;private lastRenderFrame=-1;private lastReported=-Infinity;
  private audio?:AudioContext;private master?:GainNode;private limiter?:DynamicsCompressorNode;private monitorGain?:GainNode;
  private audioMeter?:AudioLevelTap;private meterEnabled=false;private audioStarting=false;
  private draws=0;private missed=0;private totalDropped=0;private totalDecoded=0;private renderTimes:number[]=[];private lastStats=0;private statDraws=0;
  private lastStatsValue?:PreviewStats;private overflowReported=false;private warnedMedia=new Set<string>();
  private captionFontState:'unused'|'loading'|'ready'|'error'='unused';
  private captionIssues=new Set<string>();
  private scopes?:ScopeSampler;
  private viewport?:PreviewViewport&{ratio:number};private guides:Guide[]=[];
  /** `overlay` may sit outside the frame so selection handles stay visible past its edges; see setViewport. */
  constructor(private host:HTMLDivElement,private callbacks:RuntimeCallbacks,overlay?:HTMLCanvasElement){
    const canvas=this.createCanvas();
    try{this.renderer=new GLCompositor(canvas);}catch{canvas.remove();this.renderer=new CPUCompositor(this.createCanvas());queueMicrotask(()=>callbacks.onIssue(undefined,'WebGL2를 사용할 수 없어 360p CPU 미리보기를 사용합니다.'));}
    this.mediaHost=document.createElement('div');this.mediaHost.className='gpu-media-decoders';this.mediaHost.setAttribute('aria-hidden','true');host.append(this.mediaHost);
    if(overlay)this.overlay=overlay;else{this.overlay=document.createElement('canvas');this.overlay.className='gpu-preview-selection';this.overlay.setAttribute('aria-hidden','true');host.append(this.overlay);}
    this.renderer.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.fallback();});
  }
  private createCanvas(){const canvas=document.createElement('canvas');canvas.className='gpu-preview-output';canvas.setAttribute('aria-label','프로그램 영상');this.host.prepend(canvas);return canvas;}
  private fallback(){if(this.renderer.mode==='CPU'||this.destroyed)return;const old=this.renderer.canvas;this.renderer.dispose();old.remove();this.renderer=new CPUCompositor(this.createCanvas());if(this.project)this.renderer.resize(this.project,this.quality);this.force=true;this.wake();this.callbacks.onIssue(undefined,'GPU 미리보기가 중단되어 360p CPU 합성으로 전환했습니다.');}
  setCallbacks(callbacks:RuntimeCallbacks){this.callbacks=callbacks;}
  setAudioMeter(enabled:boolean){this.meterEnabled=enabled;if(enabled)this.connectAudioMeter();else{this.audioMeter?.dispose();this.audioMeter=undefined;this.callbacks.onAudioLevels?.(undefined);}}
  resetAudioMeter(){this.audioMeter?.reset();this.callbacks.onAudioLevels?.(undefined);}
  private connectAudioMeter(){if(!this.meterEnabled||this.audioMeter||!this.audio||!this.master||!this.limiter||this.destroyed)return;this.audioMeter=new AudioLevelTap(this.audio,this.master,this.limiter,frame=>this.callbacks.onAudioLevels?.(frame),()=>{this.callbacks.onAudioMeterError?.('오디오 레벨을 표시할 수 없습니다. 소리 재생은 유지됩니다.');});}
  setScopes(enabled:boolean){if(enabled&&!this.scopes){try{this.scopes=new ScopeSampler(result=>this.callbacks.onScopes?.(result),message=>this.callbacks.onScopeError?.(message),()=>{this.force=true;this.wake();});}catch{this.callbacks.onScopeError?.('스코프 분석을 시작하지 못했습니다.');}}else if(!enabled){this.scopes?.dispose();this.scopes=undefined;this.callbacks.onScopes?.(undefined);}this.force=true;this.wake();}
  setProject(project:Project){if(this.project===project)return;const previous=this.project;this.scopes?.invalidate();if(previous?.id!==project.id)this.callbacks.onScopes?.(undefined);this.project=project;this.motion.project(project);this.prepareCaptionFonts(project);this.transitions=compileTransitions(project);this.audioPlan=new PreviewAudioPlan(project,this.transitions);this.duration=projectDuration(project);this.renderer.resize(project,this.quality);this.sizeOverlay();if(previous?.id!==project.id){this.resetAudioMeter();for(const node of this.nodes.values())this.destroyNode(node);this.nodes.clear();this.anchorTime=0;this.anchorClock=performance.now();this.seekId=-1;this.draws=0;this.missed=0;this.lastStats=0;this.statDraws=0;this.lastStatsValue=undefined;this.renderTimes=[];this.overflowReported=false;this.warnedMedia.clear();}this.anchorTime=clamp(this.time(),0,this.duration);this.anchorClock=performance.now();this.updatePlan(this.evaluationTime());if(previous?.id!==project.id){this.totalDropped=0;this.totalDecoded=0;}this.force=true;this.wake();}
  private prepareCaptionFonts(project:Project){if(!project.clips.some(c=>c.captionStyle))return;if(captionFontsReady()){this.captionFontState='ready';return;}if(this.captionFontState!=='unused')return;this.captionFontState='loading';void ensureCaptionFonts().then(()=>{if(this.destroyed)return;this.captionFontState='ready';this.force=true;this.wake();},error=>{if(this.destroyed)return;this.captionFontState='error';this.callbacks.onIssue(undefined,error instanceof Error?error.message:String(error));this.force=true;this.wake();});}
  setOptions(proxy:boolean,quality:number,muted:boolean,selected:string[]){const changed=this.proxy!==proxy;this.proxy=proxy;this.muted=muted;this.selected=new Set(selected);if(this.monitorGain&&this.audio)this.monitorGain.gain.setTargetAtTime(muted?0:1,this.audio.currentTime,.008);if(this.quality!==quality){this.quality=quality;if(this.project){this.renderer.resize(this.project,quality);this.sizeOverlay();}}if(changed)this.updatePlan(this.evaluationTime(),true);this.force=true;this.wake();}
  setTransport(time:number,playing:boolean,seekId:number){const explicit=seekId!==this.seekId;this.seekId=seekId;if(explicit||(!playing&&!this.running&&Math.abs(time-this.anchorTime)>.00001))this.seek(time);
    if(this.running&&!playing){this.anchorTime=explicit?time:this.time();this.anchorClock=performance.now();this.running=false;this.waitingToStart=false;for(const node of this.nodes.values()){this.pauseNode(node);this.position(node,sourceTime(node.clip,this.evaluationTime(),node.media,node.exposure),true);}this.callbacks.onTime(this.anchorTime);this.force=true;}
    else if(!this.running&&playing){this.anchorClock=performance.now();this.running=true;this.waitingToStart=true;void this.resumeAudio();this.updatePlan(this.evaluationTime(),true);this.force=true;}
    this.wake();
  }
  time(){
    if(!this.running||this.waitingToStart)return this.anchorTime;
    // MediaElement timestamps follow the audio device clock. A wall-clock
    // start can lead that clock by hundreds of milliseconds on first playback,
    // causing a corrective seek that truncates the beginning of the sound.
    if(this.project)for(const node of this.nodes.values()){
      const element=node.element;if(!node.active||node.failed||node.suppressAudio||!node.media.hasAudio||node.clip.volume<=0||!audioEnabled(this.project,node.track)||!(element instanceof HTMLMediaElement)||element.paused||element.ended||element.seeking||!node.playing)continue;
      const local=clipTimelineTime(node.clip,fromPreviewTime(node.media,element.currentTime,this.proxy));
      if(local>=node.exposure.audioFrom-.002&&local<node.exposure.audioTo)return Math.max(this.anchorTime,node.clip.start+local);
    }
    return this.anchorTime+(performance.now()-this.anchorClock)/1000;
  }
  private evaluationTime(){return clamp(this.time(),0,Math.max(0,this.duration-.000001));}
  private seek(time:number){this.scopes?.invalidate();if(this.running){this.waitingToStart=true;for(const node of this.nodes.values())this.pauseNode(node);}this.anchorTime=clamp(time,0,this.project?this.duration:86400);this.anchorClock=performance.now();this.lastRenderFrame=-1;this.updatePlan(this.evaluationTime(),true);for(const node of this.nodes.values())this.position(node,sourceTime(node.clip,this.evaluationTime(),node.media,node.exposure),true);this.force=true;this.dirty=true;this.wake();}
  private makeAudio(){if(this.audio)return;try{this.audio=new AudioContext({latencyHint:'interactive'});this.master=this.audio.createGain();this.monitorGain=this.audio.createGain();this.monitorGain.gain.value=this.muted?0:1;this.limiter=this.audio.createDynamicsCompressor();this.limiter.threshold.value=-.3;this.limiter.knee.value=0;this.limiter.ratio.value=20;this.limiter.attack.value=.003;this.limiter.release.value=.07;this.master.connect(this.limiter);this.limiter.connect(this.monitorGain);this.monitorGain.connect(this.audio.destination);this.connectAudioMeter();}catch{this.callbacks.onIssue(undefined,'오디오 믹서를 시작하지 못했습니다. 미리보기 소리를 확인하세요.');}}
  async resumeAudio(){this.makeAudio();if(this.audio?.state==='suspended'){this.audioStarting=true;try{await this.audio.resume();}catch{}finally{this.audioStarting=false;this.wake();}}}
  private attachAudio(node:Decoder){if(node.media.kind==='image'||!node.media.hasAudio||node.eq||node.suppressAudio)return;this.makeAudio();if(!this.audio||!this.master)return;try{const element=node.element as HTMLMediaElement;node.audioSource??=this.audio.createMediaElementSource(element);if(!node.gain){node.gain=this.audio.createGain();node.gain.gain.value=0;node.gain.connect(this.master);}node.eq=new PreviewAudioEQ(this.audio,node.audioSource,node.gain,node.clip.audioEQ);element.muted=false;element.volume=1;}catch{node.failed=true;this.callbacks.onIssue(node.media,'오디오 믹서를 연결하지 못했습니다.');}}
  private createNode(clip:PreviewClip,media:MediaAsset,track:Track,url:string,exposure:ClipExposure,audioOnly=false,suppressAudio=false):Decoder{
    const element=media.kind==='image'?new Image():document.createElement(audioOnly||media.kind==='audio'||track.type==='audio'?'audio':'video');
    const node:Decoder={waitingForProxy:needsPreviewProxy(media),clip,media,track,url,element,exposure,audioOnly,suppressAudio,key:`${clip.id}:${++this.generation}`,loaded:false,failed:false,destroyed:false,version:0,lastCallback:0,lastImageTime:-1,desired:clip.in,active:false,playing:false,lastCorrection:0,lastGain:-1,playPending:false};
    element.crossOrigin='anonymous';
    // A missing required proxy is a preparation state, not a decoder failure.
    // Keep an unloaded node so transport readiness also waits for its audio.
    if(node.waitingForProxy)return node;
    const invalidate=()=>{if(node.destroyed)return;node.version++;this.dirty=true;this.wake();};
    const failure=()=>{if(node.destroyed||node.failed)return;node.failed=true;this.callbacks.onIssue(media,`${media.name}: 미리보기에서 읽을 수 없습니다.${media.kind==='video'?' 프록시를 생성해 주세요.':''}`);this.force=true;this.wake();};
    element.addEventListener('error',failure);
    const ready=()=>{if(node.destroyed||node.failed)return;this.callbacks.onMediaReady?.(node.media);invalidate();};
    if(element instanceof HTMLImageElement){element.onload=()=>{node.loaded=true;ready();};element.src=url;}
    else{
      element.preload='auto';element.controls=false;element.muted=true;element.preservesPitch=true;if(element instanceof HTMLVideoElement)element.playsInline=true;
      element.addEventListener('loadedmetadata',()=>{node.loaded=true;this.position(node,node.desired,true);this.attachAudio(node);invalidate();});
      element.addEventListener('loadeddata',ready);element.addEventListener('canplay',()=>{this.wake();});
      element.addEventListener('seeked',()=>{invalidate();const target=node.pendingSeek;node.pendingSeek=undefined;if(target!==undefined&&Math.abs(fromPreviewTime(node.media,element.currentTime,this.proxy)-target)>.002){
        // Positive-origin MP4 duration can initially describe a span, then grow
        // to its absolute end after decoding. Chromium clamps the first seek
        // against that temporary duration. Retain the requested edit position
        // and retry once it becomes seekable; never spin at a clamped endpoint.
        if(toPreviewTime(node.media,target,this.proxy)<=element.duration)this.position(node,target,true);else node.pendingSeek=target;
      }});
      element.addEventListener('durationchange',()=>{if(node.destroyed)return;const target=node.pendingSeek;if(target!==undefined&&toPreviewTime(node.media,target,this.proxy)<=element.duration)this.position(node,target,true);invalidate();});
      if(element instanceof HTMLVideoElement&&'requestVideoFrameCallback'in element){const arrived=(_now:number,metadata:VideoFrameCallbackMetadata)=>{if(node.destroyed)return;node.presentedTime=metadata.mediaTime;node.lastCallback=performance.now();invalidate();node.frameCallback=element.requestVideoFrameCallback(arrived);};node.frameCallback=element.requestVideoFrameCallback(arrived);}
      this.mediaHost.append(element);element.src=url;element.load();
    }
    return node;
  }
  private position(node:Decoder,target:number,force=false,tolerance=.18){node.desired=target;if(node.element instanceof HTMLImageElement||!node.loaded||node.failed)return;const element=node.element;if(element.seeking&&!force){node.pendingSeek=target;return;}node.pendingSeek=undefined;const decodedTime=toPreviewTime(node.media,target,this.proxy);if(Math.abs(element.currentTime-decodedTime)>(force?.002:tolerance)){try{node.eq?.reset();node.pendingSeek=target;element.currentTime=decodedTime;node.version++;}catch{node.pendingSeek=undefined;/* Metadata may still be changing for a newly loaded stream. */}}}
  private pauseNode(node:Decoder){if(node.element instanceof HTMLMediaElement){node.element.pause();node.playing=false;}if(node.gain&&this.audio){node.gain.gain.cancelScheduledValues(this.audio.currentTime);node.gain.gain.setValueAtTime(0,this.audio.currentTime);node.lastGain=0;}}
  private destroyNode(node:Decoder){node.destroyed=true;this.pauseNode(node);if(node.element instanceof HTMLVideoElement){const quality=node.element.getVideoPlaybackQuality();this.totalDropped+=quality.droppedVideoFrames;this.totalDecoded+=quality.totalVideoFrames;if(node.frameCallback!==undefined)node.element.cancelVideoFrameCallback(node.frameCallback);}node.eq?.dispose();node.audioSource?.disconnect();node.gain?.disconnect();if(node.element instanceof HTMLMediaElement){node.element.removeAttribute('src');node.element.load();}else node.element.src='';node.element.remove();}
  private updatePlan(time:number,force=false){const project=this.project;if(!project)return;this.lastPlan=time;const originalPlan=planMedia(project,time,32,1.2,this.transitions),plan={...originalPlan,media:this.audioPlan!.apply(originalPlan.media,time)};if(plan.overflow&&!this.overflowReported){this.overflowReported=true;this.callbacks.onIssue(undefined,'미리보기는 동시에 활성화된 미디어 32개까지 지원합니다. 트랙을 숨기거나 분할해 주세요.');}const desired=new Set(plan.media.map(item=>item.clip.id));for(const[id,node]of this.nodes)if(!desired.has(id)){this.destroyNode(node);this.nodes.delete(id);}
    for(const item of plan.media){const base=window.studio.mediaUrl(previewMediaPath(item.media,this.proxy)),url=item.media.sourceRevision?`${base}${base.includes('?')?'&':'?'}revision=${encodeURIComponent(item.media.sourceRevision)}`:base;let node=this.nodes.get(item.clip.id);if(node&&(node.waitingForProxy!==needsPreviewProxy(item.media)||node.url!==url||node.media.sourceRevision!==item.media.sourceRevision||(node.track.type==='audio')!==(item.track.type==='audio')||!!node.audioOnly!==!!item.audioOnly)){this.destroyNode(node);this.nodes.delete(item.clip.id);node=undefined;}let timingChanged=!node;if(!node){node=this.createNode(item.clip,item.media,item.track,url,item.exposure,item.audioOnly,item.suppressAudio);this.nodes.set(item.clip.id,node);}else timingChanged=previewClockOffset(node.media,this.proxy)!==previewClockOffset(item.media,this.proxy)||node.clip.in!==item.clip.in||node.clip.start!==item.clip.start||node.clip.speed!==item.clip.speed||node.clip.duration!==item.clip.duration||(node.clip.speedCurve!==item.clip.speedCurve&&JSON.stringify(node.clip.speedCurve)!==JSON.stringify(item.clip.speedCurve));node.clip=item.clip;if(!item.suppressAudio)node.eq?.set(item.clip.audioEQ);node.media=item.media;node.track=item.track;node.exposure=item.exposure;node.audioOnly=item.audioOnly;node.suppressAudio=item.suppressAudio;if(node.suppressAudio){node.eq?.dispose();node.eq=undefined;}else if(node.loaded)this.attachAudio(node);if(force||timingChanged)this.position(node,sourceTime(item.clip,time,item.media,item.exposure),true);}
    this.nextBoundary=Infinity;for(const {clip,visualFrom,visualTo,audioFrom,audioTo}of this.transitions!.byClip.values())for(const bound of [visualFrom,visualTo,audioFrom,audioTo]){const at=clip.start+bound;if(at>time)this.nextBoundary=Math.min(this.nextBoundary,at);}for(const transition of this.transitions!.transitions)for(const at of [transition.start,transition.end])if(at>time)this.nextBoundary=Math.min(this.nextBoundary,at);
    this.renderer.release(new Set([...this.nodes.values()].map(node=>node.key).concat(project.clips.filter(c=>c.text!==undefined&&c.start<=time+1.2&&c.start+c.duration>time).map(c=>`text:${c.id}`))));
  }
  private syncNodes(time:number,now:number){if(!this.project)return;
    if(this.running&&!this.waitingToStart&&[...this.nodes.values()].some(node=>{
      if(!node.waitingForProxy)return false;
      const local=time-node.clip.start;
      return (!node.audioOnly&&visualEnabled(this.project!,node.track)&&local>=node.exposure.visualFrom&&local<node.exposure.visualTo)||(!node.suppressAudio&&node.media.hasAudio&&audioEnabled(this.project!,node.track)&&local>=node.exposure.audioFrom&&local<node.exposure.audioTo);
    })){
      this.anchorTime=time;this.anchorClock=now;this.waitingToStart=true;
      for(const node of this.nodes.values())this.pauseNode(node);
    }
    const mayStart=this.running&&(!this.waitingToStart||this.buffersReady());for(const node of this.nodes.values()){
    const local=time-node.clip.start,visual=!node.audioOnly&&visualEnabled(this.project,node.track)&&local>=node.exposure.visualFrom&&local<node.exposure.visualTo,audible=!node.suppressAudio&&audioEnabled(this.project,node.track)&&local>=node.exposure.audioFrom&&local<node.exposure.audioTo;const active=visual||(node.media.hasAudio&&audible);
    if(node.element instanceof HTMLMediaElement){const element=node.element,rate=clipSpeedAt(node.clip,time-node.clip.start);if(Math.abs(element.playbackRate-rate)>.0001)element.playbackRate=rate;
      if(active&&!node.active)this.position(node,sourceTime(node.clip,time,node.media,node.exposure),true);
      if(mayStart&&active&&node.loaded&&!node.failed){if(!this.waitingToStart&&now-node.lastCorrection>(node.clip.speedCurve?200:500)){if(!element.seeking)this.position(node,sourceTime(node.clip,time,node.media,node.exposure),false,node.clip.speedCurve?Math.max(.03,rate/this.project.fps*1.5):.18);node.lastCorrection=now;}if(element.paused&&!node.playPending){node.playPending=true;void element.play().then(()=>{node.playPending=false;node.playing=!element.paused;this.wake();},error=>{node.playPending=false;if(error?.name==='NotSupportedError'&&!node.failed){node.failed=true;this.callbacks.onIssue(node.media,`${node.media.name}: 프록시를 생성해 주세요.`);}});}}
      else if(!element.paused)this.pauseNode(node);
      const gain=this.running&&!this.waitingToStart&&audible?node.clip.volume*fadeAt(node.clip,local)*transitionGain(this.transitions!,node.clip.id,time):0;
      if(node.gain&&this.audio&&Math.abs(node.lastGain-gain)>.0005){node.gain.gain.setTargetAtTime(gain,this.audio.currentTime,.004);node.lastGain=gain;}
      if(element instanceof HTMLVideoElement&&now-node.lastCallback>250&&Math.abs(node.lastImageTime-element.currentTime)>.001){node.lastImageTime=element.currentTime;node.version++;this.dirty=true;}
      if(element instanceof HTMLVideoElement){
        const measuring=this.running&&!this.waitingToStart&&active&&!node.failed&&visualEnabled(this.project,node.track);
        const lag=measuring?Math.max(0,sourceTime(node.clip,time,node.media,node.exposure)-fromPreviewTime(node.media,node.presentedTime??element.currentTime,this.proxy)):0;
        if(lag>.5&&!(usesPreviewProxy(node.media,this.proxy))){node.lagSince??=now;if(now-node.lagSince>=1500&&!this.warnedMedia.has(node.media.id)){this.warnedMedia.add(node.media.id);this.callbacks.onIssue(node.media,`${node.media.name}: 영상 디코딩 지연 · 프록시를 생성해 주세요.`);}}else node.lagSince=undefined;
      }
    }node.active=active;
  }}
  private frameFor(node:Decoder):VideoFrameSource|undefined{if(!node.loaded||node.failed)return;const element=node.element;if(element instanceof HTMLImageElement){if(!element.complete||!element.naturalWidth)return;return {key:node.key,source:element,width:element.naturalWidth,height:element.naturalHeight,version:node.version};}if(element instanceof HTMLVideoElement&&element.readyState>=2&&element.videoWidth)return {key:node.key,source:element,width:element.videoWidth,height:element.videoHeight,version:node.version};}
  private buffersReady(){if(this.audioStarting||this.captionFontState==='loading')return false;if(!this.project)return false;const time=this.evaluationTime();if(!this.motion.ready(this.project,time))return false;for(const node of this.nodes.values()){const local=time-node.clip.start,visual=!node.audioOnly&&visualEnabled(this.project,node.track)&&local>=node.exposure.visualFrom&&local<node.exposure.visualTo,audio=!node.suppressAudio&&node.media.hasAudio&&audioEnabled(this.project,node.track)&&local>=node.exposure.audioFrom&&local<node.exposure.audioTo;if((!visual&&!audio)||node.failed)continue;if(!node.loaded)return false;if(node.element instanceof HTMLMediaElement&&(node.element.readyState<2||node.element.seeking||node.pendingSeek!==undefined))return false;}return true;}
  private ready(){if(!this.buffersReady())return false;if(this.waitingToStart)for(const node of this.nodes.values())if(node.active&&!node.failed&&node.element instanceof HTMLMediaElement&&(!node.playing||node.element.paused))return false;return true;}
  private wake(){if(!this.frame&&!this.destroyed)this.frame=requestAnimationFrame(now=>this.tick(now));}
  private tick(now:number){this.frame=0;if(this.destroyed||!this.project)return;const duration=this.duration;if(this.running&&this.time()>=duration){this.anchorTime=duration;this.running=false;this.waitingToStart=false;this.seek(duration);this.callbacks.onTime(duration);this.callbacks.onEnded();this.force=true;}
    const time=this.evaluationTime();if(this.running&&!this.waitingToStart){this.anchorTime=time;this.anchorClock=now;}if(time>=this.nextBoundary||Math.abs(time-this.lastPlan)>.3)this.updatePlan(time);this.syncNodes(time,now);
    const frameIndex=Math.floor(time*this.project.fps);const ready=this.ready();if(this.waitingToStart&&ready){this.waitingToStart=false;this.anchorClock=now;this.syncNodes(time,now);}
    if((this.force||this.dirty||this.running)&&(this.force||!this.running||frameIndex!==this.lastRenderFrame)&&(this.running||ready)&&this.motion.ready(this.project,time)){
      const frames=new Map<string,VisualFrame>();for(const node of this.nodes.values()){if(!node.active||node.media.kind==='audio'||!visualEnabled(this.project,node.track))continue;const frame=this.frameFor(node);const clip=this.motion.resolve(this.project,node.clip,time);if(frame&&clip)frames.set(clip.id,{clip,frame});}
      const visuals:VisualRenderNode[]=visualNodesAt(this.transitions!,time).flatMap<VisualRenderNode>(node=>{if(node.type==='clip'){const frame=frames.get(node.clip.id);return frame?[frame]:[];}return [{type:'transition' as const,transition:node.transition,from:frames.get(node.from.id),to:frames.get(node.to.id),progress:node.progress}];});
      const order=(a:Clip,b:Clip)=>this.project!.tracks.findIndex(t=>t.id===a.trackId)-this.project!.tracks.findIndex(t=>t.id===b.trackId)||a.start-b.start;
      const texts=this.project.clips.filter(c=>{const sample=time+(c.captionStyle?1e-9:0);if(c.text===undefined||sample<c.start||sample>=c.start+c.duration||!visualEnabled(this.project!,this.project!.tracks.find(t=>t.id===c.trackId)))return false;if(!c.captionStyle)return true;if(this.captionFontState!=='ready')return false;const error=captionGlyphError(c.text);if(error){const key=c.id+':'+c.text;if(!this.captionIssues.has(key)){this.captionIssues.add(key);if(this.captionIssues.size>64)this.captionIssues.delete(this.captionIssues.values().next().value!);this.callbacks.onIssue(undefined,error);}return false;}return true;}).sort(order).flatMap(c=>{const resolved=this.motion.resolve(this.project!,c,time);return resolved?[resolved]:[];});
      const started=performance.now();try{this.renderer.draw(this.project,time,visuals,texts);this.scopes?.capture(this.renderer.canvas,time,this.running);this.drawSelection();}catch(error){if(this.renderer.mode==='WebGL2'){this.fallback();this.reportStats(now,false);return;}else this.callbacks.onIssue(undefined,error instanceof Error?error.message:String(error));}
      this.renderTimes.push(performance.now()-started);if(this.renderTimes.length>120)this.renderTimes.shift();this.draws++;if(this.running&&this.lastRenderFrame>=0&&frameIndex>this.lastRenderFrame+1)this.missed+=frameIndex-this.lastRenderFrame-1;this.lastRenderFrame=frameIndex;this.dirty=false;this.force=false;
    }
    if(this.running&&now-this.lastReported>=100){this.lastReported=now;this.callbacks.onTime(this.time());}
    if(now-this.lastStats>=1000||!this.running)this.reportStats(now,ready);
    if(this.running)this.wake();
  }
  private sizeOverlay(){const v=this.viewport,width=v?Math.max(1,Math.round(v.width*v.ratio)):this.renderer.canvas.width,height=v?Math.max(1,Math.round(v.height*v.ratio)):this.renderer.canvas.height;if(this.overlay.width!==width)this.overlay.width=width;if(this.overlay.height!==height)this.overlay.height=height;}
  setViewport(viewport:PreviewViewport){this.viewport={...viewport,ratio:window.devicePixelRatio||1};this.sizeOverlay();this.redrawOverlay();}
  /** Snap lines shown while dragging, in project pixels. */
  setGuides(guides:Guide[]){if(!guides.length&&!this.guides.length)return;this.guides=guides;this.redrawOverlay();}
  redrawOverlay(){if(this.project&&!this.destroyed)this.drawSelection();}
  /** Project pixels per CSS pixel, and the overlay's visible area in project space. */
  private view():{unit:number;box:Box}{const project=this.project!,v=this.viewport;if(!v)return {unit:project.width/Math.max(1,this.overlay.clientWidth||this.overlay.width),box:{minX:0,minY:0,maxX:project.width,maxY:project.height}};const unit=1/Math.max(1e-6,v.scale);return {unit,box:{minX:-v.left*unit,minY:-v.top*unit,maxX:(v.width-v.left)*unit,maxY:(v.height-v.top)*unit}};}
  private locked(clipId:string){const project=this.project!,clip=project.clips.find(c=>c.id===clipId);return !!project.tracks.find(t=>t.id===clip?.trackId)?.locked;}
  /** Handles appear only for a single, unlocked, on-screen selection. */
  private handleRegion():HitRegion|undefined{if(this.selected.size!==1)return;const regions=this.renderer.hitRegions;for(let i=regions.length-1;i>=0;i--)if(this.selected.has(regions[i].clip.id))return this.locked(regions[i].clip.id)?undefined:regions[i];}
  private drawSelection(){const context=this.overlay.getContext('2d')!,project=this.project!,v=this.viewport;context.setTransform(1,0,0,1,0,0);context.clearRect(0,0,this.overlay.width,this.overlay.height);
    const px=v?v.ratio:(window.devicePixelRatio||1),k=v?v.scale*v.ratio:this.overlay.width/project.width,ox=v?v.left*v.ratio:0,oy=v?v.top*v.ratio:0,at=([x,y]:Point):Point=>[ox+x*k,oy+y*k];
    context.save();context.strokeStyle='#ff5ca8';context.lineWidth=px;for(const guide of this.guides){const [a,b]=guide.axis==='x'?[at([guide.position,0]),at([guide.position,project.height])]:[at([0,guide.position]),at([project.width,guide.position])];context.beginPath();context.moveTo(...a);context.lineTo(...b);context.stroke();}context.restore();
    for(const region of this.renderer.hitRegions){if(!this.selected.has(region.clip.id))continue;const c=regionCorners(region.geometry);context.beginPath();[c.nw,c.ne,c.se,c.sw].map(at).forEach((p,i)=>i?context.lineTo(...p):context.moveTo(...p));context.closePath();context.strokeStyle='#6ac7ff';context.lineWidth=1.5*px;context.stroke();}
    const region=this.handleRegion();if(!region)return;const g=region.geometry,c=regionCorners(g),{unit,box}=this.view(),[rx,ry]=at(rotateHandle(g,unit,box));
    context.save();context.shadowColor='rgba(0,0,0,.5)';context.shadowBlur=4*px;context.fillStyle='#fff';context.strokeStyle='#2f9ae0';context.lineWidth=1.5*px;
    for(const corner of [c.nw,c.ne,c.se,c.sw]){const [x,y]=at(corner);context.beginPath();context.arc(x,y,HANDLE_RADIUS*px,0,Math.PI*2);context.fill();context.stroke();}
    context.beginPath();context.arc(rx,ry,ROTATE_RADIUS*px,0,Math.PI*2);context.fill();context.restore();
    const r=4.6*px,end=Math.PI*1.3;context.strokeStyle=context.fillStyle='#1b2430';context.lineWidth=1.5*px;context.beginPath();context.arc(rx,ry,r,-Math.PI*.2,end);context.stroke();
    const ex=rx+Math.cos(end)*r,ey=ry+Math.sin(end)*r,tx=-Math.sin(end),ty=Math.cos(end),nx=Math.cos(end),ny=Math.sin(end);context.beginPath();context.moveTo(ex+tx*2.6*px,ey+ty*2.6*px);context.lineTo(ex+nx*2.4*px,ey+ny*2.4*px);context.lineTo(ex-nx*2.4*px,ey-ny*2.4*px);context.closePath();context.fill();}
  private reportStats(now:number,ready:boolean){let dropped=this.totalDropped,decoded=this.totalDecoded,maxGain=0,maxSourceLagSeconds=0;for(const node of this.nodes.values()){if(node.element instanceof HTMLVideoElement){const q=node.element.getVideoPlaybackQuality();dropped+=q.droppedVideoFrames;decoded+=q.totalVideoFrames;if(this.running&&!this.waitingToStart&&node.active&&visualEnabled(this.project!,node.track))maxSourceLagSeconds=Math.max(maxSourceLagSeconds,sourceTime(node.clip,this.evaluationTime(),node.media,node.exposure)-fromPreviewTime(node.media,node.presentedTime??node.element.currentTime,this.proxy));}maxGain=Math.max(maxGain,node.lastGain);}const sorted=[...this.renderTimes].sort((a,b)=>a-b);this.lastStatsValue={mode:this.renderer.mode,fps:this.running&&this.lastStats?(this.draws-this.statDraws)/((now-this.lastStats)/1000):0,renderMs:this.renderTimes.reduce((a,b)=>a+b,0)/Math.max(1,this.renderTimes.length),p95Ms:sorted[Math.floor(sorted.length*.95)]||0,renderedFrames:this.draws,missedFrames:this.missed,droppedVideoFrames:dropped,totalVideoFrames:decoded,decoders:this.nodes.size,width:this.renderer.canvas.width,height:this.renderer.canvas.height,time:this.time(),playing:this.running,seeking:!ready,waitingProxySources:[...new Set([...this.nodes.values()].filter(node=>node.active&&node.waitingForProxy).map(node=>previewSourceKey(node.media)))],audioContext:this.audio?.state||'not-created',maxGain,maxSourceLagSeconds};this.lastStats=now;this.statDraws=this.draws;this.callbacks.onStats(this.lastStatsValue);}
  stats(){return this.lastStatsValue;}
  snapshot(){if(this.project){cancelAnimationFrame(this.frame);this.frame=0;this.force=true;this.tick(performance.now());}return this.renderer.canvas.toDataURL('image/png');}
  /** Handles of the selected clip win over clips stacked above it; otherwise the top-most clip under the point. */
  pick(x:number,y:number):PreviewTarget|undefined{if(!this.project)return;const region=this.handleRegion();if(region){const {unit,box}=this.view(),handle=pickHandle(region.geometry,[x,y],unit,box),target=handle&&this.target(region);if(target)return {...target,handle};}const hit=hitTest(this.renderer.hitRegions,x,y);return hit&&this.target(hit);}
  /** Keyframe values without fades, caption animation or motion tracking, so drags write back what the user set. */
  private target(region:HitRegion):PreviewTarget|undefined{const clip=this.project!.clips.find(c=>c.id===region.clip.id);if(!clip)return;return {clip,state:interpolate(clip,this.evaluationTime()-clip.start),geometry:region.geometry,dragScale:region.dragScale||1,locked:this.locked(clip.id)};}
  hit(x:number,y:number){const region=hitTest(this.renderer.hitRegions,x,y),target=region&&this.target(region);return target&&!target.locked?target:undefined;}
  dispose(){this.destroyed=true;this.motion.dispose();this.scopes?.dispose();this.audioMeter?.dispose();cancelAnimationFrame(this.frame);for(const node of this.nodes.values())this.destroyNode(node);this.nodes.clear();this.renderer.dispose();this.audio?.close().catch(()=>{});this.overlay.getContext('2d')?.clearRect(0,0,this.overlay.width,this.overlay.height);this.host.replaceChildren();}
}
