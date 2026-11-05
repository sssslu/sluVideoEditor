import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchTestElectron,electronTestArgs,captureElectron,assertQuietDialogs} from './e2e-launch.mjs';

const legacy=process.argv.includes('--expect-legacy');
const buildEvidence=legacy?null:await import('./e2e-release-evidence.mjs');
assert.ok(process.argv.slice(2).every(argument=>argument==='--expect-legacy'));
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
assert.ok(!legacy||executable,'Legacy reproduction requires the preserved packaged executable');
const artifactRoot=path.resolve('.test-artifacts/encoder-picker-regression');
await fs.mkdir(artifactRoot,{recursive:true});
const featurePointer=path.resolve(`.test-artifacts/encoder-picker-regression-current-${executable?'packaged':'source'}.txt`);
if(!legacy)await fs.rm(featurePointer,{force:true});
const profile=await fs.mkdtemp(path.join(artifactRoot,'profile-'));
const hashFile=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const script=fileURLToPath(import.meta.url),scriptSha256=await hashFile(script);
const app=await launchTestElectron({
  ...(executable?{executablePath:executable}:{}),
  args:electronTestArgs(!!executable),
  env:{...process.env,SLU_USER_DATA:profile},
  timeout:90000,
});
let directory;
const checks=[],observations=[],errors=[];
try {
  const evidence=buildEvidence?await buildEvidence.editorEvidence(app,import.meta.url):null;
  const runtime=await app.evaluate(({app,BrowserWindow})=>({
    version:app.getVersion(),executable:process.execPath,appPath:app.getAppPath(),
    packaged:app.isPackaged,hidden:BrowserWindow.getAllWindows().every(window=>!window.isVisible()),
  }));
  assert.equal(runtime.packaged,!!executable);
  assert.equal(runtime.hidden,true);
  if(legacy)assert.equal(runtime.version,'1.10.0');
  else assert.equal(runtime.version,JSON.parse(await fs.readFile('package.json','utf8')).version);
  const versionRoot=path.join(artifactRoot,runtime.version);
  await fs.mkdir(versionRoot,{recursive:true});
  directory=await fs.mkdtemp(path.join(versionRoot,'proof-'));
  const runtimeHashes={executable:await hashFile(runtime.executable)};
  if(runtime.packaged)runtimeHashes.asar=await hashFile(runtime.appPath);
  const page=await app.firstWindow();
  page.on('pageerror',error=>errors.push(String(error)));
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
  await page.getByRole('button',{name:'설정',exact:true}).click();
  await page.waitForFunction(()=>Boolean(document.querySelectorAll('.settings-values dd')[2]?.textContent?.trim()),null,{timeout:90000});
  // Only device capabilities and the export IPC sink are mocked. The real
  // editor renders its normal dialog and submits its own settings callback.
  await app.evaluate(({ipcMain})=>{
    globalThis.encoderPickerCaptures=[];
    ipcMain.removeHandler('project:export');
    ipcMain.handle('project:export',(_event,project,settings)=>{
      globalThis.encoderPickerCaptures.push({projectId:project.id,settings});
      return null;
    });
  });
  await page.getByRole('button',{name:'텍스트',exact:true}).first().click();
  await page.getByRole('button',{name:'줄 배경 텍스트 삽입',exact:true}).click();
  assert.equal(await page.locator('.timeline-clip').count(),1);
  const codec=page.getByLabel('비디오 코덱',{exact:true});
  const encoder=page.getByLabel('인코더 선택',{exact:true});
  const format=page.getByLabel('내보내기 형식',{exact:true});
  const codecs=['h264','hevc','av1'],backends=['nvenc','qsv','amf'];
  let captures=0,caseNumber=0;
  async function open(capabilities) {
    if(await page.getByRole('dialog',{name:'내보내기',exact:true}).count())await page.keyboard.press('Escape');
    const label=`Capability fixture ${++caseNumber}`;
    await app.evaluate(({ipcMain,app},{capabilities,label})=>{
      ipcMain.removeHandler('system:info');
      ipcMain.handle('system:info',()=>({version:app.getVersion(),ffmpegVersion:'mocked capabilities',gpu:label,
        encoders:capabilities,hardwareAcceleration:capabilities.length>0,modelReady:false,modelDirectory:'',cacheDirectory:''}));
    },{capabilities,label});
    await page.getByRole('button',{name:'설정',exact:true}).click();
    await page.getByRole('button',{name:'하드웨어 상태 새로고침',exact:true}).click();
    await page.getByText(label,{exact:true}).waitFor();
    await page.getByRole('button',{name:'내보내기',exact:true}).click();
    await codec.waitFor();
  }
  async function submitted(expected) {
    await page.getByRole('button',{name:'내보내기 시작',exact:true}).click();
    const capture=await app.evaluate(async(_electron,count)=>{
      for(let attempt=0;attempt<200;attempt++){
        if(globalThis.encoderPickerCaptures.length>=count)return globalThis.encoderPickerCaptures[count-1];
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      throw Error('Export settings callback did not reach IPC');
    },++captures);
    for(const [key,value] of Object.entries(expected))assert.equal(capture.settings[key],value,`Submitted ${key}`);
    return capture.settings;
  }
  for(const backend of backends) {
    for(const supportedCodec of codecs) {
      const capabilities=[`${supportedCodec}_${backend}`];
      await open(capabilities);
      for(const targetCodec of codecs) {
        await codec.selectOption(supportedCodec);
        await encoder.selectOption(backend);
        await codec.selectOption(targetCodec);
        const supported=targetCodec===supportedCodec;
        const expectedEncoder=legacy||supported?backend:'auto';
        assert.equal(await encoder.inputValue(),expectedEncoder);
        for(const optionBackend of backends){
          const disabled=await encoder.locator(`option[value="${optionBackend}"]`).evaluate(option=>option.disabled);
          assert.equal(disabled,optionBackend!==backend||(!legacy&&!supported),`${capabilities}: ${targetCodec}/${optionBackend} availability`);
        }
        const settings=await submitted({format:'mp4',codec:targetCodec,encoder:expectedEncoder});
        observations.push({capabilities,targetCodec,supported,settings});
      }
      checks.push(`${backend}: ${supportedCodec}-only capabilities govern all three codec choices and submitted settings`);
    }
  }
  if(legacy){
    assert.equal(observations.filter(row=>!row.supported&&row.settings.encoder!=='auto').length,18);
    checks.push('Preserved1.10 reproduces18 unsupported codec/backend selections reaching export IPC');
  }else{
    await open([]);
    for(const softwareChoice of ['cpu','auto']){
      await encoder.selectOption(softwareChoice);
      for(const targetCodec of codecs){
        await codec.selectOption(targetCodec);
        assert.equal(await encoder.inputValue(),softwareChoice);
        await submitted({format:'mp4',codec:targetCodec,encoder:softwareChoice});
      }
    }
    checks.push('CPU and automatic selections survive codec changes with no hardware capabilities');
    for(const backend of backends){
      await open(codecs.map(name=>`${name}_${backend}`));
      await encoder.selectOption(backend);
      for(const targetCodec of codecs){
        await codec.selectOption(targetCodec);
        assert.equal(await encoder.inputValue(),backend);
        await submitted({format:'mp4',codec:targetCodec,encoder:backend});
      }
      for(const targetFormat of ['gif','wav']){
        await format.selectOption(targetFormat);
        assert.equal(await encoder.count(),0);
        await submitted({format:targetFormat,codec:'av1',encoder:backend});
        await format.selectOption('mp4');
        assert.equal(await codec.inputValue(),'av1');
        assert.equal(await encoder.inputValue(),backend);
      }
      await format.selectOption('webm');
      assert.equal(await encoder.count(),0);
      await submitted({format:'webm',codec:'h264',encoder:'cpu'});
      await format.selectOption('mp4');
      assert.equal(await codec.inputValue(),'h264');
      assert.equal(await encoder.inputValue(),'cpu');
      checks.push(`${backend}: supported codec switches, GIF/WAV roundtrips and WebM CPU reset preserve existing policy`);
    }
  }
  await captureElectron(app,{path:path.join(directory,'export-dialog.png')});
  const quiet=await assertQuietDialogs(app);
  assert.deepEqual(errors,[]);
  assert.equal(await hashFile(script),scriptSha256,'Regression harness changed during execution');
  assert.equal(await hashFile(runtime.executable),runtimeHashes.executable);
  if(runtime.packaged)assert.equal(await hashFile(runtime.appPath),runtimeHashes.asar);
  if(evidence)await buildEvidence.verifyEditorBuild(evidence);
  await fs.writeFile(path.join(directory,'results.json'),JSON.stringify({
    ...evidence,passed:true,legacyReproduction:legacy,runtime,runtimeHashes,scriptSha256,checks,observations,
    submittedSettings:captures,errors,quiet,profile,
    scope:'Actual editor dialog with mocked capability lists and captured export IPC. No fabricated GPU export is executed.',
  },null,2));
  console.log(JSON.stringify({directory,passed:true,legacyReproduction:legacy,checks:checks.length,submittedSettings:captures}));
}catch(error){
  if(directory)await fs.writeFile(path.join(directory,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,checks,observations,errors},null,2));
  throw error;
}finally{
  await app.close();
}
if(!legacy){
  const filename=path.join(directory,'results.json'),result=JSON.parse(await fs.readFile(filename,'utf8'));
  result.completedAt=new Date().toISOString();
  await fs.writeFile(filename,JSON.stringify(result,null,2));
  await fs.writeFile(featurePointer,directory+'\n');
}
