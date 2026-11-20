import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {execFileSync} from 'node:child_process';
import {launchPrivateDesktop} from './quiet-desktop.mjs';

// Exercise the normal Windows app on a separate desktop, including its native file pickers.
// By default the test opens the installed build. --source uses the current compiled checkout.
const args=process.argv.slice(2);
assert.ok(args.every(arg=>arg==='--source'),'Expected only the optional --source flag');
const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const root=path.resolve('.test-artifacts/desktop-edit');
await fs.mkdir(root,{recursive:true});
const run=await fs.mkdtemp(path.join(root,'check-'));
const report=path.join(run,'desktop.json');
const flags=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/check-computer-use.ps1'),'-Report',report];
if(args.includes('--source'))flags.push('-Source','-Executable',path.resolve('node_modules/electron/dist/electron.exe'));
const session=await launchPrivateDesktop(ps,flags,{timeoutMs:480000});
console.log('Windows UI check:',run);
try {
  while(session.evidence.rootExitCode===undefined){
    session.assertRunning();
    await delay(300);
  }
} finally {
  try {await session.close();}
  finally {
    for(const file of ['application.stdout.log','application.stderr.log']){
      const log=await fs.readFile(path.join(session.evidence.directory,file),'utf8').catch(()=>'');
      if(log)console.log(log.trim());
    }
  }
}
assert.equal(session.evidence.rootExitCode,0);
const result=JSON.parse((await fs.readFile(report,'utf8')).replace(/^\uFEFF/,''));
assert.equal(result.passed,true);
assert.equal(result.version,JSON.parse(await fs.readFile('package.json','utf8')).version);
// Decode the finished file independently of the editor. The reference is a dark
// moving background. Bright glyphs should appear only inside the title's span.
const probe=JSON.parse(execFileSync(path.resolve('resources/bin/ffprobe.exe'),
  ['-v','error','-show_streams','-show_format','-of','json',result.output],{windowsHide:true,encoding:'utf8'}));
const video=probe.streams.find(stream=>stream.codec_type==='video');
assert.equal(video.nb_frames,'360');
assert.equal(Number(probe.format.duration),12);
assert.ok(probe.streams.some(stream=>stream.codec_type==='audio'));
function frame(file,time){
  return execFileSync(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-ss',String(time),'-i',file,'-map','0:v:0',
    '-vf','scale=640:360:flags=area,format=gray','-frames:v','1','-f','rawvideo','pipe:1'],{windowsHide:true});
}
const brightPixels=[4,6,9].map(time=>{
  const reference=frame('examples/01 - Aurora motion.mp4',time);
  const output=frame(result.output,time);
  assert.equal(reference.length,640*360);assert.equal(output.length,reference.length);
  return output.reduce((count,value,index)=>count+Number(value-reference[index]>65),0);
});
assert.ok(brightPixels[1]>200&&brightPixels[1]>5*Math.max(1,brightPixels[0],brightPixels[2]),String(brightPixels));
result.checks.push('decoded-video-audio-and-caption-interval');
result.video={frames:Number(video.nb_frames),width:video.width,height:video.height,brightPixelsAt4s6s9s:brightPixels};
await fs.writeFile(report,JSON.stringify(result,null,2)+'\n');
console.log('Report:',report);
