import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const commit='53d74c6826735f01f4406b5ca9075eee27bec094';
const assets=[
 ['resources/models/person-matting-rvm.onnx','https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx',14975696,'88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828'],
 ['resources/models/person-matting-rvm-resnet50.onnx','https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50_fp32.onnx',107479165,'25db300fcb6ee27f941a1b52c97856e8d1f13c7f35817f81a612f89af0e8a85c'],
 ['resources/licenses/RVM-LICENSE.txt',`https://raw.githubusercontent.com/PeterL1n/RobustVideoMatting/${commit}/LICENSE`,35148,'8b1ba204bb69a0ade2bfcf65ef294a920f6bb361b317dba43c7ef29d96332b9b']
];
const sha=data=>createHash('sha256').update(data).digest('hex'),records=[];
for(const [file,url,size,expected] of assets){
 let data=await readFile(file).catch(()=>undefined);
 if(!data||data.length!==size||sha(data)!==expected){
  if(process.argv.includes('--verify'))throw new Error(`Missing or modified matting resource: ${file}`);
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`HTTP ${response.status}: ${url}`);
  data=Buffer.from(await response.arrayBuffer());if(data.length!==size||sha(data)!==expected)throw new Error(`Checksum mismatch: ${url}`);
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,data);
 }
 records.push({file,url,bytes:size,sha256:expected});
}
const adapters=[];
const recipe='scripts/build-matting-model.py',recipeSha256=sha(await readFile(recipe));
for(const [variant,file,size,expected,sourceSha256] of [
 ['mobilenetv3','resources/models/person-matting-rvm-bgr.onnx',14979595,'5292c6ccbfe2fdf9a2280532885605dfb3553b6b261cae4d63d3e47c7ddd49c1',assets[0][3]],
 ['resnet50','resources/models/person-matting-rvm-resnet50-bgr.onnx',107483061,'f95503b9719810647c58a1c5136a9e3b052d3612ae93ee233edc3b56e50a6c32',assets[1][3]],
]){
 let derived=await readFile(file).catch(()=>undefined);
 if(!derived||derived.length!==size||sha(derived)!==expected){
  if(process.argv.includes('--verify'))throw new Error(`Missing or modified matting resource: ${file}`);
  const local=path.resolve('.build-cache/matting/onnx-env/Scripts/python.exe'),python=process.env.SLU_MODEL_PYTHON||(await access(local).then(()=>local,()=> 'python'));
  try{await promisify(execFile)(python,[recipe,'--variant',variant],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});}catch(error){throw new Error('Build the GPU adapter with Python 3.9–3.12 and scripts/matting-build-requirements.txt. SLU_MODEL_PYTHON may select the build environment. '+String(error));}
  derived=await readFile(file);if(derived.length!==size||sha(derived)!==expected)throw new Error(`Derived matting model checksum mismatch: ${file}`);
 }
 adapters.push({file,bytes:size,sha256:expected,sourceSha256,recipe,recipeSha256,...(variant==='resnet50'?{recipeVariant:variant}:{})});
}
const [adapter,precisionAdapter]=adapters;
const provenance={repository:'https://github.com/PeterL1n/RobustVideoMatting',commit,release:'v1.0.0',license:'GPL-3.0',authors:'Shanchuan Lin, Linjie Yang, Imran Saleemi, Soumyadip Sengupta',model:'Official MobileNetV3 and ResNet50 FP32 ONNX weights and recurrent networks are unchanged. Both models perform human video matting. Portrait and fullbody use MobileNetV3. Precision selects ResNet50 as an alternative model.',checksumProvenance:'SHA-256 values are measured from the pinned official release downloads and enforced locally. The upstream release assets have no publisher-provided SHA-256 digest.',implementation:'CPU uses the original graph and TypeScript pixel conversion. DirectML uses derived byte-input/BGRA-output graphs with exact byte normalization and quantization, foreground/alpha and nonfinite validation on the GPU. Recurrent states remain FP32 and survive same-model GPU-to-CPU fallback. Uses the existing pinned ONNX Runtime 1.31.1 native binaries.',assets:records,adapter,precisionAdapter};
if(process.argv.includes('--verify')){
 const saved=JSON.parse(await readFile('resources/licenses/RVM-provenance.json','utf8'));if(JSON.stringify(saved)!==JSON.stringify(provenance))throw new Error('Matting provenance mismatch');
}else await writeFile('resources/licenses/RVM-provenance.json',JSON.stringify(provenance,null,2)+'\n');
console.log(`Verified ${records.length+adapters.length} matting resources and GPU adapter recipe.`);
