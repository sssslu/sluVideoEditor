import { readFile, writeFile, mkdir, readdir, copyFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root=path.resolve('.');
const destination=path.join(root,'resources/licenses');
await mkdir(destination,{recursive:true});
const lock=JSON.parse(await readFile(path.join(root,'package-lock.json'),'utf8'));
const entries=[];
for(const [location,resolution] of Object.entries(lock.packages||{})) {
  if(!location||resolution.dev||!location.includes('node_modules/'))continue;
  const directory=path.resolve(root,location);
  const metadata=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
  const names=(await readdir(directory)).filter(name=>/^(LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i.test(name)).sort();
  const files=[];
  for(const name of names)files.push({name,text:await readFile(path.join(directory,name),'utf8')});
  // These two upstream npm tarballs omit their MIT text. Use the exact,
  // checksum-pinned release license collected by prepare-tracking.mjs.
  if(!files.length&&['onnxruntime-node','onnxruntime-common'].includes(metadata.name)&&metadata.version==='1.31.1'){
    const text=await readFile(path.join(destination,'ONNXRuntime-LICENSE.txt'),'utf8');
    if(createHash('sha256').update(text).digest('hex')!=='2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c')throw new Error('ONNX Runtime release license checksum mismatch');
    files.push({name:'LICENSE (upstream v1.31.1)',text});
  }
  if(!files.length)throw new Error(`License text not found: ${metadata.name}@${metadata.version}`);
  const repository=typeof metadata.repository==='string'?metadata.repository:metadata.repository?.url;
  entries.push({name:metadata.name,version:metadata.version,license:metadata.license,repository,resolved:resolution.resolved,integrity:resolution.integrity,files});
}
entries.sort((a,b)=>a.name.localeCompare(b.name));
const full=entries.map(entry=>`${'='.repeat(78)}\n${entry.name} ${entry.version}\nLicense: ${entry.license}\nSource: ${entry.repository||entry.resolved}\nPackage: ${entry.resolved}\n${'='.repeat(78)}\n\n${entry.files.map(file=>`--- ${file.name} ---\n${file.text}`).join('\n\n')}`).join('\n\n');
await writeFile(path.join(destination,'npm-production-LICENSES.txt'),full+'\n');
await writeFile(path.join(destination,'npm-production-manifest.json'),JSON.stringify(entries.map(({files,...entry})=>({...entry,licenseFiles:files.map(file=>({name:file.name,sha256:createHash('sha256').update(file.text).digest('hex')}))})),null,2)+'\n');
const electron=JSON.parse(await readFile('node_modules/electron/package.json','utf8'));
for(const [source,target] of [['LICENSE','Electron-LICENSE.txt'],['LICENSES.chromium.html','Electron-LICENSES.chromium.html']]) {
  const filename=path.join('node_modules/electron/dist',source);
  try{await access(filename);}catch{throw new Error(`Electron ${electron.version} runtime missing. Run node node_modules/electron/install.js first.`);}
  await copyFile(filename,path.join(destination,target));
}
await writeFile(path.join(destination,'electron-version.json'),JSON.stringify({version:electron.version,platform:'win32',arch:'x64',source:`https://github.com/electron/electron/tree/v${electron.version}`,release:`https://github.com/electron/electron/releases/tag/v${electron.version}`},null,2)+'\n');
console.log(`Collected ${entries.length} production npm packages and Electron ${electron.version} license notices.`);
