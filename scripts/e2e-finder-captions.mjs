// Run inside scripts/quiet-desktop.mjs's owned desktop, with node --import tsx.
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {newClip,newProject} from '../shared/project.ts';
import {defaultCaptionStyle} from '../shared/captions.ts';
import {assertProject} from '../shared/validation.ts';
import {formatProgramTimecode} from '../src/preview/program-timecode.ts';
import {launchTestElectron,electronTestArgs,assertQuietDialogs,captureElectron} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';

const development=process.env.SLU_TEST_DEVELOPMENT==='1';
assert.ok(!process.env.SLU_DEV_URL,'This suite verifies the built renderer, never a development server');
const proof=development?undefined:await import('./e2e-release-evidence.mjs');
const root=path.resolve('.test-artifacts/finder-captions-ui');await fs.mkdir(root,{recursive:true});
const work=await fs.mkdtemp(path.join(root,development?'development-':'verified-')),profile=path.join(work,'profile');
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const env={...process.env,SLU_USER_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({...(executable?{executablePath:executable}:{}),args:electronTestArgs(!!executable),env,timeout:90000});
const page=await app.firstWindow(),checks=[],errors=[];page.on('pageerror',error=>errors.push(String(error)));
const state=()=>page.evaluate(()=>structuredClone(document.querySelector('.preview-gpu-stage').previewRuntime.project));
const finder=()=>page.getByRole('combobox',{name:'클립, 자막, 트랙 또는 시작 시간 검색',exact:true});
let evidence;
async function open(project,name){
  assertProject(project);const file=path.join(work,`${name}.sluproj`);await fs.writeFile(file,JSON.stringify(project));
  await dismissToasts(page);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
  await page.getByRole('button',{name:'프로그램',exact:true}).click();await page.keyboard.press('Control+o');
  await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();
  await page.waitForFunction(id=>document.querySelector('.preview-gpu-stage').previewRuntime.project.id===id,project.id);
  await dismissToasts(page);
}
async function find(query){await page.getByRole('button',{name:'클립 찾기',exact:true}).click();await finder().fill(query);}
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,720));
  evidence=proof?await proof.editorEvidence(app,import.meta.url):{scope:'Development regression against current built renderer; no release build receipt claim',version:JSON.parse(await fs.readFile('package.json','utf8')).version};
  const tracks=Array.from({length:24},(_,index)=>({id:`find-track-${index}`,name:`찾기 트랙 ${index+1}`,type:'text',locked:index===0,hidden:index===0,muted:false}));
  const clips=Array.from({length:3000},(_,index)=>({...newClip(tracks[index%24].id),id:`find-${index}`,name:`장면 ${index}`,text:`내용 ${index}`,start:index,duration:1}));
  clips[0]={...clips[0],trackId:tracks[23].id,name:'중복 장면'};clips[2999]={...clips[2999],trackId:tracks[0].id,name:'중복 장면'};
  const fixture={...newProject(),id:'finder-large',name:'찾기 회귀',width:640,height:360,fps:30,media:[],tracks,clips};
  await open(fixture,'large');
  await page.getByRole('button',{name:'프로그램',exact:true}).click();await page.keyboard.press('Control+f');assert.equal(await finder().count(),0,'Ctrl+F outside the timeline must not open the finder');
  await page.locator('.timeline-footer').click();await page.keyboard.press('Control+f');await finder().waitFor();await finder().fill('중복 장면');
  await page.getByText('2개 결과',{exact:true}).waitFor();assert.equal(await page.getByRole('listbox',{name:'클립 검색 결과',exact:true}).getByRole('option').count(),2);
  const options=await page.getByRole('listbox',{name:'클립 검색 결과',exact:true}).getByRole('option').allTextContents();assert.ok(options[0].includes('트랙 1'));assert.ok(options[1].includes('트랙 24'));assert.ok(options[1].includes('잠김'));assert.ok(options[1].includes('숨김'));
  await finder().press('ArrowDown');await finder().press('Enter');
  const target=page.locator('[data-clip-id="find-2999"]');await target.waitFor();assert.equal(await target.getAttribute('aria-pressed'),'true');
  const revealed=await target.evaluate(element=>{const rect=element.getBoundingClientRect(),viewport=element.closest('.timeline-scroll').getBoundingClientRect();return {rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},viewport:{x:viewport.x,y:viewport.y,width:viewport.width,height:viewport.height},focused:document.activeElement===element};});
  assert.ok(revealed.rect.x>=revealed.viewport.x+170&&revealed.rect.x<revealed.viewport.x+revealed.viewport.width);assert.ok(revealed.rect.y>=revealed.viewport.y+29&&revealed.rect.y+revealed.rect.height<=revealed.viewport.y+revealed.viewport.height);assert.equal(revealed.focused,true);
  assert.equal((await state()).tracks.find(track=>track.id===tracks[0].id).locked,true);
  checks.push('Scoped Ctrl+F finds duplicate names across 3,000 clips and reveals, highlights and focuses a locked/hidden offscreen clip at minimum window size without changing its track');
  await find('중복 장면');await finder().press('Enter');
  await find('중복 장면');await finder().press('ArrowDown');await finder().press('Shift+Enter');
  assert.deepEqual(await page.evaluate(()=>[...document.querySelector('.preview-gpu-stage').previewRuntime.selected].sort()),['find-0','find-2999']);
  await find('중복 장면');await page.getByRole('listbox',{name:'클립 검색 결과',exact:true}).getByRole('option').nth(1).click({modifiers:['Shift']});
  assert.deepEqual(await page.evaluate(()=>[...document.querySelector('.preview-gpu-stage').previewRuntime.selected].sort()),['find-0','find-2999']);
  checks.push('Shift+Enter and Shift+click accumulate same-name clips across tracks without losing or duplicating prior selections');
  await find(formatProgramTimecode(2999,30));await page.getByText('1개 결과',{exact:true}).waitFor();await finder().press('Escape');assert.equal(await finder().count(),0);
  await find('2999초');await page.getByText('1개 결과',{exact:true}).waitFor();await finder().press('Escape');
  await find('트랙 24');const trackCount=clips.filter(clip=>clip.trackId===tracks[0].id).length;await page.getByText(`${trackCount}개 결과`,{exact:true}).waitFor();assert.ok(await page.getByRole('listbox',{name:'클립 검색 결과',exact:true}).getByRole('option').count()<=10);await finder().press('Escape');
  await find('없는 검색어');await page.getByText('0개 결과',{exact:true}).waitFor();await finder().press('Enter');assert.equal(await finder().count(),1);await finder().press('Escape');
  checks.push('Exact shared timecode, seconds and track-number lookup work; result rows remain bounded and empty results do not change selection');

  await find('장면');await page.getByText('3000개 결과',{exact:true}).waitFor();
  await finder().evaluate(input=>{globalThis.__finderLatency=[];input.addEventListener('input',()=>{const query=input.value,started=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>globalThis.__finderLatency.push({query,milliseconds:performance.now()-started,rows:document.querySelectorAll('.timeline-find-result').length,result:document.querySelector('.timeline-find-count')?.textContent})));});});
  const queries=['장면 2900','중복 장면','없는 검색어','장면','찾기 트랙 1','장면 2998'];
  for(const query of queries){await finder().fill(query);await page.waitForFunction(query=>globalThis.__finderLatency?.at(-1)?.query===query,query);}
  const samples=await page.evaluate(()=>globalThis.__finderLatency);assert.equal(samples.length,queries.length);assert.ok(samples.every(sample=>sample.rows<=10));
  await finder().press('Escape');
  const idle=await page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));let mutations=0,finderMutations=0;const selector='.timeline-clip-finder,.timeline-find-result',related=node=>node instanceof Element&&(node.matches(selector)||node.closest(selector)||node.querySelector(selector));const observer=new MutationObserver(records=>{mutations+=records.length;finderMutations+=records.filter(record=>related(record.target)||[...record.addedNodes,...record.removedNodes].some(related)).length;});observer.observe(document.querySelector('.timeline-panel'),{childList:true,subtree:true,attributes:true,characterData:true});await new Promise(resolve=>setTimeout(resolve,300));observer.disconnect();return {mutations,finderMutations,finderNodes:document.querySelectorAll(selector).length};});
  assert.equal(idle.finderNodes,0);assert.equal(idle.finderMutations,0);
  const milliseconds=samples.map(sample=>sample.milliseconds).sort((a,b)=>a-b),performanceSample={clips:3000,tracks:24,window:[1100,720],samples,medianMilliseconds:milliseconds[Math.floor(milliseconds.length/2)],maximumMilliseconds:milliseconds.at(-1),idle,scope:'Input event to two animation frames on a private desktop using UI-correctness launch flags; a small responsiveness sample, not playback/export FPS or an OS-controlled benchmark. Closed finder is unmounted with no finder-related mutations over 300 ms; unrelated timeline mutations are retained as diagnostics.'};
  checks.push('A six-query responsiveness sample has bounded result DOM; closing unmounts the finder and its search memo, with no finder-related mutations');
  const divider=page.getByRole('separator',{name:'타임라인 높이 조절',exact:true}),handle=await divider.boundingBox();await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2,8,{steps:4});await page.mouse.up();
  await find('장면');await page.getByText('3000개 결과',{exact:true}).waitFor();
  const compact=await finder().evaluate(input=>{
    const popupElement=input.closest('.timeline-clip-finder'),popup=popupElement.getBoundingClientRect(),field=input.getBoundingClientRect(),close=popupElement.querySelector('button').getBoundingClientRect(),header=document.querySelector('.app-header').getBoundingClientRect(),divider=document.querySelector('.panel-divider').getBoundingClientRect();
    const crossing={x:popup.left+40,y:divider.top+divider.height/2},crossed=document.elementFromPoint(crossing.x,crossing.y),result=crossed?.closest('.timeline-find-result');
    return {innerHeight,timelineHeight:parseFloat(document.querySelector('.app-shell').style.getPropertyValue('--timeline-height')),popupTop:popup.top,popupBottom:popup.bottom,headerBottom:header.bottom,inputTop:field.top,inputHit:document.elementFromPoint(field.x+field.width/2,field.y+field.height/2)===input,closeVisible:close.top>=header.bottom&&close.bottom<=innerHeight,crossing,dividerCoveredByFinder:crossed?.closest('.timeline-clip-finder')===popupElement,crossedResultHit:!!result&&result.getAttribute('role')==='option'};
  });
  assert.equal(compact.timelineHeight,Math.max(200,compact.innerHeight-300));assert.ok(compact.popupTop>=compact.headerBottom+7);assert.ok(compact.popupBottom<=compact.innerHeight-7);assert.equal(compact.inputHit,true);assert.equal(compact.closeVisible,true);assert.equal(compact.dividerCoveredByFinder,true);assert.equal(compact.crossedResultHit,true);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await captureElectron(app,{path:path.join(work,'maximum-timeline-finder.png')});await finder().press('Escape');
  const raised=await divider.boundingBox();await page.mouse.move(raised.x+raised.width/2,raised.y+raised.height/2);await page.mouse.down();await page.mouse.move(raised.x+raised.width/2,raised.y+400,{steps:4});await page.mouse.up();
  checks.push('At minimum window size and maximum timeline height, finder input and close control remain unobscured, result rows receive pointer hits across the divider, and the list shrinks to available space');

  const textTrack={...tracks[1],id:'replace-text',name:'자막'},lockedTrack={...tracks[0],id:'replace-locked',name:'잠긴 자막'};
  const seed={...newClip(textTrack.id),captionStyle:defaultCaptionStyle(),text:'새로 새로',duration:2,captionWords:[{from:0,to:2,start:0,end:.8,timing:'measured'},{from:3,to:5,start:1,end:1.8,timing:'measured'}]};
  const replacementFixture={...newProject(),id:'caption-replace-regression',width:640,height:360,tracks:[textTrack,lockedTrack],clips:[{...seed,id:'replace-a'},{...seed,id:'replace-b',start:2,text:'새로',captionWords:[{from:0,to:2,start:0,end:1,timing:'manual'}]},{...seed,id:'replace-lock',trackId:lockedTrack.id,text:'새로 잠금전용',captionWords:undefined}]};
  await open(replacementFixture,'replacement');const original=(await state()).clips;
  await page.getByRole('button',{name:'자막',exact:true}).first().click();await page.locator('.caption-replace > summary').click();
  await page.getByLabel('찾을 자막 내용',{exact:true}).fill('새로');await page.getByLabel('바꿀 자막 내용',{exact:true}).fill('바뀜');await page.getByRole('button',{name:'전체 바꾸기',exact:true}).click();
  await page.getByText('2개 자막의 3곳을 바꿨습니다. 잠긴 트랙 1곳은 제외했습니다.',{exact:true}).waitFor();
  const changed=(await state()).clips;assert.equal(changed[0].text,'바뀜 바뀜');assert.equal(changed[1].text,'바뀜');assert.equal(changed[0].captionWords,undefined);assert.equal(changed[1].captionWords,undefined);assert.deepEqual(changed[2],original[2]);
  await page.getByRole('button',{name:'프로그램',exact:true}).click();await page.keyboard.press('Control+z');await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips[0].text==='새로 새로');assert.deepEqual((await state()).clips,original);
  await page.getByLabel('찾을 자막 내용',{exact:true}).fill('없는 내용');await page.getByRole('button',{name:'전체 바꾸기',exact:true}).click();await page.getByText('일치하는 내용이 없습니다.',{exact:true}).waitFor();assert.deepEqual((await state()).clips,original);
  await page.getByRole('button',{name:'프로그램',exact:true}).click();await page.keyboard.press('Control+Shift+z');await page.waitForFunction(()=>document.querySelector('.preview-gpu-stage').previewRuntime.project.clips[0].text==='바뀜 바뀜');assert.deepEqual((await state()).clips,changed);
  await page.getByLabel('찾을 자막 내용',{exact:true}).fill('잠금전용');await page.getByRole('button',{name:'전체 바꾸기',exact:true}).click();await page.getByText('일치하는 내용이 모두 잠긴 트랙에 있습니다.',{exact:true}).waitFor();assert.deepEqual((await state()).clips,changed);
  checks.push('Literal replacement changes all unlocked matches, invalidates only changed caption words, restores everything in one Undo, and no-match/locked-only operations preserve history and content');
  assert.deepEqual(errors,[]);const quiet=await assertQuietDialogs(app);if(proof)await proof.verifyEditorBuild(evidence);await captureElectron(app,{path:path.join(work,'final.png')});
  const sourceHashes={...evidence.sourceHashes};for(const file of ['src/Timeline.tsx','src/TimelineClipFinder.tsx','src/timeline-search.ts','src/CaptionReplace.tsx','src/captions/replace.ts','scripts/e2e-finder-captions.mjs'])sourceHashes[file]=createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const result={...evidence,development,passed:true,completedAt:new Date().toISOString(),work,checks,errors,performanceSample,compact,sourceHashes,quiet};await fs.writeFile(path.join(work,'results.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(root,development?'development-results.json':'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({work,checks,performanceSample,compact}));
}catch(error){await captureElectron(app,{path:path.join(work,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(work,'failure.json'),JSON.stringify({evidence,checks,errors,error:String(error),stack:error?.stack},null,2));throw error;}finally{await app.close();}
