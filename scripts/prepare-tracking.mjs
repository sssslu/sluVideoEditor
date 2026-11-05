import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Pinned public upstream assets, never a user-supplied model or code download.
const zoo='48b10fa505aeb51fbd127fc60a5c660040e823b7',opencv='d195a5ad7eb52aafc3585e494a9af2dc06a3b111';
const assets=[
  ['resources/models/object-tracking-vit.onnx',`https://media.githubusercontent.com/media/opencv/opencv_zoo/${zoo}/models/object_tracking_vittrack/object_tracking_vittrack_2023sep.onnx`,'2990f0b7cd44d92afa48cd97db6de7be113fc1d9594fddb74e2725c10478e91d'],
  ['resources/licenses/ViTTrack-LICENSE.txt',`https://raw.githubusercontent.com/opencv/opencv_zoo/${zoo}/models/object_tracking_vittrack/LICENSE`,'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'],
  ['resources/licenses/ViTTrack-OpenCV-LICENSE.txt',`https://raw.githubusercontent.com/opencv/opencv/${opencv}/LICENSE`,'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'],
  ['resources/licenses/ViTTrack-upstream.cpp',`https://raw.githubusercontent.com/opencv/opencv/${opencv}/modules/video/src/tracking/tracker_vit.cpp`,'c0a3942fb97d1a62155153d91aae13dd10e9cb83f44d8b32b45693ac5c14c68b'],
  ['resources/licenses/ONNXRuntime-LICENSE.txt','https://raw.githubusercontent.com/microsoft/onnxruntime/v1.31.1/LICENSE','2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c'],
  ['resources/licenses/ONNXRuntime-ThirdPartyNotices.txt','https://raw.githubusercontent.com/microsoft/onnxruntime/v1.31.1/ThirdPartyNotices.txt','143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3'],
  ['resources/licenses/DXC-LICENSE.txt','https://raw.githubusercontent.com/microsoft/DirectXShaderCompiler/b4711839e/LICENSE.TXT','27a49e35d1da96eba18fba54bc882667ff0ff8c0254f16f2b6e165d605ba7df8']
];
const sha=data=>createHash('sha256').update(data).digest('hex'),records=[];
for(const [file,url,expected] of assets){
  let data=await readFile(file).catch(()=>undefined);
  if(!data||sha(data)!==expected){
    if(process.argv.includes('--verify'))throw new Error(`Missing or modified tracking resource: ${file}`);
    const response=await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`HTTP ${response.status}: ${url}`);
    data=Buffer.from(await response.arrayBuffer());if(sha(data)!==expected)throw new Error(`Checksum mismatch: ${url}`);
    await mkdir(path.dirname(file),{recursive:true});await writeFile(file,data);
  }
  records.push({file,url,bytes:data.length,sha256:expected});
}
const directMLUrl='https://api.nuget.org/v3-flatcontainer/microsoft.ai.directml/1.15.4/microsoft.ai.directml.1.15.4.nupkg',archiveHash='4e7cb7ddce8cf837a7a75dc029209b520ca0101470fcdf275c1f49736a3615b9';
let archive;
for(const [entry,expected] of [['LICENSE.txt','a05138e3a085ff60a44881eedfa58dccb03ecc1d7b1f6ae888418e8c2fec4b8d'],['LICENSE-CODE.txt','903df5512f7d02609fed0c780a9b704f5a3eeb6e4d84ebe42a29845c81899a3c'],['ThirdPartyNotices.txt','2c95795c13ff48a58b6ed916f37901c23d964b5d9d601af422f17ad2172e7950']]){
  const file='resources/licenses/DirectML-'+entry;let data=await readFile(file).catch(()=>undefined);
  if(!data||sha(data)!==expected){
    if(process.argv.includes('--verify'))throw new Error(`Missing or modified tracking resource: ${file}`);
    if(!archive){
      const cache='.build-cache/tracking/microsoft.ai.directml.1.15.4.nupkg';let bytes=await readFile(cache).catch(()=>undefined);
      if(!bytes||sha(bytes)!==archiveHash){const response=await fetch(directMLUrl,{signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`HTTP ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());if(sha(bytes)!==archiveHash)throw new Error('DirectML archive checksum mismatch');await mkdir(path.dirname(cache),{recursive:true});await writeFile(cache,bytes);}
      archive=new AdmZip(bytes);
    }
    data=archive.getEntry(entry).getData();if(sha(data)!==expected)throw new Error(`DirectML license checksum mismatch: ${entry}`);await writeFile(file,data);
  }
  records.push({file,url:directMLUrl,archiveSha256:archiveHash,entry,bytes:data.length,sha256:expected});
}
const nativeFiles=[
  ['DirectML.dll','d16be72fa002dd610cca93e376f0ef44865dfce43de4b7bf9738af22534f7a9d'],
  ['dxcompiler.dll','430eed027979399769a325b60319aca4e4afa4daebe475d3c763dcf2a0190a72'],
  ['onnxruntime.dll','beb6e1edba0e74c132453fe4df113da2ea2b99ef8ea7dfc25696a872efd11c45'],
  ['onnxruntime_binding.node','8d9f996ff7dcc60c4899aa87aa7abe07d806f9c314882f44a001d0fd8a23d16f']
],binaries=[];
for(const [name,expected] of nativeFiles){const data=await readFile('node_modules/onnxruntime-node/bin/napi-v6/win32/x64/'+name);if(sha(data)!==expected)throw new Error(`Tracking runtime checksum mismatch: ${name}`);binaries.push({name,bytes:data.length,sha256:expected});}
if(!process.argv.includes('--verify')){
  await writeFile('resources/licenses/ViTTrack-provenance.json',JSON.stringify({zoo,opencv,adapterAuthor:'Pengyu Liu',changes:'TypeScript port: bounded direct crop sampling, validation, reusable input buffers, review/loss hints. See electron/tracking-math.ts. ONNX weights are unmodified.',assets:records},null,2)+'\n');
  await writeFile('resources/licenses/ONNXRuntime-binaries.json',JSON.stringify({version:'1.31.1',source:'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.31.1.tgz',platform:'win32',arch:'x64',directMLVersion:'1.15.4',dxcVersion:'1.8.2502.8 (b4711839e)',binaries},null,2)+'\n');
}
console.log(`Verified ${records.length} tracking model and license resources.`);
