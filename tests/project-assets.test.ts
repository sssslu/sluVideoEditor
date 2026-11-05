import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,writeFileSync} from 'node:fs';
import path from 'node:path';
import {newProject,newClip} from '../shared/project';
import {attachMotion,reconcileMotion} from '../shared/motion';
import {assertProject} from '../shared/validation';
import type {MotionAnalysis,MotionSample} from '../shared/tracking';
import {MotionSampleWriter,assembleMotionFile,MotionFileReader} from '../electron/tracking-file';
import {TrackingRegistry} from '../electron/tracking-registry';
import {RenderMotion} from '../electron/render-motion';
import {readSourceRevision} from '../electron/source-revision';
import {readProject} from '../electron/project-store';
import {saveProjectWithAssets,resolveProjectAssets,relocateProjectSources,reconnectTrackingFile} from '../electron/project-assets';
import {applyTrackingReconnect,planTrackingReconnect} from '../shared/tracking-reconnect';
import {FileDigests,relativeAsset,publishAsset} from '../electron/file-digest';
import {textCaptionStyle} from '../shared/captions';

const root=path.resolve('.test-artifacts/project-assets');

test('ordinary and collected saves preserve format10 HSL and both caption font choices',async()=>{
  const {dir,project,registry}=await fixture();
  project.clips[0].colorGrade={enabled:true,intensity:1,hsl:{red:{hue:10,saturation:.2,lightness:-.1}}};
  project.clips.push({...newClip('text-1'),captionStyle:textCaptionStyle('bold')});
  project.clips.push({...newClip('text-1'),captionStyle:textCaptionStyle('minimal')});
  const before=JSON.stringify(project);
  for(const collect of [false,true]) {
    const file=path.join(dir,collect?'format10-collected.sluproj':'format10-ordinary.sluproj');
    await saveProjectWithAssets(project,file,{registry,collect});
    const saved=await readProject(file);
    assert.equal(JSON.parse(await fs.readFile(file,'utf8')).version,10);
    assert.deepEqual(saved.clips,JSON.parse(JSON.stringify(project.clips)));
    assertProject(saved);
  }
  assert.equal(JSON.stringify(project),before);
});
async function fixture(){
  await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'case-')),source=path.join(dir,'original.mp4'),image=path.join(dir,'marker.png');
  await fs.writeFile(source,Buffer.alloc(5*1024*1024,37));await fs.writeFile(image,Buffer.from('image fixture'));
  const media={id:'source-media',name:'original.mp4',path:source,kind:'video' as const,duration:2,width:160,height:90,fps:30,hasAudio:false,sourceRevision:await readSourceRevision(source)};
  const marker={...media,id:'marker-media',name:'marker.png',path:image,kind:'image' as const,duration:0,width:20,height:20,sourceRevision:await readSourceRevision(image)};
  const samples:MotionSample[]=Array.from({length:60},(_,i)=>({time:i/30,box:{x:.2+i/300,y:.3,width:.1,height:.1},score:.9,status:'tracked',anchor:i===0}));
  const file=path.join(dir,'motion.slutrack'),writer=await MotionSampleWriter.open(file+'.forward',1);for(const sample of samples)await writer.append(sample);await writer.close();await fs.writeFile(file+'.back','');
  const metadata:Omit<MotionAnalysis,'path'>={version:1,id:'analysis',mediaId:media.id,sourceRevision:media.sourceRevision,sourceWidth:160,sourceHeight:90,analysisWidth:160,analysisHeight:90,start:0,end:2,firstFrameTime:0,frames:60,anchors:[{time:0,box:samples[0].box}],backend:'cpu'};
  await assembleMotionFile(file,metadata,file+'.back',file+'.forward');const analysis={...metadata,path:file},p=newProject();p.width=320;p.height=180;p.media=[media,marker];p.clips=[{...newClip('video-1',media),id:'source',duration:2},{...newClip('video-1',marker),id:'target',duration:2}];
  const project=attachMotion(p,'source',['target'],analysis,samples[0],0,false),registry=new TrackingRegistry();await registry.register(analysis,source);return {dir,project,registry,analysis};
}
test('ordinary save preserves immutable tracking beside the project and records its source hash',async()=>{
  const {dir,project,registry,analysis}=await fixture(),file=path.join(dir,'ordinary.sluproj'),before=JSON.stringify(project);
  const saved=await saveProjectWithAssets(project,file,{registry});assert.equal(JSON.stringify(project),before);assert.equal(saved.media[0].path,project.media[0].path);assert.notEqual(saved.motionPaths![0].path,analysis.path);
  assert.deepEqual(await fs.readFile(saved.motionPaths![0].path),await fs.readFile(analysis.path));assert.equal(saved.fileReferences?.length,2);assert.ok(saved.fileReferences!.find(r=>r.kind==='tracking')!.relativePath);assert.equal(saved.fileReferences!.find(r=>r.kind==='media')!.revision,analysis.sourceRevision);
  const opened=await resolveProjectAssets(await readProject(file),file,path.join(dir,'cache'));const restored=new TrackingRegistry();restored.approveProject(opened,true);assert.equal((await restored.read(opened.motionPaths![0].path,1)).samples[0].time,1);
});
test('collected project prefers its own assets, survives a second folder move and retains all motion keys',async()=>{
  const {dir,project,registry}=await fixture(),folder=path.join(dir,'collection');await fs.mkdir(folder);const file=path.join(folder,'edit.sluproj');
  const saved=await saveProjectWithAssets(project,file,{collect:true,registry});assert.equal(saved.fileReferences?.length,3);assert.notEqual(saved.media[0].path,project.media[0].path);assert.equal(saved.motionPaths![0].sourceRevision,saved.media[0].sourceRevision);assert.notEqual(saved.media[0].sourceRevision,project.media[0].sourceRevision);
  const moved=path.join(dir,'moved');await fs.cp(folder,moved,{recursive:true});const movedFile=path.join(moved,'renamed.sluproj');await fs.copyFile(path.join(moved,'edit.sluproj'),movedFile);
  const opened=await resolveProjectAssets(await readProject(movedFile),movedFile,path.join(dir,'cache'));assert.ok(opened.media.every(m=>m.path.startsWith(moved+path.sep)));assert.equal(opened.motionPaths![0].sourceRevision,opened.media[0].sourceRevision);
  const original=new RenderMotion(project),relocated=new RenderMotion(opened);await original.prepare();await relocated.prepare();assert.deepEqual((await relocated.window(0,60,30)).clips[1].keyframes,(await original.window(0,60,30)).clips[1].keyframes);
  assert.deepEqual(await fs.readFile(saved.motionPaths![0].path),await fs.readFile(path.join(moved,'edit.slu-data',path.basename(saved.motionPaths![0].path))));
  // A later regular save retains local media references and collects the newly
  // rebased path from the cache. Moving this saved folder remains portable.
  const reopenedRegistry=new TrackingRegistry();reopenedRegistry.approveProject(opened,true);const again=await saveProjectWithAssets(opened,movedFile,{registry:reopenedRegistry});assert.equal(again.fileReferences!.filter(r=>r.kind==='media'&&r.relativePath).length,2);
  assertProject(again);
});
test('same filename and size with changed bytes cannot authorize tracking relocation',async()=>{
  const {dir,project}=await fixture(),file=path.join(dir,'edit.sluproj');const saved=await saveProjectWithAssets(project,file),replacement=path.join(dir,'replacement.mp4');await fs.writeFile(replacement,Buffer.alloc(5*1024*1024,38));
  const changed=await relocateProjectSources(saved,new Map([[project.media[0].id,replacement]]),path.join(dir,'cache'));
  assert.equal(changed.media[0].path,replacement);assert.equal(changed.motionPaths![0].sourceRevision,project.media[0].sourceRevision);await assert.rejects(new RenderMotion(changed).prepare(),/변경/);
  const identical=path.join(dir,'identical.mp4');await fs.copyFile(project.media[0].path,identical);const matched=await relocateProjectSources(saved,new Map([[project.media[0].id,identical]]),path.join(dir,'cache'));assert.equal(matched.motionPaths![0].sourceRevision,await readSourceRevision(identical));await new RenderMotion(matched).prepare();
});
test('obsolete analysis is never rebased using a refreshed source hash',async()=>{
  const {dir,project}=await fixture();await fs.writeFile(project.media[0].path,Buffer.alloc(5*1024*1024,39));project.media[0].sourceRevision=await readSourceRevision(project.media[0].path);
  const saved=await saveProjectWithAssets(project,path.join(dir,'obsolete.sluproj'),{collect:true});assert.notEqual(saved.motionPaths![0].sourceRevision,saved.media[0].sourceRevision);await assert.rejects(new RenderMotion(saved).prepare(),/추적 원본이 변경/);
});
test('same-header tracking record corruption is rejected by preview registry, saving and export',async()=>{
  const {dir,project}=await fixture(),saved=await saveProjectWithAssets(project,path.join(dir,'edit.sluproj'));
  const file=saved.motionPaths![0].path,buffer=await fs.readFile(file),offset=16+buffer.readUInt32LE(8)+32*30+8;buffer.writeFloatLE(.6,offset);await fs.writeFile(file,buffer);
  const registry=new TrackingRegistry();registry.approveProject(saved,true);await assert.rejects(registry.read(file,1),/내용이 저장 당시와 다릅니다/);await assert.rejects(new RenderMotion(saved).prepare(),/내용이 저장 당시와 다릅니다/);await assert.rejects(saveProjectWithAssets(saved,path.join(dir,'bad.sluproj'),{registry}),/내용이 저장 당시와 다릅니다/);
});
test('copy cancellation and concurrent source replacement preserve the previous project',async()=>{
  for(const mutation of ['cancel','replace']){const {dir,project}=await fixture(),file=path.join(dir,'edit.sluproj');await fs.writeFile(file,'previous complete project');const controller=new AbortController();let triggered=false;
    await assert.rejects(saveProjectWithAssets(project,file,{collect:true,signal:controller.signal,progress:(value,message)=>{if(!triggered&&message.includes('복사 중')){triggered=true;if(mutation==='cancel')controller.abort();else writeFileSync(project.media[0].path,Buffer.alloc(5*1024*1024,41));}}}));
    assert.ok(triggered);assert.equal(await fs.readFile(file,'utf8'),'previous complete project');assert.ok((await fs.readdir(path.join(dir,'edit.slu-data'))).every(n=>!n.endsWith('.tmp')));
  }
});
test('same-basename assets remain distinct and corrupt content-addressed files are never overwritten',async()=>{
  const {dir,project}=await fixture(),other=path.join(dir,'other');await fs.mkdir(other);const sameName=path.join(other,'original.mp4');await fs.writeFile(sameName,'different original');project.media.push({...project.media[0],id:'other',path:sameName,sourceRevision:await readSourceRevision(sameName)});
  const file=path.join(dir,'edit.sluproj'),saved=await saveProjectWithAssets(project,file,{collect:true});assert.notEqual(saved.media[0].path,saved.media[2].path);assert.equal(await fs.readFile(saved.media[2].path,'utf8'),'different original');
  await fs.writeFile(saved.media[0].path,'corrupt existing asset');const again=await saveProjectWithAssets(project,file,{collect:true});assert.notEqual(again.media[0].path,saved.media[0].path);assert.equal(await fs.readFile(saved.media[0].path,'utf8'),'corrupt existing asset');assert.equal((await fs.stat(again.media[0].path)).size,5*1024*1024);
});
test('relative path validation and junction containment cannot escape the project folder',async()=>{
  const {dir,project}=await fixture(),file=path.join(dir,'edit.sluproj'),saved=await saveProjectWithAssets(project,file);
  for(const value of ['../outside','/absolute','a\\b','C:/outside','a//b','a/../b','a/NUL.mp4','a/end.']){const invalid=structuredClone(saved);invalid.fileReferences![0].relativePath=value;assert.throws(()=>assertProject(invalid));}
  const outside=await fs.mkdtemp(path.join(root,'outside-'));await fs.writeFile(path.join(outside,'video.mp4'),'outside');await fs.symlink(outside,path.join(dir,'junction'),process.platform==='win32'?'junction':'dir');await assert.rejects(relativeAsset(file,'junction/video.mp4'),/폴더 밖/);
  const pruned=reconcileMotion(saved,{...saved,clips:[],motionPaths:undefined,media:[]});assert.equal(pruned.fileReferences,undefined);assertProject(pruned);
});
test('hash cache detects same-length replacements and file changes during streamed reads',async()=>{
  const {project}=await fixture(),file=project.media[0].path,cache=new FileDigests(),first=await cache.read(file);assert.deepEqual(await cache.read(file),first);
  await fs.writeFile(file,Buffer.alloc(5*1024*1024,42));const second=await cache.read(file);assert.notEqual(first.sha256,second.sha256);assert.notEqual(first.revision,second.revision);
  let changed=false;await assert.rejects(cache.read(file,undefined,()=>{if(!changed){changed=true;writeFileSync(file,Buffer.alloc(5*1024*1024,43));}},true),/변경/);
});
test('exclusive publication on filesystems without hard links verifies complete copies and never replaces an existing file',async()=>{
  const {dir,project}=await fixture(),source=project.media[0].path,destination=path.join(dir,'published.mp4'),originalLink=fs.link;
  fs.link=async()=>{throw Object.assign(new Error('No hard links on this drive'),{code:'ENOTSUP'});};
  try{
    await publishAsset(source,destination);assert.deepEqual(await fs.readFile(destination),await fs.readFile(source));
    await fs.writeFile(destination,'do not replace');await assert.rejects(publishAsset(source,destination),{code:'EEXIST'});assert.equal(await fs.readFile(destination,'utf8'),'do not replace');
    const aborted=new AbortController();fs.link=async()=>{aborted.abort();throw Object.assign(new Error('No hard links'),{code:'ENOTSUP'});};
    const incomplete=path.join(dir,'cancelled-copy.mp4');await assert.rejects(publishAsset(source,incomplete,aborted.signal),{name:'AbortError'});await assert.rejects(fs.stat(incomplete),{code:'ENOENT'});
  }finally{fs.link=originalLink;}
});
test('saving through a project directory alias writes contained relative references',async()=>{
  const {dir,project}=await fixture(),actual=path.join(dir,'actual');await fs.mkdir(actual);const alias=path.join(dir,'alias');await fs.symlink(actual,alias,process.platform==='win32'?'junction':'dir');
  const file=path.join(alias,'edit.sluproj'),saved=await saveProjectWithAssets(project,file,{collect:true});assert.ok(saved.fileReferences!.every(r=>r.relativePath?.startsWith('edit.slu-data/')));const opened=await resolveProjectAssets(await readProject(file),file,path.join(dir,'cache'));await new RenderMotion(opened).prepare();
});
test('ordinary offline save preserves edits and warns about missing tracking; collection refuses an incomplete bundle',async()=>{
  const {dir,project,registry,analysis}=await fixture(),file=path.join(dir,'offline.sluproj');await fs.rename(analysis.path,analysis.path+'.offline');const warnings:string[]=[];
  const saved=await saveProjectWithAssets({...project,name:'offline edits'},file,{registry,warning:message=>warnings.push(message)});assert.equal(warnings.length,1);assert.equal(saved.name,'offline edits');assert.deepEqual(saved.motionPaths,project.motionPaths);const previous=await fs.readFile(file);
  await assert.rejects(saveProjectWithAssets(project,file,{registry,collect:true}),{code:'ENOENT'});assert.deepEqual(await fs.readFile(file),previous);
});
test('project relocation rejects relative and network source paths before filesystem reads',async()=>{
  const {dir,project}=await fixture();for(const name of ['relative.mp4','\\\\server\\share\\source.mp4','https://example.com/source.mp4']){
    const invalid=structuredClone(project);invalid.media[0].path=name;await assert.rejects(resolveProjectAssets(invalid,path.join(dir,'edit.sluproj'),path.join(dir,'cache')),/로컬 파일의 절대 경로/);
    await assert.rejects(relocateProjectSources(project,new Map([[project.media[0].id,name]]),path.join(dir,'cache')),/로컬 원본 파일/);
  }
});

test('an offline analysis preserves source proof through two moves and saves, then restores exact motion from a backup',async()=>{
  const {dir,project,registry}=await fixture(),file=path.join(dir,'edit.sluproj'),saved=await saveProjectWithAssets(project,file,{registry});
  const backup=path.join(dir,'backup.slutrack');await fs.rename(saved.motionPaths![0].path,backup);
  let offline=saved;
  for(let i=0;i<2;i++){
    const replacement=path.join(dir,`source-moved-${i}.mp4`);await fs.copyFile(project.media[0].path,replacement);
    offline=await relocateProjectSources(offline,new Map([[project.media[0].id,replacement]]),path.join(dir,'cache'));
    assert.equal(offline.motionPaths![0].sourceRevision,project.media[0].sourceRevision);
    offline=await saveProjectWithAssets(offline,file);assert.equal(offline.fileReferences!.find(r=>r.kind==='tracking')!.source!.revision,project.media[0].sourceRevision);
  }
  const before=JSON.stringify(offline),target=planTrackingReconnect(offline,'target'),result=await reconnectTrackingFile(offline,offline.motionPaths![0].id,backup,path.join(dir,'repaired'));
  assert.equal(JSON.stringify(offline),before);assert.equal(result.analysis.sourceRevision,offline.media[0].sourceRevision);assert.notEqual(result.analysis.path,backup);
  const repaired=applyTrackingReconnect({...offline,name:'unrelated edits',tracks:offline.tracks.map(t=>({...t,locked:true})),clips:offline.clips.map(c=>c.id==='target'?{...c,name:'edited while locating'}:c)},target,result);
  assert.equal(repaired.name,'unrelated edits');assert.equal(repaired.clips.find(c=>c.id==='target')!.name,'edited while locating');assert.ok(repaired.tracks.every(t=>t.locked));
  const original=new RenderMotion(project),restored=new RenderMotion(repaired);await original.prepare();await restored.prepare();assert.deepEqual((await restored.window(0,60,30)).clips.map(c=>c.keyframes),(await original.window(0,60,30)).clips.map(c=>c.keyframes));
  const durable=await saveProjectWithAssets(repaired,file),opened=await resolveProjectAssets(await readProject(file),file,path.join(dir,'cache'));assert.equal(opened.motionPaths![0].sourceRevision,opened.media[0].sourceRevision);await new RenderMotion(opened).prepare();assert.equal(durable.fileReferences!.find(r=>r.kind==='tracking')!.source!.sha256,saved.fileReferences!.find(r=>r.kind==='tracking')!.source!.sha256);
});

test('restoring the old artifact in place after an offline source move is rebased on the next project open',async()=>{
  const {dir,project}=await fixture(),file=path.join(dir,'edit.sluproj'),saved=await saveProjectWithAssets(project,file),analysis=saved.motionPaths![0],backup=analysis.path+'.backup';await fs.rename(analysis.path,backup);
  const source=path.join(dir,'moved.mp4');await fs.copyFile(project.media[0].path,source);const moved=await relocateProjectSources(saved,new Map([[project.media[0].id,source]]),path.join(dir,'cache'));
  await saveProjectWithAssets(moved,file);await fs.copyFile(backup,analysis.path);const restored=await resolveProjectAssets(await readProject(file),file,path.join(dir,'cache'));
  assert.equal(restored.motionPaths![0].sourceRevision,restored.media[0].sourceRevision);await new RenderMotion(restored).prepare();
});

test('reconnection rejects changed records, different source bytes and unavailable identity without changing project or candidate',async()=>{
  const {dir,project}=await fixture(),saved=await saveProjectWithAssets(project,path.join(dir,'edit.sluproj')),analysis=saved.motionPaths![0],bad=path.join(dir,'bad.slutrack');
  const bytes=await fs.readFile(analysis.path),corrupt=Buffer.from(bytes),offset=16+bytes.readUInt32LE(8)+32*30+8;corrupt.writeFloatLE(.6,offset);await fs.writeFile(bad,corrupt);
  const before=JSON.stringify(saved);await assert.rejects(reconnectTrackingFile(saved,analysis.id,bad,path.join(dir,'cache')),/내용이 저장 당시와 다릅니다/);assert.equal(JSON.stringify(saved),before);assert.deepEqual(await fs.readFile(bad),corrupt);
  const wrong=path.join(dir,'same-size.mp4');await fs.writeFile(wrong,Buffer.alloc(5*1024*1024,52));const changed={...saved,media:saved.media.map((m,i)=>i===0?{...m,path:wrong}:m)};changed.media[0].sourceRevision=await readSourceRevision(wrong);
  await assert.rejects(reconnectTrackingFile(changed,analysis.id,analysis.path,path.join(dir,'cache')),/추적 당시의 파일과 다릅니다/);
  await assert.rejects(reconnectTrackingFile({...project,fileReferences:undefined},analysis.id,analysis.path,path.join(dir,'cache')),/확인 정보가 없습니다/);
  for(const candidate of ['relative.slutrack','\\\\server\\share\\track.slutrack'])await assert.rejects(reconnectTrackingFile(saved,analysis.id,candidate,path.join(dir,'cache')),/로컬 추적/);
});

test('a corrupt moved artifact leaves the project openable and can be replaced from its verified backup',async()=>{
  const {dir,project}=await fixture(),saved=await saveProjectWithAssets(project,path.join(dir,'edit.sluproj')),analysis=saved.motionPaths![0],backup=path.join(dir,'good.slutrack');await fs.copyFile(analysis.path,backup);await fs.writeFile(analysis.path,'broken');
  const source=path.join(dir,'moved.mp4');await fs.copyFile(project.media[0].path,source);const opened=await relocateProjectSources(saved,new Map([[project.media[0].id,source]]),path.join(dir,'cache'));assert.equal(opened.motionPaths![0].sourceRevision,analysis.sourceRevision);
  const repaired=applyTrackingReconnect(opened,planTrackingReconnect(opened,'target'),await reconnectTrackingFile(opened,analysis.id,backup,path.join(dir,'repaired')));await new RenderMotion(repaired).prepare();assert.equal(await fs.readFile(analysis.path,'utf8'),'broken');
});

test('native registration retains artifact identity for a first offline save, and artifact recovery can precede source recovery',async()=>{
  const {dir,project,registry,analysis}=await fixture(),backup=path.join(dir,'backup.slutrack');await fs.rename(analysis.path,backup);
  const saved=await saveProjectWithAssets(project,path.join(dir,'offline.sluproj'),{registry}),ref=saved.fileReferences!.find(r=>r.kind==='tracking')!;assert.ok(ref.sha256&&ref.source);
  const original=project.media[0].path;await fs.rename(original,original+'.offline');
  const repaired=applyTrackingReconnect(saved,planTrackingReconnect(saved,'target'),await reconnectTrackingFile(saved,analysis.id,backup,path.join(dir,'repaired')));assert.equal(repaired.motionPaths![0].sourceRevision,analysis.sourceRevision);
  const replacement=path.join(dir,'restored.mp4');await fs.copyFile(original+'.offline',replacement);const ready=await relocateProjectSources(repaired,new Map([[project.media[0].id,replacement]]),path.join(dir,'cache'));await new RenderMotion(ready).prepare();
});

test('cancelled or source-mutated reconnection removes owned work without publishing a result',async()=>{
  for(const mode of ['cancel','source']){
    const {dir,project}=await fixture(),saved=await saveProjectWithAssets(project,path.join(dir,'edit.sluproj')),destination=path.join(dir,'repaired'),controller=new AbortController();let triggered=false;
    await assert.rejects(reconnectTrackingFile(saved,saved.motionPaths![0].id,saved.motionPaths![0].path,destination,{signal:controller.signal,progress:(_p,message)=>{if(!triggered&&message==='추적 파일 복원 중'){triggered=true;if(mode==='cancel')controller.abort();else writeFileSync(project.media[0].path,Buffer.alloc(5*1024*1024,53));}}}),mode==='cancel'?{name:'AbortError'}:/변경/);
    assert.ok(triggered);assert.deepEqual(await fs.readdir(destination),[]);
  }
});

test('tracking source proof is validated and pinned by the registry; stale async recovery never changes a new target',async()=>{
  const {dir,project}=await fixture(),saved=await saveProjectWithAssets(project,path.join(dir,'edit.sluproj')),registry=new TrackingRegistry();registry.approveProject(saved,true);
  const changed=structuredClone(saved),ref=changed.fileReferences!.find(r=>r.kind==='tracking')!;ref.source!.sha256='a'.repeat(64);assert.throws(()=>registry.approveProject(changed),/등록되지 않았거나 변경/);
  ref.source!.revision='b'.repeat(64);assert.throws(()=>assertProject(changed),/원본 확인/);
  const malformed=structuredClone(saved);malformed.fileReferences!.find(r=>r.kind==='media')!.source=structuredClone(saved.fileReferences!.find(r=>r.kind==='tracking')!.source);assert.throws(()=>assertProject(malformed),/원본 확인/);
  const target=planTrackingReconnect(saved,'target'),result=await reconnectTrackingFile(saved,target.analysis.id,target.analysis.path,path.join(dir,'repaired'));
  for(const invalid of [{...saved,id:'new-session'}, {...saved,media:saved.media.map((m,i)=>i===0?{...m,sourceRevision:'a'.repeat(64)}:m)}, {...saved,clips:saved.clips.map(c=>c.id==='target'?{...c,motionBinding:undefined}:c)}, {...saved,fileReferences:undefined}])assert.throws(()=>applyTrackingReconnect(invalid,target,result),/변경되어 적용하지/);
  assert.throws(()=>applyTrackingReconnect(saved,target,{...result,analysis:{...result.analysis,frames:1}}),/기존 연결과 다릅니다/);
});

test('legacy source proof comes from approved project metadata, never a later forged media reference',async()=>{
  const {dir,project}=await fixture(),saved=await saveProjectWithAssets(project,path.join(dir,'edit.sluproj'));delete saved.fileReferences!.find(r=>r.kind==='tracking')!.source;
  const registry=new TrackingRegistry();registry.approveProject(saved,true);const analysis=saved.motionPaths![0],originalProof=registry.referenceFor(analysis)!.source!;
  const wrong=path.join(dir,'wrong.mp4');await fs.writeFile(wrong,Buffer.alloc(5*1024*1024,54));const fake=structuredClone(saved);fake.media[0].path=wrong;fake.media[0].sourceRevision=await readSourceRevision(wrong);
  const digest=await new FileDigests().read(wrong),sourceRef=fake.fileReferences!.find(r=>r.kind==='media'&&r.id===analysis.mediaId)!;sourceRef.sha256=digest.sha256;sourceRef.bytes=digest.bytes;sourceRef.revision=analysis.sourceRevision;
  registry.approveProject(fake);assert.deepEqual(registry.referenceFor(analysis)!.source,originalProof);
  await assert.rejects(reconnectTrackingFile(fake,analysis.id,analysis.path,path.join(dir,'repair'),{registry}),/추적 당시의 파일과 다릅니다/);
  const offlineBackup=analysis.path+'.backup';await fs.rename(analysis.path,offlineBackup);const written=await saveProjectWithAssets(fake,path.join(dir,'offline.sluproj'),{registry});assert.deepEqual(written.fileReferences!.find(r=>r.kind==='tracking')!.source,originalProof);
  const other=structuredClone(saved);other.fileReferences=undefined;other.motionPaths![0].id='unrelated-analysis';for(const c of other.clips)if(c.motionBinding)c.motionBinding.analysisId='unrelated-analysis';registry.approveProject(other,true);assert.equal(registry.referenceFor(other.motionPaths![0]),undefined,'A new analysis at the same path must not inherit the old artifact/source proof');
});
