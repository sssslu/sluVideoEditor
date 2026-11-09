import type {Clip,Project,Transition} from '../../shared/types';
import {clipState,EMPTY_CROP,EMPTY_MASK,fittedSize,hexRgb,previewSize,type PreviewClip} from './math';
import {rasterCaption,textSignature,type TextFrame} from './text';
import {vertex,materialFragment,textureFragment,blurFragment} from './programs';
import {transitionFragment} from './transition-shader';
import {transitionDirection} from '../../shared/transitions';
import {ColorGradeTextures} from './color-grade';

export interface VideoFrameSource {key:string;source:TexImageSource;width:number;height:number;version:number}
export interface VisualFrame {clip:PreviewClip;frame:VideoFrameSource;type?:'clip'}
export interface TransitionVisualFrame {type:'transition';transition:Transition;from?:VisualFrame;to?:VisualFrame;progress:number}
export type VisualRenderNode=VisualFrame|TransitionVisualFrame;
export interface Geometry {size:[number,number];offset:[number,number];center:[number,number];scale:[number,number];rotation:number;uv:[number,number,number,number]}
export interface HitRegion {clip:Clip;geometry:Geometry;contains?:(x:number,y:number)=>boolean;dragScale?:number;transition?:boolean}
export interface Compositor {readonly mode:'WebGL2'|'CPU';canvas:HTMLCanvasElement;resize(project:Project,quality:number):void;draw(project:Project,time:number,visuals:VisualRenderNode[],texts:Clip[]):void;release(keys:Set<string>):void;hitRegions:HitRegion[];dispose():void}
const presets=['none','cinematic','warm','cool','mono','vivid'];
function imageGeometry(clip:PreviewClip,frame:VideoFrameSource,project:Project,time:number):Geometry{const state=clipState(clip,time),fit=fittedSize(frame.width,frame.height,project,clip.fit,clip.crop||EMPTY_CROP);return {size:[fit.width,fit.height],offset:[0,0],center:[project.width/2+state.x,project.height/2+state.y],scale:[state.scale*(clip.flipH?-1:1),state.scale*(clip.flipV?-1:1)],rotation:state.rotation*Math.PI/180,uv:fit.uv};}
function textGeometry(clip:Clip,text:TextFrame,project:Project,time:number):Geometry{const state=clipState(clip,time),anchor=clip.align==='left'?project.width*.05:clip.align==='right'?project.width*.95:project.width/2,offset=(text.width/2-text.padding)*(clip.align==='left'?1:clip.align==='right'?-1:0);return {size:[text.width,text.height],offset:[offset,0],center:[anchor+state.x,project.height/2+state.y],scale:[state.scale,state.scale],rotation:state.rotation*Math.PI/180,uv:[0,0,1,1]};}
const flatGeometry=(project:Project):Geometry=>({size:[project.width,project.height],offset:[0,0],center:[project.width/2,project.height/2],scale:[1,1],rotation:0,uv:[0,0,1,1]});
export function hitTest(regions:HitRegion[],x:number,y:number):HitRegion|undefined{return [...regions].reverse().find(({geometry:g,contains})=>{if(contains&&!contains(x,y))return false;const dx=x-g.center[0],dy=y-g.center[1],c=Math.cos(g.rotation),s=Math.sin(g.rotation);const localX=(c*dx+s*dy)/g.scale[0]-g.offset[0],localY=(-s*dx+c*dy)/g.scale[1]-g.offset[1];return Math.abs(localX)<=g.size[0]/2&&Math.abs(localY)<=g.size[1]/2;});}
/** Hit targets follow the full-canvas transition transform before clip transforms. */
export function transitionHitRegions(project:Pick<Project,'width'|'height'>,transition:Transition,progress:number,from:HitRegion[],to:HitRegion[]):HitRegion[]{
 const p=Math.max(0,Math.min(1,progress));if(p===0)return from;if(p===1)return to;
 const [dx,dy]=transitionDirection(transition.direction),center:[number,number]=[project.width/2,project.height/2];
 return [from,to].flatMap((regions,side)=>regions.map(source=>{const region={...source,transition:true},g=region.geometry;
  if(transition.kind==='slide'){const shift=side===0?p:-(1-p);return {...region,geometry:{...g,center:[g.center[0]+shift*dx*project.width,g.center[1]+shift*dy*project.height] as [number,number]}};}
  if(transition.kind==='zoom'){const scale=side===0?1+.25*p:.75+.25*p;return {...region,dragScale:scale,geometry:{...g,center:[center[0]+(g.center[0]-center[0])*scale,center[1]+(g.center[1]-center[1])*scale] as [number,number],scale:[g.scale[0]*scale,g.scale[1]*scale] as [number,number]}};}
  if(transition.kind==='wipe')return {...region,contains:(x:number,y:number)=>{const axis=dx?x/project.width:y/project.height,revealed=(dx||dy)<0?axis>=1-p:axis<p;return (!region.contains||region.contains(x,y))&&(side===1?revealed:!revealed);}};
  return region;
 }));
}

interface Program {program:WebGLProgram;locations:Map<string,WebGLUniformLocation|null>;position:number}
interface Texture {texture:WebGLTexture;width:number;height:number;version:number}
export class GLCompositor implements Compositor {
  readonly mode='WebGL2' as const;
  readonly gl:WebGL2RenderingContext;
  hitRegions:HitRegion[]=[];
  private material:Program;private simple:Program;private blur:Program;private transition:Program;private buffer:WebGLBuffer;
  private textures=new Map<string,Texture>();private textFrames=new Map<string,TextFrame>();
  private colorTextures:ColorGradeTextures;
  private targets:{texture:WebGLTexture;framebuffer:WebGLFramebuffer}[]=[];
  constructor(public canvas:HTMLCanvasElement){
    const gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,premultipliedAlpha:true,preserveDrawingBuffer:false,powerPreference:'high-performance'});if(!gl)throw new Error('WebGL2 unavailable');this.gl=gl;
    this.material=this.compile(materialFragment);this.simple=this.compile(textureFragment);this.blur=this.compile(blurFragment);this.transition=this.compile(transitionFragment);
    this.colorTextures=new ColorGradeTextures(gl);
    this.buffer=gl.createBuffer()!;gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-.5,-.5,.5,-.5,-.5,.5,-.5,.5,.5,-.5,.5,.5]),gl.STATIC_DRAW);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.disable(gl.DEPTH_TEST);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  }
  private compile(fragment:string):Program{const gl=this.gl;const shader=(kind:number,source:string)=>{const result=gl.createShader(kind)!;gl.shaderSource(result,source);gl.compileShader(result);if(!gl.getShaderParameter(result,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(result)||'GPU shader compile failed');return result;};const program=gl.createProgram()!,v=shader(gl.VERTEX_SHADER,vertex),f=shader(gl.FRAGMENT_SHADER,fragment);gl.attachShader(program,v);gl.attachShader(program,f);gl.linkProgram(program);gl.deleteShader(v);gl.deleteShader(f);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'GPU program link failed');return {program,locations:new Map(),position:gl.getAttribLocation(program,'aPosition')};}
  private uniform(program:Program,name:string){if(!program.locations.has(name))program.locations.set(name,this.gl.getUniformLocation(program.program,name));return program.locations.get(name)!;}
  private float(p:Program,name:string,value:number){this.gl.uniform1f(this.uniform(p,name),value);}
  private integer(p:Program,name:string,value:number){this.gl.uniform1i(this.uniform(p,name),value);}
  private vector(p:Program,name:string,value:number[]){const gl=this.gl,u=this.uniform(p,name);if(value.length===2)gl.uniform2fv(u,value);else if(value.length===4)gl.uniform4fv(u,value);}
  private geometry(p:Program,g:Geometry,project:Project){const gl=this.gl;gl.useProgram(p.program);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.enableVertexAttribArray(p.position);gl.vertexAttribPointer(p.position,2,gl.FLOAT,false,0,0);this.vector(p,'uProject',[project.width,project.height]);this.vector(p,'uSize',g.size);this.vector(p,'uOffset',g.offset);this.vector(p,'uCenter',g.center);this.vector(p,'uScale',g.scale);this.vector(p,'uUV',g.uv);this.float(p,'uRotation',g.rotation);this.integer(p,'uTexture',0);}
  private mask(p:Program,c:PreviewClip){const mask=c.mask||EMPTY_MASK;this.integer(p,'uMaskType',mask.type==='rect'?1:mask.type==='ellipse'?2:0);this.vector(p,'uMask',[mask.x,mask.y,mask.width,mask.height]);this.float(p,'uMaskFeather',mask.feather);this.integer(p,'uMaskInvert',Number(mask.invert));}
  private allocateTexture(){const gl=this.gl,texture=gl.createTexture()!;gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return texture;}
  // ANGLE video uploads must use texImage2D: texSubImage2D can fail after a stream/SAR size switch.
  // Version gating still uploads only when the decoder presents a new frame.
  private texture(frame:VideoFrameSource){
    const gl=this.gl;let cached=this.textures.get(frame.key);
    if(!cached){cached={texture:this.allocateTexture(),width:0,height:0,version:-1};this.textures.set(frame.key,cached);}
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,cached.texture);
    if(cached.version!==frame.version){
      // Premultiply only DOM image/video uploads. WebGL2 rejects typed-array
      // texImage3D (the color LUT) while this pixel-store flag is enabled.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
      try{
        if(!(frame.source instanceof HTMLVideoElement)&&cached.width===frame.width&&cached.height===frame.height)gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,frame.source);
        else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,frame.source);
      }finally{gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);}
      cached.width=frame.width;cached.height=frame.height;cached.version=frame.version;
    }
    return cached.texture;
  }
  resize(project:Project,quality:number){const size=previewSize(project.width,project.height,quality);if(this.canvas.width===size.width&&this.canvas.height===size.height&&this.targets.length===4)return;this.canvas.width=size.width;this.canvas.height=size.height;const gl=this.gl;for(const t of this.targets){gl.deleteFramebuffer(t.framebuffer);gl.deleteTexture(t.texture);}this.targets=[];for(let i=0;i<4;i++){const texture=this.allocateTexture();gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,size.width,size.height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);const framebuffer=gl.createFramebuffer()!;gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('GPU preview buffer unavailable');this.targets.push({texture,framebuffer});}gl.bindFramebuffer(gl.FRAMEBUFFER,null);this.textFrames.clear();}
  private layer(project:Project,time:number,{clip,frame}:VisualFrame,destination:WebGLFramebuffer|null){const gl=this.gl;gl.bindFramebuffer(gl.FRAMEBUFFER,destination);gl.enable(gl.BLEND);const state=clipState(clip,time);if(state.opacity<.0001)return;const g=imageGeometry(clip,frame,project,time);const hit={...g,size:(clip.fit==='cover'?[project.width,project.height]:g.size) as [number,number]};this.hitRegions.push({clip,geometry:hit});
      const blur=clip.blur>0;
      if(blur){gl.bindFramebuffer(gl.FRAMEBUFFER,this.targets[0].framebuffer);gl.disable(gl.BLEND);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);}
      const input=blur?{...g,center:[project.width/2,project.height/2] as [number,number],scale:[1,1] as [number,number],rotation:0}:g;
      this.geometry(this.material,input,project);this.texture(frame);this.float(this.material,'uOpacity',blur?1:state.opacity);this.float(this.material,'uBrightness',clip.brightness);this.float(this.material,'uContrast',clip.contrast);this.float(this.material,'uSaturation',clip.saturation);this.integer(this.material,'uPreset',presets.indexOf(clip.preset));this.integer(this.material,'uFinish',Number(!blur));this.integer(this.material,'uCover',Number(clip.fit==='cover'));const chroma=clip.chromaKey;this.vector(this.material,'uChroma',[...hexRgb(chroma?.color||'#00ff00'),chroma?.enabled?chroma.similarity:-1]);this.float(this.material,'uChromaSmooth',chroma?.smoothness||.1);this.mask(this.material,clip);this.colorTextures.bind(this.material.program,clip.colorGrade,project.colorLuts?.find(lut=>lut.id===clip.colorGrade?.lutId));gl.drawArrays(gl.TRIANGLES,0,6);
      if(blur){
        const flat=flatGeometry(project);flat.uv=[0,1,1,0];
        gl.bindFramebuffer(gl.FRAMEBUFFER,this.targets[1].framebuffer);this.geometry(this.blur,flat,project);gl.bindTexture(gl.TEXTURE_2D,this.targets[0].texture);this.vector(this.blur,'uDirection',[1/this.canvas.width,0]);this.float(this.blur,'uSigma',clip.blur*this.canvas.height/project.height);this.float(this.blur,'uOpacity',1);this.integer(this.blur,'uFinish',0);this.integer(this.blur,'uPreset',presets.indexOf(clip.preset));this.mask(this.blur,clip);this.colorTextures.bind(this.blur.program,clip.colorGrade,project.colorLuts?.find(lut=>lut.id===clip.colorGrade?.lutId));gl.drawArrays(gl.TRIANGLES,0,6);
        gl.bindFramebuffer(gl.FRAMEBUFFER,destination);gl.enable(gl.BLEND);const transform={...flat,center:g.center,scale:g.scale,rotation:g.rotation};this.geometry(this.blur,transform,project);gl.bindTexture(gl.TEXTURE_2D,this.targets[1].texture);this.vector(this.blur,'uDirection',[0,1/this.canvas.height]);this.float(this.blur,'uOpacity',state.opacity);this.integer(this.blur,'uFinish',1);gl.drawArrays(gl.TRIANGLES,0,6);
      }
    
  }
  private pair(project:Project,time:number,node:TransitionVisualFrame){const gl=this.gl,regions:HitRegion[][]=[];
    for(const [index,frame]of [node.from,node.to].entries()){const target=this.targets[index+2];gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);const start=this.hitRegions.length;if(frame)this.layer(project,time,frame,target.framebuffer);regions.push(this.hitRegions.splice(start));}
    this.hitRegions.push(...transitionHitRegions(project,node.transition,node.progress,regions[0],regions[1]));
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.enable(gl.BLEND);this.geometry(this.transition,flatGeometry(project),project);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.targets[2].texture);this.integer(this.transition,'uFrom',0);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,this.targets[3].texture);this.integer(this.transition,'uTo',1);
    this.float(this.transition,'uProgress',node.progress);this.integer(this.transition,'uKind',['dissolve','wipe','slide','zoom'].indexOf(node.transition.kind));
    const direction={left:[-1,0],right:[1,0],up:[0,-1],down:[0,1]}[node.transition.direction||'left'];this.vector(this.transition,'uTransitionDirection',direction);
    gl.drawArrays(gl.TRIANGLES,0,6);gl.activeTexture(gl.TEXTURE0);
  }
  draw(project:Project,time:number,visuals:VisualRenderNode[],texts:Clip[]){const gl=this.gl;if(gl.isContextLost())throw new Error('GPU context lost');gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.bindFramebuffer(gl.FRAMEBUFFER,null);const background=hexRgb(project.background);gl.clearColor(...background,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.enable(gl.BLEND);this.hitRegions=[];
    for(const node of visuals){if(node.type==='transition')this.pair(project,time,node);else this.layer(project,time,node,null);}
    const ratio=this.canvas.height/project.height;
    for(const clip of texts){let text=clip.captionStyle?undefined:this.textFrames.get(clip.id);const signature=textSignature(clip,project,ratio,time-clip.start);if(!text||text.signature!==signature){text=rasterCaption(clip,project,ratio,time-clip.start);if(!clip.captionStyle)this.textFrames.set(clip.id,text);else this.textFrames.delete(clip.id);const cached=this.textures.get(`text:${clip.id}`);if(cached&&(!clip.captionStyle||cached.version!==(text.version??1)))cached.version=-1;}
      const state=clipState(clip,time),g=textGeometry(clip,text,project,time);this.hitRegions.push({clip,geometry:g});this.geometry(this.simple,g,project);this.texture({key:`text:${clip.id}`,source:text.canvas,width:text.canvas.width,height:text.canvas.height,version:text.version??1});this.float(this.simple,'uOpacity',state.opacity);this.integer(this.simple,'uPremultiplied',1);gl.drawArrays(gl.TRIANGLES,0,6);
      if(clip.captionStyle){const key=`text:${clip.id}`,current=this.textures.get(key)!;this.textures.delete(key);this.textures.set(key,current);let bytes=0;for(const [id,value]of this.textures)if(id.startsWith('text:'))bytes+=value.width*value.height*4;for(const [id,value]of this.textures){if(bytes<=64*1024*1024)break;if(id===key||!id.startsWith('text:'))continue;gl.deleteTexture(value.texture);this.textures.delete(id);this.textFrames.delete(id.slice(5));bytes-=value.width*value.height*4;}}
    }
  }
  release(keys:Set<string>){for(const [key,texture]of this.textures)if(!keys.has(key)){this.gl.deleteTexture(texture.texture);this.textures.delete(key);if(key.startsWith('text:'))this.textFrames.delete(key.slice(5));}}
  dispose(){this.colorTextures.dispose();const gl=this.gl;for(const texture of this.textures.values())gl.deleteTexture(texture.texture);for(const t of this.targets){gl.deleteTexture(t.texture);gl.deleteFramebuffer(t.framebuffer);}for(const p of [this.material,this.simple,this.blur,this.transition])gl.deleteProgram(p.program);gl.deleteBuffer(this.buffer);this.textures.clear();this.textFrames.clear();}
}
