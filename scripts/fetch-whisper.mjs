import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const version='1.8.7';
const name='whisper-bin-x64.zip';
const sha256='d9627486e1c34a03745880485593473e047294260ce9a3cb0aa8deaf15b99af6';
const url=`https://github.com/ggml-org/whisper.cpp/releases/download/v${version}/${name}`;
await mkdir('.build-cache',{recursive:true});
const archive=path.resolve('.build-cache',name);
let bytes;try{bytes=await readFile(archive);}catch{}
if(!bytes||createHash('sha256').update(bytes).digest('hex')!==sha256){const response=await fetch(url);if(!response.ok)throw new Error(`HTTP ${response.status}`);bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw new Error('Whisper SHA-256 mismatch');await writeFile(archive,bytes);}
const destination=path.resolve('resources/bin/whisper-cpu');await mkdir(destination,{recursive:true});
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath '${archive.replaceAll("'","''")}' -DestinationPath '${destination.replaceAll("'","''")}' -Force`],{windowsHide:true});
await writeFile('resources/licenses/whisper-cli-version.json',JSON.stringify({version,url,sha256},null,2));
const response=await fetch(`https://raw.githubusercontent.com/ggml-org/whisper.cpp/v${version}/LICENSE`);if(!response.ok)throw new Error('Whisper license download failed');await writeFile('resources/licenses/Whisper-cli-LICENSE.txt',await response.text());
const ggml=await fetch('https://raw.githubusercontent.com/ggml-org/ggml/master/LICENSE');if(!ggml.ok)throw new Error('GGML license download failed');await writeFile('resources/licenses/GGML-LICENSE.txt',await ggml.text());
const modelLicense=await fetch('https://raw.githubusercontent.com/openai/whisper/main/LICENSE');if(!modelLicense.ok)throw new Error('Whisper model license download failed');await writeFile('resources/licenses/Whisper-model-LICENSE.txt',await modelLicense.text());
console.log('Whisper CPU runtime verified and extracted');
