import {launchTestElectron,electronTestArgs,captureElectron} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {BUILD_RECEIPT_PATH,validatePackagedBuild} from './build-receipt.mjs';
import {newProject,newClip} from '../shared/project.ts';
import {assertProject} from '../shared/validation.ts';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';

const legacy=process.argv.includes('--expect-legacy-overflow');
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const root=path.resolve('.test-artifacts/track-limit-regression',`${legacy?'legacy':'fixed'}-${Date.now()}`);
await fs.mkdir(root,{recursive:true});
const pointer=path.resolve(`.test-artifacts/track-limit-regression-current-${executable?'packaged':'source'}.txt`);
if(!legacy)await fs.rm(pointer,{force:true});
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const scriptFile=path.resolve('scripts/e2e-track-limit.mjs'),scriptSha256=await hash(scriptFile);
let legacyBuild,normalEvidence,result;
if(legacy){
  assert.ok(executable,'Legacy reproduction requires the immutable packaged executable');
  const asarFile=path.join(path.dirname(executable),'resources/app.asar');
  const asar=createRequire(import.meta.url)('@electron/asar');
  const receipt=JSON.parse(asar.extractFile(asarFile,BUILD_RECEIPT_PATH).toString('utf8'));
  await validatePackagedBuild(asarFile,receipt);
  assert.equal(receipt.version,'1.10.0');
  const exeSha256=await hash(executable),asarSha256=await hash(asarFile);
  assert.equal(exeSha256,'6ff96ee21f68cf3cc9878905cf387f66bc7c2b5f233c296182108c3df54198cd');
  assert.equal(asarSha256,'d7f54d8b3de741b045edefa15dc0c477a9be56480ce9f09d3a58e0533b275501');
  legacyBuild={version:receipt.version,buildReceiptId:receipt.contentId,executable,exeSha256,asarSha256};
}else normalEvidence=await import('./e2e-release-evidence.mjs');

const run=promisify(execFile),video=path.join(root,'source.mp4'),audio=path.join(root,'source.wav'),image=path.join(root,'source.png');
await run(path.resolve('resources/bin/ffmpeg.exe'),[
  '-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=s=96x64:r=10:d=1',
  '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1',
  '-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-shortest',video,
],{windowsHide:true,timeout:30000});
await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-y','-i',video,'-vn','-c:a','pcm_s16le',audio],{windowsHide:true,timeout:30000});
await run(path.resolve('resources/bin/ffmpeg.exe'),['-v','error','-nostdin','-y','-i',video,'-frames:v','1',image],{windowsHide:true,timeout:30000});

const env={...process.env,SLU_USER_DATA:path.join(root,'profile'),SLU_TEST_BACKGROUND:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(executable?{executablePath:executable,args:electronTestArgs(true)}:{args:electronTestArgs()}),env,timeout:90000});
const page=await app.firstWindow(),checks=[],observations=[],errors=[];
page.on('pageerror',error=>errors.push(String(error)));
const current=()=>page.evaluate(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project);
const editState=project=>{
  // Background analysis and saving can refresh media/cache and file references.
  const {media,updatedAt,fileReferences,...state}=project;
  return {...state,mediaIds:media.map(asset=>asset.id)};
};
async function openProject(project,name){
  assertProject(project);
  const file=path.join(root,`${name}.sluproj`);
  await fs.writeFile(file,JSON.stringify(project));
  await dismissToasts(page);
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
  await page.keyboard.press('Control+o');
  await page.waitForFunction(id=>document.querySelector('.preview-gpu-stage')?.previewRuntime.project.id===id,project.id);
  await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();
  await dismissToasts(page);
  await page.getByRole('button',{name:'미디어',exact:true}).first().click();
  await page.getByRole('button',{name:'프로그램',exact:true}).click();
}
async function saveSnapshot(project,name){
  const file=path.join(root,`${name}-saved.sluproj`);
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},file);
  const response=await page.evaluate(async project=>{
    try{return {path:await window.studio.saveProject(project,undefined,true)};}
    catch(error){return {error:String(error)};}
  },project);
  await fs.writeFile(path.join(root,`${name}-save-response.json`),JSON.stringify(response,null,2));
  if(response.error)return response;
  assert.equal(response.path,file);
  const persisted=JSON.parse(await fs.readFile(file,'utf8'));
  assertProject(persisted);
  assert.deepEqual(editState(persisted),JSON.parse(JSON.stringify(editState(project))));
  return response;
}
async function selectClip(id){
  await page.getByRole('button',{name:'프로그램',exact:true}).click();
  const trackId=(await current()).clips.find(clip=>clip.id===id).trackId;
  await page.locator(`[data-track-id="${trackId}"]`).scrollIntoViewIfNeeded();
  const target=page.locator(`[data-clip-id="${id}"]`);
  await target.focus();
  await target.press('Enter');
}
const operations=[
  {name:'addMedia-video',action:'media',kind:'video',trackType:'video'},
  {name:'addMedia-audio',action:'media',kind:'audio',trackType:'audio'},
  {name:'addMedia-image',action:'media',kind:'image',trackType:'video'},
  ...['insert','overwrite','append'].map(mode=>({name:`addSourceRange-${mode}`,action:'range',mode,kind:'video',trackType:'video'})),
  {name:'legacy-addText',action:'text',trackType:'text'},
  {name:'detachAudio',action:'detach',kind:'video',trackType:'audio'},
];
function fixture(operation,count,eligible,assets){
  const p=newProject();
  if(legacy)p.version=9;
  p.id=`${operation.name}-${count}-${eligible}`;p.name=p.id;p.width=96;p.height=64;p.fps=10;p.media=assets;
  const other=operation.trackType==='video'?'text':'video';
  p.tracks=Array.from({length:count},(_,i)=>({id:`track-${i}`,name:`Track ${i}`,type:other,muted:false,hidden:false,locked:false}));
  // A locked track of the requested type must not count as eligible.
  p.tracks[0]={...p.tracks[0],type:operation.trackType,locked:true};
  if(eligible)p.tracks[1]={...p.tracks[1],type:operation.trackType};
  p.clips=[];
  if(operation.action==='range')p.clips=[{...newClip(p.tracks[0].id,assets.find(a=>a.kind==='video')),id:'locked-source',start:0,duration:.5}];
  if(operation.action==='detach'){
    p.tracks[2]={...p.tracks[2],type:'video'};
    p.clips=[{...newClip(p.tracks[2].id,assets.find(a=>a.kind==='video')),id:'detach-source',start:0,duration:.5,volume:.65}];
  }
  return p;
}
async function invoke(operation,assets){
  const asset=assets.find(a=>a.kind===operation.kind);
  if(operation.action==='media')await page.getByTitle(`${asset.name} 타임라인에 추가`,{exact:true}).click();
  if(operation.action==='range'){
    await selectClip('locked-source');
    await page.getByRole('button',{name:`${asset.name} 소스 열기`,exact:true}).click();
    await page.getByLabel('소스 시작점',{exact:true}).fill('0.2');
    await page.getByLabel('소스 끝점',{exact:true}).fill('0.7');
    const title={insert:'플레이헤드에 삽입하고 뒤 클립 밀기',overwrite:'플레이헤드 위치의 기존 구간 대체',append:'트랙 끝에 추가'}[operation.mode];
    await page.getByTitle(title,{exact:true}).click();
  }
  if(operation.action==='text'){
    await page.getByRole('button',{name:'텍스트',exact:true}).first().click();
    await page.getByRole('button',{name:'텍스트 추가',exact:true}).click();
  }
  if(operation.action==='detach'){
    await selectClip('detach-source');
    const section=page.locator('.inspector').getByRole('button',{name:'미디어',exact:true});
    if(await section.getAttribute('aria-expanded')==='false')await section.click();
    await page.getByRole('button',{name:'오디오 분리',exact:true}).click();
  }
}

let evidence;
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
  const runtime=await app.evaluate(({app,BrowserWindow})=>({version:app.getVersion(),packaged:app.isPackaged,executable:process.execPath,hidden:BrowserWindow.getAllWindows().every(w=>!w.isVisible())}));
  assert.equal(runtime.hidden,true);
  if(legacy){assert.equal(runtime.version,'1.10.0');assert.equal(runtime.packaged,true);assert.equal(path.resolve(runtime.executable),executable);}
  else assert.equal(runtime.version,JSON.parse(await fs.readFile('package.json','utf8')).version);
  const assets=await page.evaluate(files=>window.studio.importMedia(files),[video,audio,image]);
  assert.equal(assets.length,3);assert.equal(assets.find(a=>a.kind==='video').hasAudio,true);
  for(const operation of operations){
    const scenarios=legacy?[{count:100,eligible:false}]:[{count:100,eligible:false},{count:99,eligible:false},{count:100,eligible:true}];
    for(const scenario of scenarios){
      const p=fixture(operation,scenario.count,scenario.eligible,assets),name=p.id;
      await openProject(p,name);
      const before=await current();
      await invoke(operation,assets);
      if(!legacy&&scenario.count===100&&!scenario.eligible)await page.getByText('프로젝트당 최대 100개 트랙을 지원합니다.',{exact:true}).waitFor();
      else await page.waitForFunction(count=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips.length===count,before.clips.length+1);
      const after=await current();
      if(legacy){
        assert.equal(after.tracks.length,101);
        const saving=await saveSnapshot(after,name);
        assert.match(saving.error||'',/프로젝트/);
        observations.push({case:name,tracksBefore:100,tracksAfter:after.tracks.length,saveRejected:saving.error,sourceVolumeBefore:before.clips.find(c=>c.id==='detach-source')?.volume,sourceVolumeAfter:after.clips.find(c=>c.id==='detach-source')?.volume});
        await fs.writeFile(path.join(root,`${name}-overflow.json`),JSON.stringify(after,null,2));
      }else{
        assert.equal(after.tracks.length,100);
        if(scenario.count===100&&!scenario.eligible)assert.deepEqual(editState(after),editState(before));
        else{
          const added=after.clips.filter(c=>!before.clips.some(old=>old.id===c.id));
          assert.equal(added.length,1);
          assert.equal(after.tracks.find(t=>t.id===added[0].trackId).locked,false);
          if(scenario.eligible)assert.equal(added[0].trackId,'track-1');
          else assert.ok(!before.tracks.some(t=>t.id===added[0].trackId));
          if(operation.action==='range'){
            assert.equal(added[0].in,.2);assert.ok(Math.abs(added[0].duration-.5)<1e-9);
            assert.deepEqual(after.clips.find(c=>c.id==='locked-source'),before.clips.find(c=>c.id==='locked-source'));
          }
          if(operation.action==='detach')assert.equal(after.clips.find(c=>c.id==='detach-source').volume,0);
        }
        assert.ok(!(await saveSnapshot(after,name)).error);
        checks.push(`${name}: correct track count, locked candidate preserved and project remains saveable`);
      }
      console.log(JSON.stringify({case:name,legacy,tracks:after.tracks.length}));
    }
  }
  if(!legacy){
    // A direct drop onto a locked track must not redirect or create a track.
    for(const count of [99,100]){
      const p=fixture(operations[0],count,true,assets);p.id=`locked-drop-${count}`;
      await openProject(p,p.id);const before=await current();
      const data=await page.evaluateHandle(id=>{const transfer=new DataTransfer();transfer.setData('application/slu-media',id);return transfer;},assets.find(a=>a.kind==='video').id);
      await page.locator('[data-track-id="track-0"]').dispatchEvent('drop',{dataTransfer:data});
      await data.dispose();await page.waitForTimeout(150);
      const after=await current();assert.deepEqual(editState(after),editState(before));assert.ok(!(await saveSnapshot(after,p.id)).error);
      checks.push(`${p.id}: locked drop does not mutate the project or create a track`);
    }
    const operation=operations.find(o=>o.action==='detach'),p=fixture(operation,100,true,assets);p.id='locked-detach';p.tracks[2].locked=true;
    await openProject(p,p.id);await selectClip('detach-source');const before=await current();
    await page.locator('[data-clip-id="detach-source"]').click({button:'right'});
    await page.getByRole('menuitem',{name:'오디오 분리',exact:true}).click();
    const after=await current();assert.deepEqual(editState(after),editState(before));assert.ok(!(await saveSnapshot(after,p.id)).error);
    checks.push('locked-detach: original source volume and all edits remain unchanged');
  }
  assert.deepEqual(errors,[]);
  assert.equal(await hash(scriptFile),scriptSha256);
  if(legacy){
    assert.equal(await hash(executable),legacyBuild.exeSha256);
    assert.equal(await hash(path.join(path.dirname(executable),'resources/app.asar')),legacyBuild.asarSha256);
    evidence={...legacyBuild,runtime,scriptSha256};
  }else evidence=await normalEvidence.editorEvidence(app,import.meta.url);
  await captureElectron(app,{path:path.join(root,'final.png')});
  result={root,mode:legacy?'legacy-expected-failure':'fixed-regression',passed:!legacy,legacyFailureReproduced:legacy,checks,observations,errors,...evidence};
}catch(error){
  await captureElectron(app,{path:path.join(root,'failure.png')}).catch(()=>{});
  await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({root,legacy,checks,observations,errors,error:String(error),project:await current().catch(()=>null),evidence},null,2));
  throw error;
}finally{await app.close();}
await fs.writeFile(path.join(root,'results.json'),JSON.stringify({...result,completedAt:new Date().toISOString()},null,2));
if(!legacy)await fs.writeFile(pointer,root+'\n');
console.log(JSON.stringify({root,mode:result.mode,passed:!legacy,checks:checks.length,reproducedFailures:observations.length,errors}));
