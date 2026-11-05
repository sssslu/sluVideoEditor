export {vertex,textureFragment} from './shaders';
import {colorGradeShader} from './color-grade';
const colorFunctions=`
vec3 satOnce(vec3 color,float amount){return clamp(mix(vec3(dot(color,vec3(.213,.715,.072))),color,amount),0.,1.);}
vec3 saturateColor(vec3 color,float amount){return amount>2.?satOnce(satOnce(color,sqrt(amount)),sqrt(amount)):satOnce(color,amount);}
vec3 contrastColor(vec3 color,float amount){return clamp((color-.5)*amount+.5,0.,1.);}
vec3 hueColor(vec3 color,float angle){float c=cos(angle),s=sin(angle);return clamp(mat3(.213+c*.787-s*.213,.213-c*.213+s*.143,.213-c*.213-s*.787,.715-c*.715-s*.715,.715+c*.285+s*.140,.715-c*.715+s*.715,.072-c*.072+s*.928,.072-c*.072-s*.283,.072+c*.928+s*.072)*color,0.,1.);}
vec3 presetColor(vec3 color,int preset){
 if(preset==1)return saturateColor(contrastColor(color,1.15),.8);
 if(preset==2)return saturateColor(clamp(mat3(.89074,.06282,.04896,.13842,.94348,.09612,.03402,.03024,.84358)*color,0.,1.),1.15);
 if(preset==3)return saturateColor(hueColor(color,radians(12.)),.9);
 if(preset==4)return saturateColor(color,0.);
 if(preset==5)return contrastColor(saturateColor(color,1.4),1.1);
 return color;
}`;
const maskFunctions=`
uniform vec2 uProject;
uniform int uMaskType;
uniform vec4 uMask;
uniform float uMaskFeather;
uniform bool uMaskInvert;
float maskAt(vec2 canvas){
 if(uMaskType==0)return 1.;
 vec2 p=(canvas-uMask.xy)*uProject,h=max(vec2(.0001),uMask.zw*uProject*.5),q=abs(p)-h;
 float d=uMaskType==2?(length(p/h)-1.)*min(h.x,h.y):length(max(q,0.))+min(max(q.x,q.y),0.);
 float feather=uMaskFeather*min(uProject.x,uProject.y),alpha=feather>0.?clamp(.5-d/feather,0.,1.):step(d,0.);
 return uMaskInvert?1.-alpha:alpha;
}`;
export const materialFragment=`#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform float uOpacity;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform int uPreset;
uniform vec4 uChroma;
uniform float uChromaSmooth;
uniform bool uCover;
uniform bool uFinish;
in vec2 vUV;
in vec2 vCanvas;
out vec4 outputColor;
${colorFunctions}
${maskFunctions}
${colorGradeShader}
void main(){
 if(uCover&&(vCanvas.x<0.||vCanvas.y<0.||vCanvas.x>1.||vCanvas.y>1.))discard;
 vec4 source=texture(uTexture,vUV);vec3 rgb=source.a>0.?source.rgb/source.a:vec3(0.);float alpha=source.a;
 if(uChroma.w>=0.)alpha*=clamp((distance(rgb,uChroma.xyz)/sqrt(3.)-uChroma.w)/max(.001,uChromaSmooth),0.,1.);
 rgb=clamp(rgb*(1.+uBrightness),0.,1.);rgb=contrastColor(rgb,uContrast);rgb=saturateColor(rgb,uSaturation);
 if(uFinish){rgb=gradeColor(presetColor(rgb,uPreset));alpha*=maskAt(vCanvas);}
 alpha*=uOpacity;outputColor=vec4(rgb*alpha,alpha);
}`;
export const blurFragment=`#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uDirection;
uniform float uSigma;
uniform float uOpacity;
uniform int uPreset;
uniform bool uFinish;
in vec2 vUV;
in vec2 vCanvas;
out vec4 outputColor;
${colorFunctions}
${maskFunctions}
${colorGradeShader}
void main(){
 vec4 sum=vec4(0.);float total=0.;
 for(int i=-6;i<=6;i++){float p=float(i)*.5,w=exp(-.5*p*p);vec2 uv=vUV+uDirection*uSigma*p;if(all(greaterThanEqual(uv,vec2(0.)))&&all(lessThanEqual(uv,vec2(1.))))sum+=texture(uTexture,uv)*w;total+=w;}
 vec4 color=sum/total;
 if(uFinish){vec3 straight=color.a>.00001?color.rgb/color.a:vec3(0.);color.rgb=gradeColor(presetColor(straight,uPreset))*color.a;color*=maskAt(vCanvas);}
 outputColor=color*uOpacity;
}`;
