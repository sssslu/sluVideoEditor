import {mkdir,mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
const sourceDir=path.resolve('resources/licenses/sources');
const archive=path.join(sourceDir,'ffmpeg-8.0.1.tar.xz');
const digest=createHash('sha256').update(await readFile(archive)).digest('hex');
if(digest!=='05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41')throw new Error('Source archive hash mismatch');
const fingerprint='FCF986EA15E6E293A5644F10B4322F04D67658D8';
const tools=process.platform==='win32'?'C:/Program Files/Git/usr/bin/':'';
const scratch=path.resolve('.test-artifacts');await mkdir(scratch,{recursive:true});
const directory=await mkdtemp(path.join(scratch,'verify-source-'));
const argumentPath=value=>process.platform==='win32'?value.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>`/${drive.toLowerCase()}`):value;
try{
  const keyring=path.join(directory,'ffmpeg.gpg');
  execFileSync(path.join(tools,process.platform==='win32'?'gpg.exe':'gpg'),['--homedir',argumentPath(directory),'--batch','--no-options','--dearmor','--output',argumentPath(keyring),argumentPath(path.join(sourceDir,'ffmpeg-release-key.asc'))],{windowsHide:true,stdio:'pipe'});
  const result=execFileSync(path.join(tools,process.platform==='win32'?'gpgv.exe':'gpgv'),['--homedir',argumentPath(directory),'--keyring',argumentPath(keyring),'--status-fd','1',argumentPath(path.join(sourceDir,'ffmpeg-8.0.1.tar.xz.asc')),argumentPath(archive)],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if(!result.includes(`VALIDSIG ${fingerprint} `))throw new Error('Unexpected signing key fingerprint');
  await writeFile(path.join(sourceDir,'verification.json'),JSON.stringify({verifiedOn:new Date().toISOString(),file:'ffmpeg-8.0.1.tar.xz',sha256:digest,signature:'ffmpeg-8.0.1.tar.xz.asc',fingerprint,fingerprintSource:'https://ffmpeg.org/download.html',result:'VALIDSIG',verifier:'GnuPG gpgv',statusOutput:result.trim()},null,2)+'\n');
  console.log('FFmpeg 8.0.1 source archive signature verified against the published release key.');
}finally{
  if(path.dirname(path.resolve(directory))===scratch&&path.basename(directory).startsWith('verify-source-'))await rm(directory,{recursive:true,force:true});
}
