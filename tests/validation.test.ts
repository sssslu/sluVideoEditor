import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newProject,newClip,splitClip,interpolate} from '../shared/project';
import {assertProject} from '../shared/validation';
import {parseByteRange,insideDirectory,localFilePath} from '../electron/file-policy';
test('project validates generated defaults and rejects dangling references and duplicate IDs',()=>{
  const project=newProject();project.clips.push(newClip('text-1'));
  assert.doesNotThrow(()=>assertProject(project));
  assert.throws(()=>assertProject({...project,clips:[...project.clips,project.clips[0]]}));
  assert.throws(()=>assertProject({...project,clips:[{...project.clips[0],trackId:'missing'}]}));
  assert.throws(()=>assertProject({...project,tracks:[null]}));assert.throws(()=>assertProject({...project,media:[null]}));
});
test('project validation rejects unsafe types and values before renderer or FFmpeg use',()=>{
  const project=newProject(),clip=newClip('text-1');project.clips=[clip];
  for(const changes of [{blur:31},{scale:9},{rotation:Infinity},{flipH:'true'},{duration:-1},{contrast:4},{text:'x'.repeat(20001)},{start:86399,duration:3}])assert.throws(()=>assertProject({...project,clips:[{...clip,...changes}]}));
  const frame={time:1,x:0,y:0,scale:1,rotation:0,opacity:1};
  assert.throws(()=>assertProject({...project,clips:[{...clip,keyframes:[frame,frame]}]}));
  assert.throws(()=>assertProject({...project,clips:[{...clip,keyframes:[{...frame,time:4}]}]}));
});
test('split preserves source speed/time and interpolated keyframe boundary',()=>{
  const clip={...newClip('text-1'),start:2,duration:6,in:3,speed:2,keyframes:[{time:0,x:0,y:0,scale:1,opacity:1,rotation:0},{time:6,x:60,y:30,scale:2,opacity:.5,rotation:90}]};
  const parts=splitClip(clip,4)!;
  assert.equal(parts[0].duration,2);assert.equal(parts[1].start,4);assert.equal(parts[1].in,7);assert.equal(parts[1].duration,4);
  assert.equal(interpolate(parts[0],2).x,20);assert.equal(interpolate(parts[1],0).x,20);
  assert.equal(interpolate(parts[1],4).x,60);assert.equal(splitClip(clip,2),null);
});
test('byte range covers normal, open-ended, suffix, EOF and malformed ranges',()=>{
  assert.deepEqual(parseByteRange(null,100),{start:0,end:99,partial:false});
  assert.deepEqual(parseByteRange('bytes=10-19',100),{start:10,end:19,partial:true});
  assert.deepEqual(parseByteRange('bytes=90-',100),{start:90,end:99,partial:true});
  assert.deepEqual(parseByteRange('bytes=-10',100),{start:90,end:99,partial:true});
  assert.deepEqual(parseByteRange('bytes=50-999',100),{start:50,end:99,partial:true});
  assert.deepEqual(parseByteRange('bytes=-999',100),{start:0,end:99,partial:true});
  assert.deepEqual(parseByteRange(null,0),{start:0,end:-1,partial:false});
  for(const header of ['bytes=-','bytes=-0','bytes=100-','bytes=20-10','bytes=0-1,4-5','items=0-1','bytes=1e3-'])assert.equal(parseByteRange(header,100),null);
  assert.equal(parseByteRange('bytes=0-',0),null);
});
test('local path containment uses boundaries and disallows UNC/protocol input',()=>{
  assert.ok(insideDirectory('C:/cache/thumb.jpg','C:/cache'));assert.equal(insideDirectory('C:/cache-other/thumb.jpg','C:/cache'),false);assert.equal(insideDirectory('C:/cache/../secret.jpg','C:/cache'),false);
  assert.equal(localFilePath('https://example.com/a.mp4'),false);assert.equal(localFilePath('\\\\server\\video.mp4'),false);assert.equal(localFilePath('C:/video.mp4\0bad'),false);assert.ok(localFilePath('C:/영상/test.mp4'));
});
