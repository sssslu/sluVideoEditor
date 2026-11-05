/** Inputs are complete, premultiplied RGBA clip layers; composite the pair once. */
export const transitionFragment=`#version 300 es
precision highp float;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uProgress;
uniform int uKind;
uniform vec2 uTransitionDirection;
in vec2 vCanvas;
out vec4 outputColor;
vec4 sampleLayer(sampler2D layer,vec2 uv){
 if(any(lessThan(uv,vec2(0.)))||any(greaterThanEqual(uv,vec2(1.))))return vec4(0.);
 return texture(layer,vec2(uv.x,1.-uv.y));
}
void main(){
 float p=clamp(uProgress,0.,1.);vec2 uv=vCanvas;
 if(p<=0.){outputColor=sampleLayer(uFrom,uv);return;}
 if(p>=1.){outputColor=sampleLayer(uTo,uv);return;}
 if(uKind==1){float distance=.5+dot(uv-.5,uTransitionDirection);bool reveal=uTransitionDirection.x+uTransitionDirection.y<0.?distance<=p:distance<p;outputColor=reveal?sampleLayer(uTo,uv):sampleLayer(uFrom,uv);return;}
 if(uKind==2){outputColor=sampleLayer(uFrom,uv-p*uTransitionDirection)+sampleLayer(uTo,uv+(1.-p)*uTransitionDirection);return;}
 if(uKind==3){outputColor=mix(sampleLayer(uFrom,(uv-.5)/(1.+.25*p)+.5),sampleLayer(uTo,(uv-.5)/(.75+.25*p)+.5),p);return;}
 outputColor=mix(sampleLayer(uFrom,uv),sampleLayer(uTo,uv),p);
}`;
