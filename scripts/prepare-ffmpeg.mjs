// Provision the exact tested Gyan Windows x64 full build; never silently use another version.
import { mkdir, readFile, writeFile, copyFile, mkdtemp, rm, stat, rename } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const version='8.0.1';
const root=path.resolve('.');
const binaries=path.join(root,'resources/bin');
const licenses=path.join(root,'resources/licenses');
const sources=path.join(licenses,'sources');
const expected={
  'ffmpeg.exe':'74db6c184a03dba2bdfe23e1a1f41cf5a8385bc1de6a7a1b26db1dc541abef93',
  'ffprobe.exe':'55bb6c6289367ae2383efa86b26bf2596f8adb72ac747360eb13df162354161c'
};
const archive={url:'https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-full_build.zip',sha256:'467cde100a47ed4b03a897988aeb4a296890c1e2b2d2864204657d002bc5fb90'};
const source={url:'https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz',sha256:'05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41'};
async function sha256(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
async function matches(file,digest){try{return await sha256(file)===digest;}catch{return false;}}
async function download(url,file,digest){
  if(digest&&await matches(file,digest))return;
  const temporary=file+'.part';
  try{
    const response=await fetch(url);if(!response.ok||!response.body)throw new Error(`HTTP ${response.status}: ${url}`);
    await pipeline(Readable.fromWeb(response.body),createWriteStream(temporary));
    if(digest&&await sha256(temporary)!==digest)throw new Error(`SHA-256 mismatch: ${path.basename(file)}`);
    await rename(temporary,file);
  }finally{await rm(temporary,{force:true}).catch(()=>{});}
}
await mkdir(binaries,{recursive:true});await mkdir(sources,{recursive:true});
const missing=[];
for(const [name,digest]of Object.entries(expected))if(!await matches(path.join(binaries,name),digest))missing.push(name);
if(missing.length&&process.argv.includes('--verify-only'))throw new Error(`Missing or unexpected FFmpeg binary: ${missing.join(', ')}`);
if(missing.length){
  // Reuse a matching existing installation first. This does not execute the candidate.
  const local=path.join(process.env.ProgramData||'C:/ProgramData','chocolatey/lib/ffmpeg-full/tools/ffmpeg');
  const localMatches=await Promise.all(Object.entries(expected).map(([name,digest])=>matches(path.join(local,'bin',name),digest)));
  if(localMatches.every(Boolean)){
    for(const name of Object.keys(expected))await copyFile(path.join(local,'bin',name),path.join(binaries,name));
    await copyFile(path.join(local,'LICENSE'),path.join(licenses,'FFmpeg-GPL.txt'));
    await copyFile(path.join(local,'README.txt'),path.join(licenses,'FFmpeg-build.txt'));
    console.log('Reused SHA-256 verified local Gyan FFmpeg 8.0.1 binaries.');
  }else{
    if(process.platform!=='win32')throw new Error('Run this Windows-binary provisioning script on Windows.');
    const scratch=path.join(root,'.test-artifacts');await mkdir(scratch,{recursive:true});
    const work=await mkdtemp(path.join(scratch,'provision-ffmpeg-'));
    try{
      const zip=path.join(work,'ffmpeg.zip');console.log('Downloading pinned Gyan FFmpeg 8.0.1 full build (235 MB)...');
      await download(archive.url,zip,archive.sha256);
      const expanded=path.join(work,'expanded');
      const quote=value=>`'${value.replaceAll("'","''")}'`;
      execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(expanded)}`],{windowsHide:true,stdio:'inherit'});
      const distribution=path.join(expanded,'ffmpeg-8.0.1-full_build');
      for(const [name,digest]of Object.entries(expected)){
        const file=path.join(distribution,'bin',name);if(!await matches(file,digest))throw new Error(`Unexpected official archive executable: ${name}`);
        await copyFile(file,path.join(binaries,name));
      }
      await copyFile(path.join(distribution,'LICENSE'),path.join(licenses,'FFmpeg-GPL.txt'));
      await copyFile(path.join(distribution,'README.txt'),path.join(licenses,'FFmpeg-build.txt'));
    }finally{
      if(path.dirname(path.resolve(work))===scratch&&path.basename(work).startsWith('provision-ffmpeg-'))await rm(work,{recursive:true,force:true});
    }
  }
}else console.log('FFmpeg and FFprobe match the pinned SHA-256 hashes; no binary download needed.');
if(!process.argv.includes('--verify-only')){
  await download(source.url,path.join(sources,'ffmpeg-8.0.1.tar.xz'),source.sha256);
  for(const [url,name]of [['https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz.asc','ffmpeg-8.0.1.tar.xz.asc'],['https://ffmpeg.org/ffmpeg-devel.asc','ffmpeg-release-key.asc']]){
    try{await stat(path.join(sources,name));}catch{await download(url,path.join(sources,name));}
  }
}
const build=execFileSync(path.join(binaries,'ffmpeg.exe'),['-version'],{windowsHide:true,encoding:'utf8'});
if(!build.startsWith('ffmpeg version 8.0.1-full_build-www.gyan.dev'))throw new Error('Unexpected FFmpeg version response');
await writeFile(path.join(licenses,'FFmpeg-version.txt'),build);
await writeFile(path.join(licenses,'ffmpeg-manifest.json'),JSON.stringify({version:'8.0.1-full_build-www.gyan.dev',platform:'win32-x64',release:'https://github.com/GyanD/codexffmpeg/releases/tag/8.0.1',sourceCommit:'https://github.com/FFmpeg/FFmpeg/commit/894da5ca7d',archive,executables:expected,upstreamSource:source,releaseSigningFingerprint:'FCF986EA15E6E293A5644F10B4322F04D67658D8'},null,2)+'\n');
console.log('FFmpeg provisioning and manifest complete.');
