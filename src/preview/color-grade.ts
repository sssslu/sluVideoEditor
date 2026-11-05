import type {ColorCurves,ColorGrade,ColorLut} from '../../shared/types';
import {CURVE_SAMPLES,curveTable,hslColorLut,lutValues} from '../../shared/color';

export const colorGradeShader=`
uniform highp sampler2D uCurveTable;
uniform highp sampler3D uColorLut;
uniform highp sampler3D uHslLut;
uniform bool uHasHsl;
uniform int uHslSize;
uniform bool uHasCurves;
uniform bool uHasLut;
uniform int uLutSize;
uniform vec3 uLutMin;
uniform vec3 uLutMax;
uniform float uLutIntensity;
ivec2 curveUV(int i){return ivec2(i%256,i/256);}
float curveAt(float v,int channel){float x=clamp(v,0.,1.)*4095.;int a=int(floor(x));return mix(texelFetch(uCurveTable,curveUV(a),0)[channel],texelFetch(uCurveTable,curveUV(min(a+1,4095)),0)[channel],fract(x));}
vec3 lutAt(highp sampler3D table,int size,vec3 minimum,vec3 maximum,vec3 rgb){
 vec3 p=clamp((rgb-minimum)/(maximum-minimum),0.,1.)*float(size-1);
 ivec3 lo=min(ivec3(floor(p)),ivec3(size-2));vec3 d=p-vec3(lo);
 ivec3 a,b;float f1,f2,f3;
 if(d.x>=d.y){if(d.y>=d.z){a=ivec3(1,0,0);b=ivec3(1,1,0);f1=d.x;f2=d.y;f3=d.z;}else if(d.x>=d.z){a=ivec3(1,0,0);b=ivec3(1,0,1);f1=d.x;f2=d.z;f3=d.y;}else{a=ivec3(0,0,1);b=ivec3(1,0,1);f1=d.z;f2=d.x;f3=d.y;}}
 else{if(d.x>=d.z){a=ivec3(0,1,0);b=ivec3(1,1,0);f1=d.y;f2=d.x;f3=d.z;}else if(d.y>=d.z){a=ivec3(0,1,0);b=ivec3(0,1,1);f1=d.y;f2=d.z;f3=d.x;}else{a=ivec3(0,0,1);b=ivec3(0,1,1);f1=d.z;f2=d.y;f3=d.x;}}
 return clamp(texelFetch(table,lo,0).rgb*(1.-f1)+texelFetch(table,lo+a,0).rgb*(f1-f2)+texelFetch(table,lo+b,0).rgb*(f2-f3)+texelFetch(table,lo+ivec3(1),0).rgb*f3,0.,1.);
}
vec3 gradeColor(vec3 rgb){if(uHasHsl)rgb=lutAt(uHslLut,uHslSize,vec3(0.),vec3(1.),rgb);if(uHasCurves)rgb=vec3(curveAt(rgb.r,0),curveAt(rgb.g,1),curveAt(rgb.b,2));if(uHasLut)rgb=mix(rgb,lutAt(uColorLut,uLutSize,uLutMin,uLutMax,rgb),uLutIntensity);return rgb;}
`;

/** Bounded texture residency; only edited curves are uploaded again. */
export class ColorGradeTextures {
  private curves=new Map<ColorCurves,WebGLTexture>();
  private luts=new Map<ColorLut,{texture:WebGLTexture;bytes:number}>();
  private emptyCurve:WebGLTexture;private emptyLut:WebGLTexture;
  private uniforms=new Map<WebGLProgram,Map<string,WebGLUniformLocation|null>>();
  constructor(private gl:WebGL2RenderingContext){this.emptyCurve=this.texture(gl.TEXTURE_2D);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,1,1,0,gl.RGBA,gl.FLOAT,new Float32Array(4));this.emptyLut=this.texture(gl.TEXTURE_3D);gl.texImage3D(gl.TEXTURE_3D,0,gl.RGBA32F,1,1,1,0,gl.RGBA,gl.FLOAT,new Float32Array(4));}
  private texture(target:number){const gl=this.gl,t=gl.createTexture()!;gl.bindTexture(target,t);gl.texParameteri(target,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(target,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(target,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(target,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);if(target===gl.TEXTURE_3D)gl.texParameteri(target,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);return t;}
  private rgba(data:ArrayLike<number>){const out=new Float32Array(data.length/3*4);for(let i=0;i<data.length/3;i++){out[i*4]=data[i*3];out[i*4+1]=data[i*3+1];out[i*4+2]=data[i*3+2];out[i*4+3]=1;}return out;}
  private lutTexture(lut:ColorLut):WebGLTexture {
    const gl=this.gl;let cached=this.luts.get(lut);
    if(cached)this.luts.delete(lut);
    else{
      const texture=this.texture(gl.TEXTURE_3D),data=this.rgba(lutValues(lut));
      gl.texImage3D(gl.TEXTURE_3D,0,gl.RGBA32F,lut.size,lut.size,lut.size,0,gl.RGBA,gl.FLOAT,data);
      cached={texture,bytes:data.byteLength};
    }
    this.luts.set(lut,cached);
    return cached.texture;
  }
  bind(program:WebGLProgram,grade?:ColorGrade,lut?:ColorLut){
    const gl=this.gl;let uniforms=this.uniforms.get(program);if(!uniforms){uniforms=new Map();this.uniforms.set(program,uniforms);}const u=(name:string)=>{if(!uniforms!.has(name))uniforms!.set(name,gl.getUniformLocation(program,name));return uniforms!.get(name)!;};
    const curves=grade?.enabled?grade.curves:undefined,activeLut=grade?.enabled&&grade.intensity>0?lut:undefined,hsl=grade?.enabled?hslColorLut(grade.hsl):undefined;
    gl.uniform1i(u('uHasCurves'),Number(!!curves));gl.uniform1i(u('uHasLut'),Number(!!activeLut));gl.uniform1i(u('uCurveTable'),2);gl.uniform1i(u('uColorLut'),3);
    gl.activeTexture(gl.TEXTURE2);let curve=this.emptyCurve;
    if(curves){const cached=this.curves.get(curves);if(cached){curve=cached;this.curves.delete(curves);}else{curve=this.texture(gl.TEXTURE_2D);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,256,CURVE_SAMPLES/256,0,gl.RGBA,gl.FLOAT,this.rgba(curveTable(curves)));}this.curves.set(curves,curve);while(this.curves.size>32){const [key,value]=this.curves.entries().next().value!;gl.deleteTexture(value);this.curves.delete(key);}}
    gl.bindTexture(gl.TEXTURE_2D,curve);gl.activeTexture(gl.TEXTURE3);let texture=this.emptyLut;
    if(activeLut){texture=this.lutTexture(activeLut);
      gl.uniform1i(u('uLutSize'),activeLut.size);gl.uniform3fv(u('uLutMin'),activeLut.domainMin);gl.uniform3fv(u('uLutMax'),activeLut.domainMax);gl.uniform1f(u('uLutIntensity'),grade!.intensity);
    }
    gl.bindTexture(gl.TEXTURE_3D,texture);
    gl.uniform1i(u('uHasHsl'),Number(!!hsl));gl.uniform1i(u('uHslLut'),4);gl.uniform1i(u('uHslSize'),hsl?.size??2);
    gl.activeTexture(gl.TEXTURE4);gl.bindTexture(gl.TEXTURE_3D,hsl?this.lutTexture(hsl):this.emptyLut);
    let bytes=[...this.luts.values()].reduce((total,item)=>total+item.bytes,0);
    for(const [key,value] of this.luts){if(bytes<=32*1024*1024)break;gl.deleteTexture(value.texture);this.luts.delete(key);bytes-=value.bytes;}
    gl.activeTexture(gl.TEXTURE0);
  }
  dispose(){const gl=this.gl;for(const t of this.curves.values())gl.deleteTexture(t);for(const t of this.luts.values())gl.deleteTexture(t.texture);gl.deleteTexture(this.emptyCurve);gl.deleteTexture(this.emptyLut);this.curves.clear();this.luts.clear();this.uniforms.clear();}
}
