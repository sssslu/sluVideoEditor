import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {BackwardTrackingBuffer} from '../electron/tracking-buffer';
const root=path.resolve('.test-artifacts/tracking-buffer');
async function fixture(){await fs.mkdir(root,{recursive:true});return fs.mkdtemp(path.join(root,'case-'));}
const frame=(index:number)=>({width:16,height:12,sourceWidth:3840,sourceHeight:2160,pts:index*33333,data:Buffer.alloc(16*12*3,index)});
test('RAM and disk reverse windows keep the same timestamp/pixel pairs across wrap, reset and shorter final windows',async()=>{
  const dir=await fixture(),bytes=16*12*3;
  for(const disk of [false,true]){const file=path.join(dir,disk?'disk.raw':'memory.raw'),buffer=await BackwardTrackingBuffer.open(bytes,bytes*3,disk?bytes*3:0,file);assert.equal(buffer.capacity,3);assert.equal(buffer.payloadBytes,disk?bytes:bytes*3);
    try{for(const count of [10,2,7,1]){buffer.reset();for(let i=0;i<count;i++)await buffer.push(frame(i));const received:number[]=[];for await(const actual of buffer.reverse()){const index=actual.pts/33333;assert.deepEqual(actual.data,frame(index).data);assert.equal(actual.sourceWidth,3840);received.push(index);}assert.deepEqual(received,Array.from({length:Math.min(3,count)},(_,i)=>count-1-i));if(disk)assert.ok((await fs.stat(file)).size<=bytes*3);}}
    finally{await buffer.close();await buffer.close();}await assert.rejects(buffer.push(frame(0)),/닫혔/);if(!disk)await assert.rejects(fs.stat(file),{code:'ENOENT'});
  }
});
test('disk buffers reject partial records and cancellation, close their handles and never truncate an existing file',async()=>{
  const dir=await fixture(),file=path.join(dir,'window.raw'),bytes=16*12*3,buffer=await BackwardTrackingBuffer.open(bytes,bytes*2,bytes*4,file);
  try{await buffer.push(frame(0));await buffer.push(frame(1));const controller=new AbortController();controller.abort();await assert.rejects(buffer.push(frame(2),controller.signal),{name:'AbortError'});await assert.rejects(async()=>{for await(const _frame of buffer.reverse(controller.signal)){}},{name:'AbortError'});
    await fs.truncate(file,bytes+7);await assert.rejects(async()=>{for await(const _frame of buffer.reverse()){}},/불완전/);
  }finally{await buffer.close();}
  await fs.writeFile(file,'existing asset');await assert.rejects(BackwardTrackingBuffer.open(bytes,bytes,bytes,file),{code:'EEXIST'});assert.equal(await fs.readFile(file,'utf8'),'existing asset');
  await assert.rejects(BackwardTrackingBuffer.open(bytes,bytes,bytes-1,path.join(dir,'invalid.raw')),/한 프레임/);
});
