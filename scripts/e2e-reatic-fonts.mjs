// Run on the private test desktop after a build and current-user installation of
// the unchanged REATIC Regular/Bold files. Reference bytes remain outside Git.
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {listPackage,extractFile} from '@electron/asar';
import {launchTestElectron,electronTestArgs,assertQuietDialogs,captureElectron} from './e2e-launch.mjs';
import {editorEvidence,verifyEditorBuild,hashFile,testExecutable} from './e2e-release-evidence.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';

const artifacts=path.resolve('.test-artifacts'),root=path.resolve(process.env.SLU_REATIC_TEST_ROOT||'.test-artifacts/reatic-fonts');
const relative=path.relative(artifacts,root);
assert.ok(relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),'SLU_REATIC_TEST_ROOT must be inside .test-artifacts');
assert.ok(process.env.SLU_REATIC_TEST_FONT_DIR,'SLU_REATIC_TEST_FONT_DIR must point to the original unmodified Regular/Bold reference files');
const references=[];
for(const [weight,name,expected] of [[400,'Regular','190825fceb4e60735d2fd6ab75867c25179a970e564c4aeea1ec41fa6149a05f'],[700,'Bold','8f44dee2a05d981a98741c7b6d4ad7019b01d029a80d16b24de299bddac8d02a']]){
  const file=path.resolve(process.env.SLU_REATIC_TEST_FONT_DIR,`REATIC-${name}.ttf`),bytes=await fs.readFile(file),sha256=createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256,expected,`Reference must be the inspected REATIC 1.0.0 ${name} bytes`);
  references.push({weight,name,file,sha256,bytes:bytes.length,base64:bytes.toString('base64')});
}
await fs.mkdir(root,{recursive:true});const work=await fs.mkdtemp(path.join(root,'proof-'));
const executable=testExecutable(),pointer=`${root}-current-${executable?'packaged':'source'}.txt`;
await fs.rm(pointer,{force:true});
const checks=[],errors=[],sessions=[],binary=promisify(execFile),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const settings={format:'mp4',codec:'h264',encoder:'cpu',width:640,height:360,fps:30,quality:'high'};
const template=JSON.parse(await fs.readFile('examples/AURORA.sluproj','utf8'));
const base=template.clips.find(clip=>clip.text!==undefined);
const style={font:'reatic',weight:400,lineHeight:1.25,letterSpacing:0,outlineWidth:0,outlineColor:'#101219',shadowBlur:0,shadowColor:'#101219',background:'none',paddingX:14,paddingY:8,radius:10,maxWidth:.86,highlight:false,activeColor:'#f4d35e'};
const main={...base,id:'reatic-main',name:'리틱체 검증',text:'리틱체 한글 자막 Aa 012\n가나다 아름다운 영상',trackId:'reatic-text',start:0,duration:1,in:0,speed:1,fadeIn:0,fadeOut:0,keyframes:[],sourceClipOffset:undefined,sourceClipDuration:undefined,captionWords:undefined,captionStyle:style,captionAnimation:undefined,animation:'none',textStyle:'minimal',fontSize:38,color:'#ffffff',x:0,y:0,scale:1,rotation:0,opacity:1};
const fixture={...template,id:'reatic-font-project',name:'REATIC local font',version:10,width:640,height:360,fps:30,background:'#000000',media:[],clips:[main],tracks:[{id:'reatic-text',type:'text',name:'자막',muted:false,hidden:false,locked:false}],transitions:[],colorLuts:[],updatedAt:new Date().toISOString()};
const get=project=>project.clips.find(clip=>clip.id===main.id);
let currentApp,currentPage,evidence;

// Test-only fault injection changes only the native CSS local lookup string.
// FontFace.load still executes Chromium's real missing-font error path. A log
// from each actual renderer is mandatory; no application test hook is used.
function missingLocalFaces(weights){
  const NativeFontFace=globalThis.FontFace;
  const emit=record=>console.debug('SLU_REATIC_TEST '+JSON.stringify({...record,url:location.href}));
  emit({event:'guard-installed',weights});
  globalThis.FontFace=class extends NativeFontFace{
    constructor(family,source,descriptors){
      const weight=Number(descriptors?.weight),target=String(family).replaceAll('"','')==='SLU REATIC'&&weights.includes(weight);
      if(target){emit({event:'local-unavailable',family,weight,source:String(source)});source=`local("__SLU_QA_NO_REATIC_${weight}_4caf6ede_5092_4f60_b631__")`;}
      super(family,source,descriptors);
    }
  };
}
function observeNative({app,BrowserWindow}){
  globalThis.reaticAudit={windows:[],children:[],messages:[],observerErrors:[]};
  const audit=globalThis.reaticAudit;
  function observe(window,existing=false){
    const entry={id:window.id,existing,phase:globalThis.reaticPhase,closed:false,url:window.webContents.getURL()};audit.windows.push(entry);
    window.on('closed',()=>entry.closed=true);
    window.webContents.on('did-finish-load',()=>entry.url=window.webContents.getURL());
    window.webContents.on('console-message',(_event,detail,...legacy)=>{
      const message=typeof _event?.message==='string'?_event.message:typeof detail==='object'?detail.message:legacy[0];
      if(typeof message==='string'&&message.startsWith('SLU_REATIC_TEST ')){
        try{audit.messages.push({windowId:entry.id,...JSON.parse(message.slice('SLU_REATIC_TEST '.length))});}catch(error){audit.observerErrors.push(String(error));}
      }
    });
  }
  BrowserWindow.getAllWindows().forEach(window=>observe(window,true));
  app.on('browser-window-created',(_event,window)=>observe(window));
  const {createRequire,syncBuiltinESMExports}=process.getBuiltinModule('node:module'),cp=createRequire(process.execPath)('node:child_process'),spawn=cp.spawn;
  cp.spawn=function(command,args){
    const child=Reflect.apply(spawn,this,arguments),entry={phase:globalThis.reaticPhase,command:String(command),args:[...(args||[])],pid:child.pid,closed:false};audit.children.push(entry);
    child.once('close',(code,signal)=>Object.assign(entry,{closed:true,code,signal}));return child;
  };syncBuiltinESMExports();
}
async function snapshot(recovery,predicate){
  let last;for(const start=Date.now();Date.now()-start<20000;){try{last=JSON.parse(await fs.readFile(recovery,'utf8'));if(predicate(last))return last;}catch{}await new Promise(resolve=>setTimeout(resolve,75));}
  throw Error(`REATIC project state not reached: ${JSON.stringify(last)?.slice(0,1200)}`);
}
async function clean(page){await dismissToasts(page);const close=page.getByTitle('작업 패널 닫기',{exact:true});if(await close.count())await close.click();}
async function open(app,page,recovery,project,name,existingFile){
  await clean(page);const file=existingFile||path.join(work,`${name}.sluproj`);if(!existingFile)await fs.writeFile(file,JSON.stringify(project));
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
  await page.getByRole('button',{name:'프로그램',exact:true}).click();await page.keyboard.press('Control+o');
  await page.getByText('프로젝트를 열었습니다.',{exact:true}).waitFor();
  await snapshot(recovery,value=>value.id===project.id&&get(value)?.captionStyle.font===get(project).captionStyle.font&&get(value)?.captionStyle.weight===get(project).captionStyle.weight);
  await clean(page);await page.locator('[data-clip-id="reatic-main"]').click({position:{x:15,y:4}});
  await page.getByLabel('자막 글꼴',{exact:true}).waitFor();
}
async function save(app,page,recovery,name){
  await clean(page);const file=path.join(work,`${name}.sluproj`);
  await app.evaluate(({dialog},filePath)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath});},file);
  await page.getByRole('button',{name:'프로그램',exact:true}).click();await page.keyboard.press('Control+Shift+s');
  await page.getByText('프로젝트를 저장했습니다.',{exact:true}).waitFor();
  const saved=JSON.parse(await fs.readFile(file,'utf8'));await snapshot(recovery,value=>get(value)?.captionStyle.font===get(saved).captionStyle.font);return {file,saved};
}
async function waitFonts(page,available){
  await page.waitForFunction(expected=>{
    const faces=[...document.fonts],bundled=faces.filter(face=>face.family.includes('SLU ')&&!face.family.includes('SLU REATIC'));
    const local=faces.filter(face=>face.family.replaceAll('"','')==='SLU REATIC'&&face.status==='loaded').map(face=>Number(face.weight)).sort();
    return document.querySelector('.preview-gpu-stage')?.previewRuntime?.captionFontState==='ready'&&bundled.length===4&&bundled.every(face=>face.status==='loaded')&&JSON.stringify(local)===JSON.stringify(expected);
  },available);
}
async function preview(page){
  return page.evaluate(()=>{
    const runtime=document.querySelector('.preview-gpu-stage').previewRuntime;runtime.setTransport(0,false,Date.now());
    const png=runtime.snapshot(),canvas=runtime.renderer.canvas,width=canvas.width,height=canvas.height;
    let rgba;if(runtime.renderer.gl){const gl=runtime.renderer.gl,raw=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,raw);if(gl.getError())throw Error('Preview WebGL error');rgba=new Uint8Array(raw.length);for(let y=0;y<height;y++)rgba.set(raw.subarray((height-y-1)*width*4,(height-y)*width*4),y*width*4);}else rgba=canvas.getContext('2d').getImageData(0,0,width,height).data;
    const rgb=new Uint8Array(width*height*3);let litPixels=0;for(let i=0,j=0;i<rgba.length;i+=4,j+=3){rgb[j]=rgba[i];rgb[j+1]=rgba[i+1];rgb[j+2]=rgba[i+2];if(Math.max(...rgba.subarray(i,i+3))>100)litPixels++;}
    let binary='';for(let offset=0;offset<rgb.length;offset+=32768)binary+=String.fromCharCode(...rgb.subarray(offset,offset+32768));
    return {width,height,png,rgb:btoa(binary),litPixels,mode:runtime.renderer.mode};
  });
}
async function exportProject(app,page,project,name,shouldPass){
  const output=path.join(work,`${name}.mp4`);
  await app.evaluate(({dialog},{filePath,phase})=>{globalThis.reaticPhase=phase;dialog.showSaveDialog=async()=>({canceled:false,filePath});},{filePath:output,phase:name});
  const actualSettings=shouldPass?settings:{...settings,encoder:'auto'};
  const result=await page.evaluate(async({project,settings})=>{try{return {job:await window.studio.exportProject(project,settings)};}catch(error){return {error:String(error)};}},{project,settings:actualSettings});
  let terminal;
  if(result.job?.jobId){await page.waitForFunction(id=>window.reaticJobs.some(event=>event.id===id&&event.status!=='running'),result.job.jobId,{timeout:120000});terminal=await page.evaluate(id=>window.reaticJobs.find(event=>event.id===id&&event.status!=='running'),result.job.jobId);}
  if(!shouldPass){
    assert.notEqual(terminal?.status,'complete');assert.match(result.error||terminal?.message||'',/리틱체.*(?:400|700).*설치/);
    assert.equal(await fs.stat(output).then(()=>true,()=>false),false,'Missing local face must not publish substituted video');
    const events=await page.evaluate(id=>window.reaticJobs.filter(event=>event.id===id),result.job?.jobId);
    assert.ok(!events.some(event=>/GPU/.test(event.message||'')&&/실패|다시 시도/.test(event.message||'')),'Missing fonts must not be reported as a GPU failure or retried on CPU');
    const attempts=await app.evaluate((_,phase)=>globalThis.reaticAudit.windows.filter(window=>!window.existing&&window.phase===phase),name);
    assert.equal(attempts.length,1,'Missing font must fail in its actual caption sandbox without encoder retry');assert.equal(attempts[0].closed,true);
    return {output,settings:actualSettings,rejected:result.error,terminal,events,captionRendererAttempts:attempts.length};
  }
  assert.ok(result.job?.jobId,result.error);assert.equal(terminal.status,'complete',terminal.message);
  const binRoot=executable?path.join(path.dirname(executable),'resources/bin'):path.resolve('resources/bin');
  const options={windowsHide:true,maxBuffer:8*1024*1024,timeout:120000};
  const probe=JSON.parse((await binary(path.join(binRoot,'ffprobe.exe'),['-v','error','-count_frames','-show_streams','-of','json',output],options)).stdout);
  const video=probe.streams.find(stream=>stream.codec_type==='video');assert.equal(video.width,640);assert.equal(video.height,360);assert.equal(Number(video.nb_read_frames),30);
  const raw=(await binary(path.join(binRoot,'ffmpeg.exe'),['-v','error','-i',output,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{...options,encoding:'buffer'})).stdout;
  assert.equal(raw.length,640*360*3);return {output,terminal,frames:30,sha256:await hashFile(output),rawSha256:digest(raw),raw};
}
async function positivePixels(page){
  const result=await page.evaluate(async references=>{
    const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('');
    const rows=[];
    for(const reference of references){
      const bytes=Uint8Array.from(atob(reference.base64),char=>char.charCodeAt(0)),face=new FontFace('SLU QA ZIP REATIC',bytes,{weight:String(reference.weight),style:'normal'});await face.load();document.fonts.add(face);
      try{
        const draw=family=>{const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=320;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.textBaseline='alphabetic';const metrics=[];for(const [text,size,y] of [['리틱체 한글 가나다라마바사 Aa iIlMWm 0123456789',38,70],['가나다 힣 ABC xyz 012 … · ₩ “자막”',60,165]]){ctx.font=`${reference.weight} ${size}px "${family}"`;const m=ctx.measureText(text);metrics.push([m.width,m.actualBoundingBoxLeft,m.actualBoundingBoxRight,m.actualBoundingBoxAscent,m.actualBoundingBoxDescent]);ctx.fillText(text,12,y);}return {metrics,png:canvas.toDataURL('image/png'),pixels:ctx.getImageData(0,0,1024,320).data};};
        const actual=draw('SLU REATIC'),expected=draw('SLU QA ZIP REATIC'),bundled=draw('SLU Noto Sans KR');
        rows.push({weight:reference.weight,actualMetrics:actual.metrics,referenceMetrics:expected.metrics,actualRgbaSha256:await hash(actual.pixels),referenceRgbaSha256:await hash(expected.pixels),bundledRgbaSha256:await hash(bundled.pixels),png:actual.png});
      }finally{document.fonts.delete(face);}
    }return rows;
  },references.map(({weight,base64})=>({weight,base64})));
  for(const row of result){assert.deepEqual(row.actualMetrics,row.referenceMetrics);assert.equal(row.actualRgbaSha256,row.referenceRgbaSha256,'Local native glyph pixels must equal original ZIP font bytes');assert.notEqual(row.actualRgbaSha256,row.bundledRgbaSha256,'Local face must not silently resolve to bundled Noto');await fs.writeFile(path.join(work,`reference-${row.weight}.png`),Buffer.from(row.png.split(',')[1],'base64'));delete row.png;}
  assert.notEqual(result[0].actualRgbaSha256,result[1].actualRgbaSha256,'Regular and Bold must use distinct actual outlines');return result;
}
function comparePreview(preview,result){
  const expected=Buffer.from(preview.rgb,'base64'),actual=result.raw;assert.equal(preview.width,640);assert.equal(preview.height,360);assert.equal(expected.length,actual.length);assert.ok(preview.litPixels>100);
  let whole=0,inkError=0,ink=0,over=0;for(let i=0;i<actual.length;i+=3){const a=Math.max(expected[i],expected[i+1],expected[i+2]),b=Math.max(actual[i],actual[i+1],actual[i+2]);for(let c=0;c<3;c++)whole+=Math.abs(expected[i+c]-actual[i+c]);if(a>20||b>20){ink++;inkError+=Math.abs(a-b);if(Math.abs(a-b)>16)over++;}}
  const comparison={mean:whole/actual.length,inkMean:inkError/ink,inkOver16:over/ink,previewRgbSha256:digest(expected),previewLitPixels:preview.litPixels};
  assert.ok(comparison.mean<2,`Preview/export full-frame mismatch ${comparison.mean}`);assert.ok(comparison.inkMean<7,`Preview/export ink mismatch ${comparison.inkMean}`);assert.ok(comparison.inkOver16<.15,`Preview/export glyph-shape mismatch ${comparison.inkOver16}`);return comparison;
}
async function assertNoBundledReatic(){
  const records=[];for(const directory of ['src/assets/fonts','dist/assets'])for(const name of await fs.readdir(directory))if(/\.(ttf|otf|woff2?|zip)$/i.test(name)){
    const file=path.join(directory,name),sha256=await hashFile(file);assert.ok(!/reatic|리틱/i.test(name));assert.ok(!references.some(reference=>reference.sha256===sha256));records.push({file,sha256});
  }
  assert.equal(records.filter(record=>record.file.startsWith(path.join('dist','assets'))&&record.file.endsWith('.ttf')).length,4);
  if(executable){const asar=path.join(path.dirname(executable),'resources/app.asar');for(const item of listPackage(asar).filter(name=>/\.(ttf|otf|woff2?|zip)$/i.test(name))){assert.ok(!/reatic|리틱/i.test(item));const sha256=digest(extractFile(asar,item.replace(/^[/\\]/,'')));assert.ok(!references.some(reference=>reference.sha256===sha256));records.push({asar,entry:item,sha256});}}
  return records;
}

try{
  const bundle=await assertNoBundledReatic();checks.push('Source and built font assets, and packaged ASAR when used, contain no REATIC font binaries or ZIP; four bundled caption assets remain');
  for(const [name,missing] of [['installed',[]],['missing-all',[400,700]],['missing-bold',[700]]]){
    const profile=path.join(work,`${name}-profile`),recovery=path.join(profile,'recovery.sluproj'),env={...process.env,SLU_USER_DATA:profile,SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
    const app=currentApp=await launchTestElectron({...(executable?{executablePath:executable}:{}),args:electronTestArgs(!!executable),env,timeout:90000});
    const page=currentPage=await app.firstWindow();page.on('pageerror',error=>errors.push(`${name}: ${error}`));
    await app.evaluate(observeNative);
    if(missing.length){await app.context().addInitScript(missingLocalFaces,missing);await page.reload({waitUntil:'domcontentloaded'});}
    await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1520,980));
    const sessionEvidence=await editorEvidence(app,import.meta.url);evidence??=sessionEvidence;assert.equal(sessionEvidence.buildReceiptId,evidence.buildReceiptId);
    await page.evaluate(()=>{window.reaticJobs=[];window.studio.onJob(event=>window.reaticJobs.push(event));});
    const session={name,missing,evidence:sessionEvidence,exports:[],saved:[],preview:[]};sessions.push(session);
    const available=[400,700].filter(weight=>!missing.includes(weight));
    await open(app,page,recovery,fixture,`${name}-initial`);await waitFonts(page,available);
    if(!missing.length){
      session.glyphReference=await positivePixels(page);
      checks.push('Installed Regular400 and Bold700 reproduce original ZIP reference metrics and exact RGBA glyph pixels, both differing from bundled Noto and each other');
      const font=page.getByLabel('자막 글꼴',{exact:true}),weight=page.getByLabel('자막 굵기',{exact:true});
      assert.equal(await font.inputValue(),'reatic');assert.deepEqual(await weight.locator('option').evaluateAll(options=>options.map(option=>option.value)),['400','700']);
      const undo=async()=>{await page.getByRole('button',{name:'프로그램',exact:true}).click();await page.keyboard.press('Control+z');};
      await font.selectOption('noto-sans-kr');await snapshot(recovery,project=>get(project).captionStyle.font==='noto-sans-kr');
      await font.selectOption('reatic');await snapshot(recovery,project=>get(project).captionStyle.font==='reatic'&&get(project).captionStyle.weight===400);
      await weight.selectOption('700');await snapshot(recovery,project=>get(project).captionStyle.weight===700);
      await undo();await snapshot(recovery,project=>get(project).captionStyle.font==='reatic'&&get(project).captionStyle.weight===400);
      await undo();await snapshot(recovery,project=>get(project).captionStyle.font==='noto-sans-kr');
      await font.selectOption('reatic');await weight.selectOption('700');await snapshot(recovery,project=>get(project).captionStyle.font==='reatic'&&get(project).captionStyle.weight===700);
      await page.getByLabel('자막 스타일 이름',{exact:true}).fill('리틱체 700 검증');await page.getByRole('button',{name:'스타일 저장',exact:true}).click();
      const preset=await page.evaluate(()=>JSON.parse(localStorage.getItem('slu-caption-presets-v1')||'[]').find(value=>value.name==='리틱체 700 검증'));
      assert.equal(preset.appearance.captionStyle.font,'reatic');assert.equal(preset.appearance.captionStyle.weight,700);
      await font.selectOption('noto-sans-kr');await snapshot(recovery,project=>get(project).captionStyle.font==='noto-sans-kr');
      await page.getByLabel('저장한 자막 스타일',{exact:true}).selectOption({label:'리틱체 700 검증'});await page.getByRole('button',{name:'선택 자막에 스타일 적용',exact:true}).click();
      await snapshot(recovery,project=>get(project).captionStyle.font==='reatic'&&get(project).captionStyle.weight===700);
      await undo();await snapshot(recovery,project=>get(project).captionStyle.font==='noto-sans-kr');await font.selectOption('reatic');
      checks.push('Actual REATIC family and weight edits undo independently; a saved Bold700 preset retains the local font ID, applies and undoes through the editor');
      for(const value of [400,700]){
        await weight.selectOption(String(value));const project=await snapshot(recovery,project=>get(project).captionStyle.font==='reatic'&&get(project).captionStyle.weight===value);
        const saved=await save(app,page,recovery,`reatic-${value}-saved`);assert.equal(get(saved.saved).captionStyle.font,'reatic');assert.equal(get(saved.saved).captionStyle.weight,value);session.saved.push({file:saved.file,font:'reatic',weight:value,sha256:await hashFile(saved.file)});
        await open(app,page,recovery,saved.saved,`reatic-${value}-reopened`,saved.file);assert.equal(await font.inputValue(),'reatic');assert.equal(await weight.inputValue(),String(value));
        const captured=await preview(page);await fs.writeFile(path.join(work,`reatic-${value}-preview.png`),Buffer.from(captured.png.split(',')[1],'base64'));
        const result=await exportProject(app,page,project,`reatic-${value}`,true);session.exports.push({...result,raw:undefined,comparison:comparePreview(captured,result)});
      }
      checks.push('Regular400/Bold700 survive actual Save As and reopen and export thirty CPU H264 frames matching actual editor preview glyphs within codec tolerance');
    }else{
      for(const value of missing){
        const project={...fixture,id:`${name}-${value}`,clips:[{...main,captionStyle:{...style,weight:value}}]};
        await open(app,page,recovery,project,`${name}-${value}-open`);await waitFonts(page,available);
        assert.equal(await page.getByLabel('자막 글꼴',{exact:true}).inputValue(),'reatic');assert.equal(await page.getByLabel('자막 굵기',{exact:true}).inputValue(),String(value));
        assert.equal(await page.getByLabel('자막 글꼴',{exact:true}).locator('option[value="reatic"]').evaluate(option=>option.disabled),available.length===0);
        assert.equal(await page.getByLabel('자막 굵기',{exact:true}).locator(`option[value="${value}"]`).evaluate(option=>option.disabled),true);
        assert.ok(await page.getByText(new RegExp(`리틱체 ${value===700?'Bold':'Regular'} \\(${value}\\).*설치`)).count(),'Missing local face must have a visible explanation');
        const captured=await preview(page);assert.equal(captured.litPixels,0,'Missing face must not draw a substituted caption');session.preview.push({weight:value,litPixels:captured.litPixels,rgbSha256:digest(Buffer.from(captured.rgb,'base64'))});
        const saved=await save(app,page,recovery,`${name}-${value}-saved`);assert.equal(get(saved.saved).captionStyle.font,'reatic');assert.equal(get(saved.saved).captionStyle.weight,value);session.saved.push({file:saved.file,font:'reatic',weight:value,sha256:await hashFile(saved.file)});
        await open(app,page,recovery,saved.saved,`${name}-${value}-reopened`,saved.file);assert.equal(await page.getByLabel('자막 글꼴',{exact:true}).inputValue(),'reatic');assert.equal(await page.getByLabel('자막 굵기',{exact:true}).inputValue(),String(value));
        session.exports.push(await exportProject(app,page,project,`${name}-${value}-blocked`,false));
      }
      // Every absence mode must still render and export both bundled families.
      for(const family of ['noto-sans-kr','gmarket-sans']){
        const project={...fixture,id:`${name}-${family}`,clips:[{...main,captionStyle:{...style,font:family,weight:700}}]};await open(app,page,recovery,project,`${name}-${family}`);
        const captured=await preview(page),result=await exportProject(app,page,project,`${name}-${family}`,true);session.exports.push({...result,raw:undefined,comparison:comparePreview(captured,result)});
      }
      if(available.includes(400)){
        await open(app,page,recovery,fixture,`${name}-regular-available`);const captured=await preview(page),result=await exportProject(app,page,fixture,`${name}-regular-available`,true);session.exports.push({...result,raw:undefined,comparison:comparePreview(captured,result)});
      }
      checks.push(`${name}: missing weights retain saved font IDs, show an explanation, draw no replacement glyphs, reject actual export without output, while both bundled families${available.length?' and Regular400':''} still preview/export`);
    }
    session.audit=await app.evaluate(()=>globalThis.reaticAudit);
    assert.deepEqual(session.audit.observerErrors,[]);assert.ok(session.audit.children.every(child=>child.closed),'Every app-owned native child must close before export completion');
    const sandboxWindows=session.audit.windows.filter(window=>!window.existing);assert.ok(sandboxWindows.length>0);assert.ok(sandboxWindows.every(window=>window.closed&&window.url.includes('caption-export.html')),'Every actual caption sandbox must close');
    if(missing.length){
      for(const window of session.audit.windows){for(const weight of missing)assert.ok(session.audit.messages.some(message=>message.windowId===window.id&&message.event==='local-unavailable'&&message.weight===weight),`${name}: missing-local fault did not execute in renderer ${window.id}/${window.url} for ${weight}`);}
      session.simulation='Only CSS local font lookup strings were replaced in every actual editor/export renderer; native FontFace.load handled failure';
    }
    session.quiet=await assertQuietDialogs(app);await verifyEditorBuild(sessionEvidence);
    await app.close();currentApp=undefined;currentPage=undefined;
  }
  assert.deepEqual(errors,[]);for(const reference of references)assert.equal(await hashFile(reference.file),reference.sha256,'Original font reference changed');
  const result={...evidence,passed:true,completedAt:new Date().toISOString(),work,checks,errors,referenceFonts:references.map(({base64,...reference})=>reference),bundle,sessions,scope:'Local face resolution is compared by exact metrics/pixels against unchanged user-provided font bytes. Missing-font cases use test-only CSS-local source substitution, not operating-system font removal. No REATIC binary is distributed or modified.'};
  await fs.writeFile(path.join(work,'results.json'),JSON.stringify(result,null,2));await fs.writeFile(pointer,work+'\n');console.log(JSON.stringify({work,pointer,checks,sessions:sessions.map(({name,exports})=>({name,exports:exports.length}))}));
}catch(error){
  if(currentApp)await captureElectron(currentApp,{path:path.join(work,'failure.png')}).catch(()=>{});
  const audit=currentApp?await currentApp.evaluate(()=>globalThis.reaticAudit).catch(()=>undefined):undefined;
  await fs.writeFile(path.join(work,'failure.json'),JSON.stringify({evidence,checks,errors,sessions,audit,error:String(error),stack:error?.stack},null,2));throw error;
}finally{
  if(currentPage)await currentPage.evaluate(async()=>{for(const id of new Set((window.reaticJobs||[]).map(event=>event.id)))await window.studio.cancelJob(id);}).catch(()=>{});
  if(currentApp)await currentApp.close();
}
