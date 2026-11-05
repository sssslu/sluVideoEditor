export const vertex=`#version 300 es
precision highp float;
in vec2 aPosition;
uniform vec2 uProject;
uniform vec2 uSize;
uniform vec2 uOffset;
uniform vec2 uCenter;
uniform vec2 uScale;
uniform float uRotation;
uniform vec4 uUV;
out vec2 vUV;
out vec2 vCanvas;
void main(){
  vec2 p=aPosition*uSize+uOffset;
  vCanvas=(aPosition*uSize+uProject*.5)/uProject;
  p*=uScale;
  float c=cos(uRotation),s=sin(uRotation);
  p=vec2(c*p.x-s*p.y,s*p.x+c*p.y)+uCenter;
  gl_Position=vec4(p.x/uProject.x*2.-1.,1.-p.y/uProject.y*2.,0.,1.);
  vUV=mix(uUV.xy,uUV.zw,aPosition+.5);
}`;
export const textureFragment=`#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform float uOpacity;
uniform bool uPremultiplied;
in vec2 vUV;
out vec4 outputColor;
void main(){vec4 color=texture(uTexture,vUV);if(!uPremultiplied)color.rgb*=color.a;outputColor=color*uOpacity;}`;
