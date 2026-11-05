import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {launchTestElectron,electronTestArgs,captureElectron,assertQuietDialogs} from './e2e-launch.mjs';
import {editorEvidence,verifyEditorBuild,hashFile,testExecutable} from './e2e-release-evidence.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';

const root=path.resolve('.test-artifacts/caption-fonts-ui');
await fs.mkdir(root,{recursive:true});
const work=await fs.mkdtemp(path.join(root,'proof-'));
const profile=path.join(work,'profile'),recovery=path.join(profile,'recovery.sluproj');
const executable=testExecutable(),env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};
const featurePointer=path.resolve(`.test-artifacts/caption-fonts-ui-current-${executable?'packaged':'source'}.txt`);
await fs.rm(featurePointer,{force:true});
delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({
  ...(executable?{executablePath:executable}:{}),args:electronTestArgs(!!executable),env,timeout:90000,
});
const page=await app.firstWindow(),checks=[],errors=[],exports=[];
page.on('pageerror',error=>errors.push(String(error)));
const binary=promisify(execFile),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const get=project=>project.clips.find(clip=>clip.id==='font-main');
let evidence;

async function snapshot(predicate) {
  let latest;
  for(const started=Date.now();Date.now()-started<20000;) {
    try {
      latest=JSON.parse(await fs.readFile(recovery,'utf8'));
      if(predicate(latest))return latest;
    } catch {}
    await new Promise(resolve=>setTimeout(resolve,75));
  }
  throw Error(`Caption font recovery assertion: ${JSON.stringify(latest)?.slice(0,4500)}`);
}
async function clean() {
  await dismissToasts(page);
  const close=page.getByTitle('작업 패널 닫기',{exact:true});
  if(await close.count())await close.click();
}
async function open(file) {
  await clean();
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
  await page.getByRole('button',{name:'프로그램',exact:true}).click();
  await page.keyboard.press('Control+o');
  await Promise.race([
    page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor(),
    page.locator('.toast-error').waitFor().then(async()=>{throw Error(await page.locator('.toast-error').innerText());}),
  ]);
}
async function select() {
  await clean();
  await page.locator('[data-clip-id="font-main"]').click({position:{x:15,y:4}});
  await page.getByLabel('자막 글꼴',{exact:true}).waitFor();
}
async function undo() {
  await page.getByRole('button',{name:'프로그램',exact:true}).click();
  await page.keyboard.press('Control+z');
}
async function save(file) {
  await clean();
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},file);
  await page.getByRole('button',{name:'프로그램',exact:true}).click();
  await page.keyboard.press('Control+Shift+s');
  await Promise.race([
    page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor(),
    page.locator('.toast-error').waitFor().then(async()=>{throw Error(await page.locator('.toast-error').innerText());}),
  ]);
  return JSON.parse(await fs.readFile(file,'utf8'));
}

try {
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1520,980));
  evidence=await editorEvidence(app,import.meta.url);
  await app.evaluate(({session})=>{
    globalThis.captionFontRequests=[];
    session.defaultSession.webRequest.onCompleted(details=>{
      if(details.url.endsWith('.ttf'))globalThis.captionFontRequests.push({url:details.url,status:details.statusCode});
    });
  });
  const template=JSON.parse(await fs.readFile('examples/AURORA.sluproj','utf8'));
  const base=template.clips.find(clip=>clip.text!==undefined);
  const style={font:'noto-sans-kr',weight:500,lineHeight:1.25,letterSpacing:0,outlineWidth:0,outlineColor:'#101219',shadowBlur:0,shadowColor:'#101219',background:'none',paddingX:14,paddingY:8,radius:10,maxWidth:.86,highlight:false,activeColor:'#f4d35e'};
  const main={...base,id:'font-main',name:'글꼴 비교',text:'한글 자막 Aa 012\n가나다 아름다운 영상',trackId:'font-text',start:0,duration:1,in:0,speed:1,fadeIn:0,fadeOut:0,keyframes:[],sourceClipOffset:undefined,sourceClipDuration:undefined,captionWords:undefined,captionStyle:style,captionAnimation:undefined,animation:'none',textStyle:'minimal',fontSize:38,color:'#ffffff',x:0,y:0,scale:1,rotation:0,opacity:1};
  const fixture={...template,id:'caption-fonts-project',name:'Caption fonts',version:10,width:640,height:360,fps:30,media:[],clips:[main],tracks:[{id:'font-text',type:'text',name:'자막',muted:false,hidden:false,locked:false}],transitions:[],colorLuts:[],updatedAt:new Date().toISOString()};
  const file=path.join(work,'fixture.sluproj');
  await fs.writeFile(file,JSON.stringify(fixture));
  await open(file);
  await snapshot(project=>project.id===fixture.id&&get(project)?.captionStyle.font==='noto-sans-kr');
  await select();

  const font=page.getByLabel('자막 글꼴',{exact:true}),weight=page.getByLabel('자막 굵기',{exact:true});
  assert.deepEqual(await font.locator('option').evaluateAll(options=>options.map(option=>({value:option.value,label:option.textContent}))),[
    {value:'noto-sans-kr',label:'Noto Sans KR'},{value:'gmarket-sans',label:'Gmarket Sans'},
  ]);
  await font.selectOption('gmarket-sans');
  await snapshot(project=>get(project).captionStyle.font==='gmarket-sans'&&get(project).captionStyle.weight===500);
  assert.deepEqual(await weight.locator('option').evaluateAll(options=>options.map(option=>option.value)),['500','700']);
  await undo();
  await snapshot(project=>get(project).captionStyle.font==='noto-sans-kr');
  await font.selectOption('gmarket-sans');
  await weight.selectOption('700');
  await snapshot(project=>get(project).captionStyle.font==='gmarket-sans'&&get(project).captionStyle.weight===700);
  await undo();
  await snapshot(project=>get(project).captionStyle.font==='gmarket-sans'&&get(project).captionStyle.weight===500);
  checks.push('The actual font picker has two bundled families, Gmarket offers500/700, and family/weight edits undo independently');

  for(const [notoWeight,gmarketWeight] of [[400,500],[600,700],[800,700]]) {
    await font.selectOption('noto-sans-kr');
    await weight.selectOption(String(notoWeight));
    await snapshot(project=>get(project).captionStyle.font==='noto-sans-kr'&&get(project).captionStyle.weight===notoWeight);
    await font.selectOption('gmarket-sans');
    await snapshot(project=>get(project).captionStyle.font==='gmarket-sans'&&get(project).captionStyle.weight===gmarketWeight);
    assert.equal(await weight.inputValue(),String(gmarketWeight));
  }
  checks.push('Changing from Noto400/600/800 normalizes visibly to an available Gmarket500/700 weight');

  await weight.selectOption('700');
  await snapshot(project=>get(project).captionStyle.weight===700);
  const savedFile=path.join(work,'gmarket-saved.sluproj'),saved=await save(savedFile);
  assert.equal(saved.version,10);
  assert.equal(get(saved).captionStyle.font,'gmarket-sans');
  assert.equal(get(saved).captionStyle.weight,700);
  await open(savedFile);
  await snapshot(project=>JSON.stringify(get(project).captionStyle)===JSON.stringify(get(saved).captionStyle));
  await select();
  assert.equal(await font.inputValue(),'gmarket-sans');
  assert.equal(await weight.inputValue(),'700');
  checks.push('Real Save As and reopen preserve Gmarket font and weight in project format10');

  await page.getByLabel('자막 스타일 이름',{exact:true}).fill('Gmarket 700 검증');
  await page.getByRole('button',{name:'스타일 저장',exact:true}).click();
  const presets=await page.evaluate(()=>JSON.parse(localStorage.getItem('slu-caption-presets-v1')||'[]'));
  assert.equal(presets.length,1);
  assert.equal(presets[0].appearance.captionStyle.font,'gmarket-sans');
  assert.equal(presets[0].appearance.captionStyle.weight,700);
  await font.selectOption('noto-sans-kr');
  await snapshot(project=>get(project).captionStyle.font==='noto-sans-kr');
  await page.getByLabel('저장한 자막 스타일',{exact:true}).selectOption({label:'Gmarket 700 검증'});
  await page.getByRole('button',{name:'선택 자막에 스타일 적용',exact:true}).click();
  await snapshot(project=>get(project).captionStyle.font==='gmarket-sans');
  await undo();
  await snapshot(project=>get(project).captionStyle.font==='noto-sans-kr');
  checks.push('A named Gmarket preset retains family and weight, applies through the editor, and undoes as one change');

  const track=page.getByLabel('트랙 이름 font-text',{exact:true}).locator('xpath=ancestor::div[contains(@class,"track-row")]');
  await track.getByTitle('트랙 잠금',{exact:true}).click();
  const locked=await snapshot(project=>project.tracks[0].locked);
  assert.equal(await font.isDisabled(),true);
  assert.equal(await weight.isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'스타일 저장',exact:true}).isDisabled(),true);
  assert.deepEqual(get(locked).captionStyle,get(await snapshot(project=>project.tracks[0].locked)).captionStyle);
  await track.getByTitle('트랙 잠금 해제',{exact:true}).click();
  await snapshot(project=>!project.tracks[0].locked);
  checks.push('Track locking disables both font controls and preset saving without changing the caption');

  await page.locator('.tool-rail').getByRole('button',{name:'텍스트',exact:true}).click();
  for(const [label,expected] of [['기본','noto-sans-kr'],['굵은 제목','gmarket-sans'],['외곽선','gmarket-sans']]) {
    await page.locator('.text-template-grid').getByRole('button',{name:new RegExp(label)}).click();
    const project=await snapshot(project=>project.clips.length===2);
    const inserted=project.clips.find(clip=>clip.id!==main.id);
    assert.equal(inserted.captionStyle.font,expected);
    assert.equal(project.version,10);
    await undo();
    await snapshot(project=>project.clips.length===1);
  }
  checks.push('Normal text insertion maps basic text to Noto and outline/title templates to Gmarket, with undo');

  await select();
  await fs.writeFile(path.join(work,'font-faces-before.json'),JSON.stringify(await page.evaluate(()=>[...document.fonts].map(face=>({family:face.family,weight:face.weight,status:face.status}))),null,2));
  const expectedFaces=['SLU Noto Sans KR|100 900','SLU Noto Color Emoji|100 900','SLU Gmarket Sans|400 500','SLU Gmarket Sans|600 800'].sort();
  await page.waitForFunction(expected=>{
    const faces=[...document.fonts].filter(face=>face.status==='loaded').map(face=>`${face.family.replace(/^(["'])(.*)\1$/,'$2')}|${face.weight}`).sort();
    return JSON.stringify(faces)===JSON.stringify(expected);
  },expectedFaces);
  const faces=await page.evaluate(()=>[...document.fonts].map(face=>({family:face.family,weight:face.weight,status:face.status})));
  assert.deepEqual(faces.map(face=>`${face.family.replace(/^(["'])(.*)\1$/,'$2')}|${face.weight}`).sort(),expectedFaces);
  const fontResources=await app.evaluate(()=>globalThis.captionFontRequests);
  await fs.writeFile(path.join(work,'font-requests.json'),JSON.stringify(fontResources,null,2));
  const assetNames=(await fs.readdir('dist/assets')).filter(name=>name.endsWith('.ttf'));
  assert.equal(assetNames.length,4);
  const assetDirectory=executable?path.join(path.dirname(executable),'resources/app.asar/dist/assets'):path.resolve('dist/assets');
  // The custom protocol performs a local net.fetch, so Electron observes both
  // the public slu-app request and its file URL for each bundled font.
  const expectedFontUrls=assetNames.flatMap(name=>[`slu-app://studio/assets/${name}`,pathToFileURL(path.join(assetDirectory,name)).href]).sort();
  assert.deepEqual([...new Set(fontResources.map(resource=>resource.url))].sort(),expectedFontUrls);
  assert.ok(fontResources.every(resource=>resource.status===200));
  const fontHashes={};
  for(const name of ['NotoSansKR-VF','NotoColorEmoji','GmarketSansTTFMedium','GmarketSansTTFBold'])fontHashes[name]=await hashFile(`src/assets/fonts/${name}.ttf`);
  await page.evaluate(()=>{window.captionFontJobs=[];window.studio.onJob(event=>window.captionFontJobs.push(event));});
  const binRoot=executable?path.join(path.dirname(executable),'resources/bin'):path.resolve('resources/bin');
  const rawFrames=new Map();
  for(const family of ['noto-sans-kr','gmarket-sans'])for(const value of [500,700]) {
    await select();
    await font.selectOption(family);
    await weight.selectOption(String(value));
    const project=await snapshot(project=>get(project).captionStyle.font===family&&get(project).captionStyle.weight===value);
    const name=`${family}-${value}`,output=path.join(work,`${name}.mp4`),png=path.join(work,`${name}.png`);
    await page.getByRole('button',{name:'프로그램',exact:true}).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await captureElectron(app,{path:path.join(work,`${name}-editor.png`)});
    await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},output);
    const settings={format:'mp4',codec:'h264',encoder:'cpu',width:640,height:360,fps:30,quality:'high'};
    const job=await page.evaluate(({project,settings})=>window.studio.exportProject(project,settings),{project,settings});
    assert.ok(job?.jobId);
    await page.waitForFunction(id=>window.captionFontJobs.some(event=>event.id===id&&event.status!=='running'),job.jobId,{timeout:120000});
    const terminal=await page.evaluate(id=>window.captionFontJobs.find(event=>event.id===id&&event.status!=='running'),job.jobId);
    assert.equal(terminal.status,'complete',terminal.message);
    const options={windowsHide:true,maxBuffer:8*1024*1024,timeout:120000};
    const probe=JSON.parse((await binary(path.join(binRoot,'ffprobe.exe'),['-v','error','-count_frames','-show_streams','-of','json',output],options)).stdout);
    const video=probe.streams.find(stream=>stream.codec_type==='video');
    assert.equal(video.width,640);assert.equal(video.height,360);assert.equal(Number(video.nb_read_frames),30);
    const raw=(await binary(path.join(binRoot,'ffmpeg.exe'),['-v','error','-i',output,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{...options,encoding:'buffer'})).stdout;
    assert.equal(raw.length,640*360*3);
    let litPixels=0;
    for(let offset=0;offset<raw.length;offset+=3)if(raw[offset]>100&&raw[offset+1]>100&&raw[offset+2]>100)litPixels++;
    assert.ok(litPixels>0,`${name} produced no caption pixels`);
    await binary(path.join(binRoot,'ffmpeg.exe'),['-v','error','-i',output,'-frames:v','1','-y',png],options);
    rawFrames.set(name,raw);
    exports.push({family,weight:value,output,png,settings,frames:30,litPixels,rawSha256:digest(raw),videoSha256:await hashFile(output),jobId:job.jobId});
  }
  const differences=[];
  for(const [left,right] of [['noto-sans-kr-500','gmarket-sans-500'],['noto-sans-kr-700','gmarket-sans-700'],['gmarket-sans-500','gmarket-sans-700'],['noto-sans-kr-500','noto-sans-kr-700']]) {
    const a=rawFrames.get(left),b=rawFrames.get(right);
    let changedPixels=0;
    for(let offset=0;offset<a.length;offset+=3)if(a[offset]!==b[offset]||a[offset+1]!==b[offset+1]||a[offset+2]!==b[offset+2])changedPixels++;
    assert.ok(changedPixels>0,`${left} and ${right} exported identical glyphs`);
    differences.push({left,right,changedPixels});
  }
  checks.push('Four normal project exports use CPU H264 and produce30 frames each, with visible and distinct glyph pixels for both families and500/700 weights');
  await clean();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,720));
  for(const control of [font,weight]) {
    await control.scrollIntoViewIfNeeded();
    assert.equal(await control.evaluate(element=>{const box=element.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return hit===element||element.contains(hit);}),true);
  }
  await captureElectron(app,{path:path.join(work,'font-controls-small.png')});
  checks.push('Both font controls remain reachable at1100x720');
  await assertQuietDialogs(app);
  await verifyEditorBuild(evidence);
  assert.deepEqual(errors,[]);
  const result={...evidence,checks,errors,work,profile,savedFile,fontHashes,faces,fontResources,exports,differences};
  await fs.writeFile(path.join(work,'results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({work,checks,exports:exports.map(({output,rawSha256,litPixels})=>({output,rawSha256,litPixels})),differences}));
} catch(error) {
  await captureElectron(app,{path:path.join(work,'failure.png')}).catch(()=>{});
  await fs.writeFile(path.join(work,'failure.json'),JSON.stringify({evidence,checks,errors,exports,error:String(error),stack:error?.stack},null,2));
  throw error;
} finally {
  await page.evaluate(async()=>{for(const id of new Set((window.captionFontJobs||[]).map(event=>event.id)))await window.studio.cancelJob(id);}).catch(()=>{});
  await app.close();
}
const featureResultFile=path.join(work,'results.json');
const featureResult=JSON.parse(await fs.readFile(featureResultFile,'utf8'));
featureResult.passed=true;featureResult.completedAt=new Date().toISOString();
await fs.writeFile(featureResultFile,JSON.stringify(featureResult,null,2));
await fs.writeFile(featurePointer,work+'\n');
