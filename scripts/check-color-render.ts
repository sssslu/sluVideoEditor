import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {RenderColorFiles} from '../electron/render-color';
import {applyColorPixels,encodeLutData} from '../shared/color';
import {newClip,newProject} from '../shared/project';
import {canUseNativeBase,probeMedia,renderProjectDirect,runProcess} from '../electron/media';
import type {ColorGrade,ColorLut,ExportSettings} from '../shared/types';
const root=path.resolve('.test-artifacts/color-render');await fs.mkdir(root,{recursive:true});
const ffmpeg=path.resolve('resources/bin/ffmpeg.exe'),ctx={ffmpeg,ffprobe:path.resolve('resources/bin/ffprobe.exe'),cacheDir:path.join(root,'cache')};
const width=256,height=128,input=Buffer.alloc(width*height*4);
for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;input[i]=x;input[i+1]=(y*2+x*3)%256;input[i+2]=(y*7+x*5)%256;input[i+3]=255;}
await fs.writeFile(path.join(root,'chart.rgba'),input);
const alphaInput=Buffer.from(input);for(let i=3;i<alphaInput.length;i+=4)alphaInput[i]=(i>>>2)%256;
await fs.writeFile(path.join(root,'chart-alpha.rgba'),alphaInput);
await runProcess(ffmpeg,['-v','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-i',path.join(root,'chart.rgba'),'-frames:v','1',path.join(root,'chart.png')]);
function lut(size:number):ColorLut {const data=[];for(let b=0;b<size;b++)for(let g=0;g<size;g++)for(let r=0;r<size;r++){const x=r/(size-1),y=g/(size-1),z=b/(size-1);data.push(x*.8+y*z*.2,(y*.6+x*z*.4)**.8,z*1.3-.1);}return {id:'lut',name:'Synthetic color proof',size,domainMin:[0,0,0],domainMax:[1,1,1],encoding:"f32le",data:encodeLutData(data)};}
const small=lut(2),curves={master:[{x:0,y:.02},{x:.25,y:.12},{x:.7,y:.83},{x:1,y:.97}],blue:[{x:0,y:.08},{x:.5,y:.4},{x:1,y:1}]};
const cases:{name:string;grade:ColorGrade;lut?:ColorLut}[]=[
 {name:'curves',grade:{enabled:true,intensity:1,curves}},
 {name:'tetrahedral',grade:{enabled:true,intensity:1,lutId:'lut'},lut:small},
 {name:'strength',grade:{enabled:true,intensity:.37,lutId:'lut'},lut:small},
 {name:'domains',grade:{enabled:true,intensity:.63,lutId:'lut',curves},lut:{...small,domainMin:[-.1,.15,.05],domainMax:[.8,.85,1.1]}},
 {name:'cube33',grade:{enabled:true,intensity:.8,lutId:'lut',curves},lut:lut(33)},
 {name:'cube65',grade:{enabled:true,intensity:1,lutId:'lut'},lut:lut(65)},
 {name:'zero-strength',grade:{enabled:true,intensity:0,lutId:'lut'},lut:small},
 {name:'bypass',grade:{enabled:false,intensity:1,lutId:'lut',curves},lut:small},
];
const results=[];
for(const item of cases){
 const folder=path.join(root,item.name);await fs.mkdir(folder,{recursive:true});const graph:string[]=[],chain:string[]=[],files=new RenderColorFiles(folder),source=await files.append(graph,'0:v',chain,item.grade,item.lut,'color');
 graph.push(`[${source}]${chain.length?chain.join(','):'null'}[out]`);await fs.writeFile(path.join(folder,'filters.txt'),graph.join(';\n'));
 const output=(await runProcess(ffmpeg,['-v','error','-filter_complex_threads','1','-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-i',path.join(root,'chart.rgba'),'-filter_complex_script','filters.txt','-map','[out]','-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{cwd:folder,maxOutputBytes:input.length*2})).stdout;
 const expected=new Uint8ClampedArray(input);applyColorPixels(expected,item.grade,item.lut);assert.equal(output.length,expected.length);let max=0,sum=0;
 for(let i=0;i<output.length;i++){const difference=Math.abs(output[i]-expected[i]);if(i%4===3)assert.equal(difference,0,`${item.name} alpha at ${i/4}: ${output[i]} != ${expected[i]}`);else{max=Math.max(max,difference);sum+=difference;}}
 const mean=sum/(width*height*3);assert.ok(max<=2&&mean<.7,`${item.name} RGB max=${max}, mean=${mean}`);
 if(item.name==='zero-strength'||item.name==='bypass')assert.deepEqual(output,input);
 await fs.writeFile(path.join(folder,'actual.rgba'),output);await fs.writeFile(path.join(folder,'expected.rgba'),expected);
 const alphaOutput=(await runProcess(ffmpeg,['-v','error','-filter_complex_threads','1','-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-i',path.join(root,'chart-alpha.rgba'),'-filter_complex_script','filters.txt','-map','[out]','-frames:v','1','-f','rawvideo','-pix_fmt','rgba','pipe:1'],{cwd:folder,maxOutputBytes:input.length*2})).stdout;
 const alphaExpected=new Uint8ClampedArray(alphaInput);applyColorPixels(alphaExpected,item.grade,item.lut);assert.equal(alphaOutput.length,alphaExpected.length);let alphaRgbMax=0;
 for(let i=0;i<alphaOutput.length;i++){if(i%4===3)assert.equal(alphaOutput[i],alphaExpected[i],`${item.name}: opacity ${alphaExpected[i]} changed`);else if(alphaExpected[(i&~3)+3])alphaRgbMax=Math.max(alphaRgbMax,Math.abs(alphaOutput[i]-alphaExpected[i]));}
 assert.ok(alphaRgbMax<=2,`${item.name}: transparent RGB difference ${alphaRgbMax}`);
 results.push({name:item.name,max,mean,alphaLevels:256,alphaRgbMax});
}
const media=await probeMedia(path.join(root,'chart.png'),ctx,undefined,{derivatives:false}),clip={...newClip('video-1',media),duration:.5,colorGrade:cases[4].grade},project={...newProject(),width,height,media:[media],clips:[clip],colorLuts:[cases[4].lut!]};
const settings:ExportSettings={width,height,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'high',outputPath:path.join(root,'timeline.mp4')};
assert.equal(await canUseNativeBase({...clip,mediaId:'video'},{...media,id:'video',kind:'video',duration:1},.5,ctx),false,'Native bypass must never omit a grade');
await renderProjectDirect(project,settings,ctx,undefined,undefined,{start:0,duration:.5,frames:15,destination:path.join(root,'timeline.yuv')});
const timeline=await fs.readFile(path.join(root,'timeline.yuv'));assert.equal(timeline.length,width*height*1.5*15);
// The compositor retains full chroma before final video subsampling. Compare
// the independently graded image through that declared color representation,
// without invoking the scene graph, transforms, opacity or overlay code.
const expectedYuv=(await runProcess(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-i',path.join(root,'cube33','actual.rgba'),'-vf','scale=out_color_matrix=bt709:out_range=tv,format=yuv444p,format=yuv420p','-frames:v','1','-f','rawvideo','pipe:1'])).stdout;
let timelineMax=0,timelineSum=0;for(let i=0;i<timeline.length;i++){const d=Math.abs(timeline[i]-expectedYuv[i%expectedYuv.length]);timelineMax=Math.max(timelineMax,d);timelineSum+=d;}
assert.ok(timelineMax<=2&&timelineSum/timeline.length<.6,`Full timeline color max=${timelineMax}, mean=${timelineSum/timeline.length}`);
await fs.writeFile(path.join(root,'fixture.json'),JSON.stringify({width,height,cases,project,settings}));
const sources=['shared/color.ts','shared/color-edits.ts','electron/render-color.ts','electron/media.ts'],hash=async(file:string)=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const report={version:JSON.parse(await fs.readFile('package.json','utf8')).version,results,timeline:{frames:15,max:timelineMax,mean:timelineSum/timeline.length},sourceHashes:Object.fromEntries(await Promise.all(sources.map(async file=>[file,await hash(file)]))),checks:['8 actual FFmpeg LUT/curve outputs compared with CPU reference','All alpha samples preserved; disabled/zero-strength output byte-identical','Full timeline composition retains the grade; native fast path refuses effects']};
await fs.writeFile(path.join(root,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
