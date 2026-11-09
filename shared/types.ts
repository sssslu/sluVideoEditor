import type {TrackingOptions,MotionAnalysis,MotionSample,MotionBinding,TrackingStill} from './tracking';
import type {ProjectFileReference} from './project-files';
export type MediaKind = 'video' | 'audio' | 'image';
export type CutoutQuality = 'portrait' | 'fullbody' | 'precision';
/** Source-relative editing/export time and the original browser decoder clock.
 * Optional for legacy projects; refreshed from the original file on opening. */
export interface MediaTiming {version:1;origin:number;previewOffset:number}
export interface MediaAsset { id:string; path:string; name:string; kind:MediaKind; duration:number; width:number; height:number; fps:number; hasAudio:boolean; hasAlpha?:boolean; thumbnail?:string; waveform?:number[]; proxyPath?:string; codec?:string; videoStart?:number; videoEnd?:number; sourceRevision?:string;timing?:MediaTiming }
export interface Track { id:string; name:string; type:'video'|'audio'|'text'; muted:boolean; hidden:boolean; locked:boolean; solo?:boolean; height?:number }
export type Easing = 'linear'|'ease-in'|'ease-out'|'ease-in-out'|'hold';
/** Absolute playback rate at a normalized position in the clip's local timeline. */
export interface SpeedPoint {position:number;speed:number}
export interface Keyframe { time:number; x:number; y:number; scale:number; opacity:number; rotation:number; easing?:Easing; easingStart?:number; easingEnd?:number }
export interface Crop { left:number; top:number; right:number; bottom:number }
export interface ChromaKey { enabled:boolean; color:string; similarity:number; smoothness:number }
export interface ClipMask { type:'none'|'rect'|'ellipse'; x:number; y:number; width:number; height:number; feather:number; invert:boolean }
export type TextStyle = 'minimal'|'bold'|'box'|'neon'|'title';
/** UTF-16 text spans, with source/timeline-absolute times on cues and local times on clips. */
export interface CaptionWord {from:number;to:number;start:number;end:number;timing:'measured'|'manual'|'estimated'}
export interface CaptionStyle {
  font:'noto-sans-kr'|'gmarket-sans';weight:400|500|600|700|800;lineHeight:number;letterSpacing:number;
  outlineWidth:number;outlineColor:string;shadowBlur:number;shadowColor:string;
  background:'none'|'box'|'line';paddingX:number;paddingY:number;radius:number;maxWidth:number;
  highlight:boolean;activeColor:string;highlightEstimated?:boolean;
}
export interface CaptionAnimation {entry:'none'|'fade'|'pop'|'slide';exit:'none'|'fade'|'pop'|'slide';entrySeconds:number;exitSeconds:number;easing:Easing}
export interface ColorPoint {x:number;y:number}
export type ColorChannel='master'|'red'|'green'|'blue';
export type ColorCurves=Partial<Record<ColorChannel,ColorPoint[]>>;
/** .cube order: red changes fastest, then green, then blue. Embedded, never a file reference. */
export interface ColorLut {id:string;name:string;size:number;domainMin:[number,number,number];domainMax:[number,number,number];encoding:'f32le';data:string}
export type HslBand='red'|'yellow'|'green'|'cyan'|'blue'|'magenta';
export interface HslAdjustment {hue:number;saturation:number;lightness:number}
export type ColorHsl=Partial<Record<HslBand,HslAdjustment>>;
export interface ColorGrade {enabled:boolean;hsl?:ColorHsl;curves?:ColorCurves;lutId?:string;intensity:number}
export type EQKind='highpass'|'lowshelf'|'peaking'|'highshelf'|'lowpass';
export interface EQBand {type:EQKind;enabled:boolean;frequency:number;gain:number;q:number}
export interface AudioEQ {enabled:boolean;output:number;bands:EQBand[]}
export interface Clip {
  id:string; trackId:string; mediaId?:string; name:string; start:number; duration:number; in:number; speed:number; volume:number;
  fadeIn:number; fadeOut:number; opacity:number; scale:number; x:number; y:number; rotation:number; fit:'contain'|'cover'; flipH:boolean; flipV:boolean;
  brightness:number; contrast:number; saturation:number; blur:number; preset:'none'|'cinematic'|'warm'|'cool'|'mono'|'vivid';
  text?:string; fontSize:number; fontFamily:string; color:string; textBackground:string; textStyle:TextStyle; align:'left'|'center'|'right';
  animation:'none'|'fade'|'pop'|'slide'; keyframes:Keyframe[];
  captionWords?:CaptionWord[];captionStyle?:CaptionStyle;captionAnimation?:CaptionAnimation;
  colorGrade?:ColorGrade;
  audioEQ?:AudioEQ;
  motionBinding?:MotionBinding;
  /** Original effect envelope retained when splitting/trimming a clip. */
  sourceClipOffset?:number; sourceClipDuration?:number;
  crop?:Crop; chromaKey?:ChromaKey; mask?:ClipMask; speedCurve?:SpeedPoint[];
  stabilization?:{sourceMediaId:string;sourceIn:number;options:Omit<StabilizationOptions,'start'|'duration'>};
  reversal?:{sourceMediaId:string;sourceIn:number;sourceDuration:number;derivedMediaId:string;priorStabilization?:Clip['stabilization']};
  cutout?:{sourceMediaId:string;sourceIn:number;sourceDuration:number;derivedMediaId:string;quality:CutoutQuality;priorStabilization?:Clip['stabilization'];priorReversal?:Clip['reversal']};
  enhancement?:{sourceMediaId:string;sourceIn:number;sourceDuration:number;derivedMediaId:string;scale:2|4;priorStabilization?:Clip['stabilization'];priorReversal?:Clip['reversal']};
}
export interface TimelineMarker { id:string; time:number; label:string; color:string }
export interface Transition {id:string;fromClipId:string;toClipId:string;kind:'dissolve'|'wipe'|'slide'|'zoom';durationFrames:number;easing?:Easing;direction?:'left'|'right'|'up'|'down';audio?:'linear'|'equal-power'|'none'}
export interface Project { version:1|2|3|4|5|6|7|8|9|10; id:string; name:string; width:number; height:number; fps:number; background:string; media:MediaAsset[]; tracks:Track[]; clips:Clip[]; updatedAt:string; markers?:TimelineMarker[];transitions?:Transition[];colorLuts?:ColorLut[];motionPaths?:MotionAnalysis[];fileReferences?:ProjectFileReference[] }
export interface SubtitleCue { start:number; end:number; text:string;words?:CaptionWord[] }
export type SpeechModelId='base'|'small'|'turbo';
export interface SpeechOptions {model?:SpeechModelId;device?:'auto'|'cpu'|'cuda';start?:number;duration?:number;maxChars?:number;maxDuration?:number}
export interface StabilizationOptions {start?:number;duration?:number;smoothing?:number;accuracy?:number;shakiness?:number;crop?:'auto'|'black';zoom?:number}
export interface PersonCutoutOptions {start:number;duration:number;device?:'auto'|'cpu'|'gpu';quality?:CutoutQuality}
export interface EnhancementOptions {start:number;duration:number;scale:2|4;preview?:boolean}
export interface EnhancementInfo {installed:boolean;downloadBytes:number;model:string;deviceSupported:boolean;message?:string}
export interface ReverseOptions {start?:number;duration?:number}
export interface ExportSettings { width:number; height:number; fps:number; format:'mov'|'mp4'|'webm'|'gif'|'wav'; codec:'h264'|'hevc'|'av1'; encoder:'auto'|'cpu'|'nvenc'|'qsv'|'amf'; quality:'draft'|'standard'|'high'; outputPath?:string; transitionProcessing?:'auto'|'cpu' }
export type JobType = 'export'|'proxy'|'transcribe'|'model'|'stabilize'|'range'|'freeze'|'reverse'|'track'|'collect'|'relink'|'cutout'|'enhance'|'enhancement-install';
export interface JobEvent { id:string; type:JobType; status:'running'|'complete'|'error'|'cancelled'; progress:number; message:string; path?:string; media?:MediaAsset; cues?:SubtitleCue[];tracking?:MotionAnalysis;trackingReconnect?:import('./tracking-reconnect').TrackingReconnectResult;preview?:boolean }
export interface SystemInfo { version:string; ffmpegVersion:string; gpu:string; encoders:string[]; hardwareAcceleration:boolean; modelReady:boolean; modelDirectory:string; cacheDirectory:string; speechModels?:{id:SpeechModelId;name:string;bytes:number;installed:boolean}[];speechCuda?:boolean }
export type PreviewStatusEvent = {media:Pick<MediaAsset,'id'|'path'|'sourceRevision'>;attemptId:string}&(
  {status:'preparing'}|{status:'failed';message:string}
);
export interface StudioAPI {
  importColorLut():Promise<ColorLut|null>;
  importMedia(paths?:string[]):Promise<MediaAsset[]>;
  getPathForFile(file:File):string;
  mediaUrl(path:string):string;
  openProject():Promise<{project:Project;path:string;missing:string[];modified?:boolean}|null>;
  saveProject(project:Project,path?:string,saveAs?:boolean):Promise<string|null>;
  collectProject(project:Project):Promise<{jobId:string;path:string}|null>;
  autosave(project:Project):Promise<void>;
  recoverProject():Promise<Project|null>;
  listRecoveries():Promise<{id:string;name:string;updatedAt:string;clips:number}[]>;
  loadRecovery(id:string):Promise<Project|null>;
  exportProject(project:Project,settings:ExportSettings):Promise<{jobId:string;path:string}|null>;
  cancelJob(id:string):Promise<void>;
  generateProxy(media:MediaAsset):Promise<{jobId:string}>;
  stabilizeMedia(media:MediaAsset,options:StabilizationOptions):Promise<{jobId:string}>;
  freezeFrame(media:MediaAsset,time:number):Promise<{jobId:string}>;
  reverseMedia(media:MediaAsset,options:ReverseOptions):Promise<{jobId:string}>;
  removePersonBackground(media:MediaAsset,options:PersonCutoutOptions):Promise<{jobId:string}>;
  enhancementInfo():Promise<EnhancementInfo>;
  installEnhancementEngine():Promise<{jobId:string}>;
  enhanceMedia(media:MediaAsset,options:EnhancementOptions):Promise<{jobId:string}>;
  discardEnhancementPreview(mediaId:string):Promise<void>;
  trackMedia(media:MediaAsset,options:TrackingOptions):Promise<{jobId:string}>;
  trackingStill(requestId:string,media:MediaAsset,time:number,maxDimension?:number):Promise<TrackingStill>;
  cancelTrackingStill(requestId:string):Promise<void>;
  readTrackingPath(path:string,time:number,limit?:number):Promise<{metadata:MotionAnalysis;startIndex:number;samples:MotionSample[];nextIndex?:number}>;
  reconnectTracking(project:Project,analysisId:string):Promise<{jobId:string}|null>;
  analyzeVideoRange(media:MediaAsset):Promise<MediaAsset>;
  transcribe(media:MediaAsset,language:string,options?:SpeechOptions):Promise<{jobId:string}>;
  installModel(model?:SpeechModelId):Promise<{jobId:string}>;
  installSpeechEngine():Promise<{jobId:string}>;
  getSystemInfo():Promise<SystemInfo>;
  importSubtitles():Promise<SubtitleCue[]|null>;
  exportSubtitles(cues:SubtitleCue[]):Promise<string|null>;
  showInFolder(path:string):Promise<void>;
  openHelp():Promise<void>;
  onJob(callback:(event:JobEvent)=>void):()=>void;
  onProjectWarning(callback:(message:string)=>void):()=>void;
  onMediaUpdated(callback:(media:MediaAsset)=>void):()=>void;
  onPreviewStatus(callback:(event:PreviewStatusEvent)=>void):()=>void;
}
declare global { interface Window { studio:StudioAPI } }
