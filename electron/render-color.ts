import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {ColorCurves,ColorGrade,ColorLut} from '../shared/types';
import {CURVE_SAMPLES,curveTable,hasColorGrade,hslColorLut,lutValues} from '../shared/color';
import {alpha16To8} from './alpha-filters';

/** Per render-window files, generated only from validated embedded numbers.
 * Curves and LUTs share the preview's sample tables and interpolation order.
 * A 16-bit planar intermediate avoids an 8-bit rounding step per operation.
 */
export class RenderColorFiles {
  private curves=new Map<ColorCurves,string>();private luts=new Map<ColorLut,string>();
  constructor(private directory:string){}
  private async curveFile(curves:ColorCurves){let name=this.curves.get(curves);if(name)return name;name=`color-curve-${this.curves.size}.cube`;const table=curveTable(curves),lines=[`LUT_1D_SIZE ${CURVE_SAMPLES}`];for(let i=0;i<CURVE_SAMPLES;i++)lines.push([table[3*i],table[3*i+1],table[3*i+2]].map(n=>n.toPrecision(9)).join(' '));await fs.writeFile(path.join(this.directory,name),lines.join('\n')+'\n');this.curves.set(curves,name);return name;}
  private async lutFile(lut:ColorLut){let name=this.luts.get(lut);if(name)return name;name=`color-lut-${this.luts.size}.cube`;const values=lutValues(lut),lines=[`LUT_3D_SIZE ${lut.size}`];for(let i=0;i<values.length;i+=3)lines.push(Array.from(values.subarray(i,i+3),n=>n.toPrecision(9)).join(' '));await fs.writeFile(path.join(this.directory,name),lines.join('\n')+'\n');this.luts.set(lut,name);return name;}
  async append(graph:string[],input:string,chain:string[],grade:ColorGrade|undefined,lut:ColorLut|undefined,label:string):Promise<string>{
    if(!hasColorGrade(grade))return input;
    chain.push('format=gbrap16le');
    const hsl=hslColorLut(grade!.hsl);
    if(hsl)chain.push(`lut3d=file=${await this.lutFile(hsl)}:interp=tetrahedral`,'format=gbrap16le');
    if(grade!.curves)chain.push(`lut1d=file=${await this.curveFile(grade!.curves)}:interp=linear`,'format=gbrap16le');
    if(grade!.lutId&&grade!.intensity>0){
      if(!lut)throw new Error('색 보정 LUT가 없습니다.');
      const filters:string[]=[];
      if(lut.domainMin.some(v=>v!==0)||lut.domainMax.some(v=>v!==1))filters.push('format=rgba64le','lutrgb='+['r','g','b'].map((c,i)=>`${c}='clip((val/maxval-(${lut.domainMin[i]}))/(${lut.domainMax[i]-lut.domainMin[i]}),0,1)*maxval'`).join(':')+':a=val','format=gbrap16le');
      filters.push(`lut3d=file=${await this.lutFile(lut)}:interp=tetrahedral`,'format=gbrap16le');
      if(grade!.intensity===1)chain.push(...filters);
      else{
        graph.push(`[${input}]${chain.join(',')},split[${label}Original][${label}Input]`);
        graph.push(`[${label}Input]${filters.join(',')}[${label}Graded]`);
        graph.push(`[${label}Original][${label}Graded]blend=all_expr='A*${1-grade!.intensity}+B*${grade!.intensity}':shortest=1[${label}Mixed]`);
        input=`${label}Mixed`;chain.length=0;
      }
    }
    chain.push(...alpha16To8);return input;
  }
}
