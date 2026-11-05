import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const file=path.resolve('.test-artifacts/tracking-stress-fixtures/uhd-30-120s.mp4'),reports=[];
for(let round=0;round<24;round++)for(const mode of ['open','explicit']){
  const interval='59.000000%'+(mode==='explicit'?'9223372036854':''),start=performance.now();let output='',error='',stopped=false;
  const child=spawn(path.resolve('resources/bin/ffprobe.exe'),['-v','error','-threads','1','-protocol_whitelist','file,pipe','-select_streams','0','-read_intervals',interval,'-show_frames','-show_entries','frame=best_effort_timestamp_time:frame_side_data=','-of','csv=p=0',file],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>child.kill(),5000);
  child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.split('\n').filter(Boolean).length>=3){stopped=true;child.kill();}});child.stderr.on('data',chunk=>error+=chunk.toString());
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);
  const values=output.trim().split(/\r?\n/).filter(Boolean).map(line=>Number(line.split(',')[0]));
  reports.push({round,mode,interval,seconds:(performance.now()-start)/1000,code,stopped,values,error});
  if(mode==='explicit'){assert.ok(stopped,'Explicit interval must produce frames');assert.equal(values[0],58);assert.ok(Math.abs(values[1]-58-1/30)<.000001);}
}
await fs.writeFile('.test-artifacts/probe-interval-results.json',JSON.stringify({reports},null,2));
console.log(JSON.stringify(Object.fromEntries(['open','explicit'].map(mode=>{const rows=reports.filter(r=>r.mode===mode);return [mode,{runs:rows.length,empty:rows.filter(r=>!r.values.length).length,seconds:rows.reduce((sum,r)=>sum+r.seconds,0)}];})),null,2));
