import path from 'node:path';
import {mkdir,copyFile,stat} from 'node:fs/promises';
import {installSpeechModel} from '../electron/services';
const root=path.resolve('.test-artifacts/services');await mkdir(root,{recursive:true});
for(const name of ['jfk.wav','korean-heami.wav']){try{await stat(path.join(root,name));}catch{await copyFile(path.resolve('tests/fixtures',name),path.join(root,name));}}
await installSpeechModel({ffmpeg:path.resolve('resources/bin/ffmpeg.exe'),modelDir:path.join(root,'models'),cacheDir:path.join(root,'cache')});
console.log('Speech test fixtures ready');
