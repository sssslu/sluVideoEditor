import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,promises as fs} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateBuildReceipt,validatePackagedBuild} from './build-receipt.mjs';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const requiredBinaries=[
  'ffmpeg.exe','ffprobe.exe','slu-audio-stretch.exe',
  'whisper-cpu/Release/whisper-cli.exe','whisper-cpu/Release/whisper.dll',
  'whisper-cpu/Release/ggml.dll','whisper-cpu/Release/ggml-base.dll','whisper-cpu/Release/ggml-cpu.dll',
];
const mattingAssets = [
  {
    file: 'resources/models/person-matting-rvm.onnx',
    bytes: 14975696,
    sha256: '88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828',
  },
  {
    file: 'resources/models/person-matting-rvm-resnet50.onnx',
    bytes: 107479165,
    sha256: '25db300fcb6ee27f941a1b52c97856e8d1f13c7f35817f81a612f89af0e8a85c',
  },
  {
    file: 'resources/licenses/RVM-LICENSE.txt',
    bytes: 35148,
    sha256: '8b1ba204bb69a0ade2bfcf65ef294a920f6bb361b317dba43c7ef29d96332b9b',
  },
];
const mattingAdapter = {
  file: 'resources/models/person-matting-rvm-bgr.onnx',
  bytes: 14979595,
  sha256: '5292c6ccbfe2fdf9a2280532885605dfb3553b6b261cae4d63d3e47c7ddd49c1',
  sourceSha256: mattingAssets[0].sha256,
  recipe: 'scripts/build-matting-model.py',
  recipeSha256: '7f248863f1847099c7cc5f43de670e8855c5da57d00d6e4735ed1e82a570753b',
};
const precisionAdapter = {
  file: 'resources/models/person-matting-rvm-resnet50-bgr.onnx',
  bytes: 107483061,
  sha256: 'f95503b9719810647c58a1c5136a9e3b052d3612ae93ee233edc3b56e50a6c32',
  sourceSha256: mattingAssets[1].sha256,
  recipe: mattingAdapter.recipe,
  recipeSha256: mattingAdapter.recipeSha256,
  recipeVariant: 'resnet50',
};
const requiredModels = [
  'object-tracking-vit.onnx',
  path.basename(mattingAssets[0].file),
  path.basename(mattingAdapter.file),
  path.basename(mattingAssets[1].file),
  path.basename(precisionAdapter.file),
];
const archiveKey=value=>value.replaceAll('\\','/').replace(/^\.\//,'').toLowerCase();
const readJson=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));

/** Parse 7-Zip's technical listing without depending on aligned columns or locale. */
export function parseTechnicalList(text){
  const normalized=text.replaceAll('\r',''),separator=normalized.indexOf('\n----------\n');
  if(separator<0)throw new Error('7-Zip technical listing has no entry separator.');
  const properties=block=>Object.fromEntries(block.split('\n').flatMap(line=>{const match=/^([^=]+?) = (.*)$/.exec(line);return match?[[match[1].trim(),match[2]]]:[];}));
  const header=properties(normalized.slice(0,separator));
  const entries=normalized.slice(separator+12).split(/\n\s*\n/).map(properties).filter(entry=>typeof entry.Path==='string');
  return {header,entries};
}

async function sha256(file){
  const hash=createHash('sha256');let bytes=0;for await(const block of createReadStream(file)){hash.update(block);bytes+=block.length;}
  return {bytes,sha256:hash.digest('hex')};
}

async function filesBelow(directory,prefix=''){
  const files=[];
  for(const item of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    const relative=prefix?`${prefix}/${item.name}`:item.name;
    if(item.isSymbolicLink())throw new Error(`Unexpected symbolic link in package: ${path.join(directory,item.name)}`);
    if(item.isDirectory())files.push(...await filesBelow(path.join(directory,item.name),relative));
    else if(item.isFile())files.push(relative);
  }
  return files;
}

function artifactName(template,version){
  const value=template.replaceAll('${version}',version).replaceAll('${arch}','x64').replaceAll('${ext}','exe');
  if(value.includes('${')||path.basename(value)!==value)throw new Error(`Unsupported installer artifact name: ${template}`);
  return value;
}

export async function verifyPackage(){
  const pkg=await readJson(path.join(workspace,'package.json'));
  if(typeof pkg.version!=='string'||!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version))throw new Error('package.json has an invalid release version.');
  const version=pkg.version,root=path.join(workspace,'.test-artifacts','package-integrity');
  const stamp=new Date().toISOString().replaceAll(':','-').replaceAll('.','-');
  const artifactDirectory=path.join(root,`${version}-${stamp}-${process.pid}`);await fs.mkdir(artifactDirectory,{recursive:true});
  const releaseDirectory=path.resolve(workspace,pkg.build?.directories?.output||'release');
  const installerPath=path.join(releaseDirectory,artifactName(pkg.build?.nsis?.artifactName||'SLU-Studio-Setup-${version}-x64.exe',version));
  const unpackedDirectory=path.join(releaseDirectory,'win-unpacked');
  const sevenZip=path.join(workspace,'node_modules','electron-winstaller','vendor','7z-x64.exe');
  const result={schemaVersion:1,version,passed:false,startedAt:new Date().toISOString(),completedAt:null,artifactDirectory,installerPath,
    unpackedDirectory,sevenZip,checks:[],errors:[],commands:[],files:[],documentation:[],licenses:[],enhancement:[],
    installer:{path:installerPath},payload:null,
    claims:{installerPayloadIntegrityVerified:false,interactiveInstallationExecuted:false,installedApplicationExecuted:false}};
  const started=performance.now(),control=new AbortController();
  const abort=()=>control.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
  const check=(condition,message)=>{if(!condition)throw new Error(message);result.checks.push(message);};
  let commandIndex=0;
  const tool=async(args,label,{hashOutput=false}={})=>{
    if(control.signal.aborted)throw new Error('Package verification was cancelled.');
    const number=String(++commandIndex).padStart(2,'0'),prefix=path.join(artifactDirectory,`${number}-${label}`),begin=performance.now();
    const command={label,args,exitCode:null,durationSeconds:null,stderrLog:`${prefix}.stderr.log`,stdoutLog:hashOutput?null:`${prefix}.stdout.log`};result.commands.push(command);
    const record=await new Promise((resolve,reject)=>{
      const child=spawn(sevenZip,args,{cwd:workspace,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
      const chunks=[],hash=hashOutput?createHash('sha256'):undefined;let bytes=0,stderr='',failure;
      const stop=()=>{failure=new Error('Package verification was cancelled.');child.kill();};control.signal.addEventListener('abort',stop,{once:true});
      const timeout=setTimeout(()=>{failure=new Error(`7-Zip timed out during ${label}.`);child.kill();},15*60*1000);
      child.stdout.on('data',data=>{bytes+=data.length;if(hash)hash.update(data);else if(bytes<=64*1024*1024)chunks.push(data);else{failure=new Error('7-Zip listing exceeded64MiB.');child.kill();}});
      child.stderr.on('data',data=>{stderr=(stderr+data.toString('utf8')).slice(-4*1024*1024);});
      child.on('error',error=>{failure=error;});
      child.on('close',(code,signal)=>{clearTimeout(timeout);control.signal.removeEventListener('abort',stop);resolve({code,signal,stdout:hash?'':Buffer.concat(chunks).toString('utf8'),stderr,bytes,sha256:hash?.digest('hex'),failure});});
    });
    command.exitCode=record.code;command.signal=record.signal;command.durationSeconds=(performance.now()-begin)/1000;command.stdoutBytes=record.bytes;
    await fs.writeFile(command.stderrLog,record.stderr);if(command.stdoutLog)await fs.writeFile(command.stdoutLog,record.stdout);if(record.sha256)command.stdoutSha256=record.sha256;
    if(record.failure)throw record.failure;
    if(record.code!==0)throw new Error(`7-Zip ${label} failed (${record.code}): ${record.stderr.slice(-3000)||record.stdout.slice(-3000)}`);
    return record;
  };
  try{
    const buildReceipt = await validateBuildReceipt(workspace);
    result.buildReceiptId = buildReceipt.contentId;
    check(buildReceipt.version === version, 'Build receipt version matches package.json');
    check((await fs.stat(sevenZip)).isFile(),'7-Zip executable is available');
    const installerStat=await fs.stat(installerPath);check(installerStat.isFile()&&installerStat.size>1024*1024,'Current-version NSIS installer exists');
    Object.assign(result.installer,await sha256(installerPath));
    const executableName=pkg.build?.win?.executableName||pkg.build?.productName||pkg.productName||pkg.name;
    check((await fs.stat(path.join(unpackedDirectory,`${executableName}.exe`))).isFile(),'Unpacked application executable exists');
    const actualBinaries=await filesBelow(path.join(unpackedDirectory,'resources','bin'));
    check(actualBinaries.length===requiredBinaries.length&&requiredBinaries.every(file=>actualBinaries.some(actual=>archiveKey(actual)===archiveKey(file))),`Exactly ${requiredBinaries.length} required runtime files are bundled, including only 5 Whisper CPU runtime files`);
    const require=createRequire(import.meta.url),asar=require('@electron/asar');
    const asarFile=path.join(unpackedDirectory,'resources','app.asar');
    await validatePackagedBuild(asarFile, buildReceipt);
    check(true, 'Complete packaged build file set and every output match the current source-bound build receipt');
    const bundledPackage=JSON.parse(asar.extractFile(asarFile,'package.json').toString('utf8').replace(/^\uFEFF/,''));
    result.unpackedPackageVersion=bundledPackage.version;check(bundledPackage.version===version,'Unpacked app.asar package version matches package.json');
    const asarPaths=asar.listPackage(asarFile),asarEntries=new Set(asarPaths.map(archiveKey));
    check(['/package.json','/dist/index.html','/dist/caption-export.html','/dist-electron/caption-preload.cjs',`/${pkg.main}`].every(name=>asarEntries.has(archiveKey(name))),'app.asar contains the editor and isolated caption renderer entry points');
    const scopeWorkers=asarPaths.filter(file=>/^\/dist\/assets\/scopes\.worker-[^/]+\.js$/i.test(archiveKey(file)));
    check(scopeWorkers.length===1,'Exactly one dedicated scopes worker is bundled');
    const scopeWorker=scopeWorkers[0].replace(/^[\\/]/,''),scopeBytes=asar.extractFile(asarFile,scopeWorker);
    check(scopeBytes.equals(await fs.readFile(path.join(workspace,scopeWorker))),'Bundled scopes worker matches the current build byte for byte');
    const editorScripts=asarPaths.filter(file=>/^\/dist\/assets\/editor-[^/]+\.js$/i.test(archiveKey(file)));
    check(editorScripts.some(file=>asar.extractFile(asarFile,file.replace(/^[\\/]/,'')).toString('utf8').includes(path.basename(scopeWorker))),'Editor bundle references the packaged scopes worker');
    const meterFiles=asarPaths.filter(file=>/^\/dist\/assets\/audio-meter\.worklet-[^/]+\.js$/i.test(archiveKey(file)));
    check(meterFiles.length===1,'Audio meter worklet is a bundled file, not an inline data URL');
    const meterFile=meterFiles[0].replace(/^[\\/]/,'');check(asar.extractFile(asarFile,meterFile).equals(await fs.readFile(path.join(workspace,meterFile))),'Bundled audio meter worklet matches the current build byte for byte');
    check(editorScripts.some(file=>asar.extractFile(asarFile,file.replace(/^[\\/]/,'')).toString('utf8').includes(path.basename(meterFile))),'Editor references the packaged audio meter worklet');
    const fontEntries=asarPaths.filter(file=>archiveKey(file).startsWith('/dist/assets/')&&/\.(?:ttf|otf|woff2?)$/i.test(file));
    check(fontEntries.length===5,'Exactly five font assets: four caption/fallback faces and one UI wordmark face');
    const bundledFonts=fontEntries.map(file=>{const data=asar.extractFile(asarFile,file.replace(/^[\\/]/,''));return {file,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};});
    const wordmark=await readJson(path.join(workspace,'resources/licenses/Inter-manifest.json')),wordmarkSource=await sha256(path.join(workspace,wordmark.file));
    check(wordmark.modified===false&&wordmarkSource.bytes===wordmark.bytes&&wordmarkSource.sha256===wordmark.sha256,'Inter UI wordmark source matches its pinned provenance');
    check((await sha256(path.join(workspace,'resources/licenses',wordmark.licenseFile))).sha256===wordmark.licenseSha256,'Inter UI wordmark license matches its pinned provenance');
    check(bundledFonts.filter(font=>font.sha256===wordmark.sha256&&font.bytes===wordmark.bytes).length===1,'Inter UI wordmark is bundled exactly once, separately from caption fonts');
    const captionFonts=bundledFonts.filter(font=>font.sha256!==wordmark.sha256);
    check(captionFonts.length===4,'Exactly four assets for the two caption families and emoji fallback are bundled');
    for(const name of ['NotoSansKR','NotoEmoji']){
      const font=await readJson(path.join(workspace,'resources','licenses',`${name}-manifest.json`)),source=await sha256(path.join(workspace,font.file)),license=await sha256(path.join(workspace,'resources','licenses',font.licenseFile));
      check(source.bytes===font.bytes&&source.sha256===font.sha256&&license.sha256===font.licenseSha256,`${name} font and license agree with pinned provenance`);
      check(captionFonts.filter(file=>file.sha256===font.sha256&&file.bytes===font.bytes).length===1,`${name} bundled font bytes exactly match the verified source`);
    }
    const emphasisFont=await readJson(path.join(workspace,'resources/licenses/GmarketSans-manifest.json'));
    check(emphasisFont.modified===false&&emphasisFont.files.length===2,'Gmarket Sans has exactly the unmodified medium and bold faces');
    check((await sha256(path.join(workspace,'resources/licenses',emphasisFont.licenseFile))).sha256===emphasisFont.licenseSha256,'Gmarket Sans license matches its pinned provenance');
    for(const font of emphasisFont.files){
      const source=await sha256(path.join(workspace,font.file));
      check(source.bytes===font.bytes&&source.sha256===font.sha256,`${font.file} matches pinned font provenance`);
      check(captionFonts.filter(file=>file.sha256===font.sha256&&file.bytes===font.bytes).length===1,`${font.file} is bundled exactly once`);
    }
    const trackingProvenance=await readJson(path.join(workspace,'resources/licenses/ViTTrack-provenance.json'));
    for(const asset of trackingProvenance.assets){const digest=await sha256(path.join(workspace,asset.file));check(digest.bytes===asset.bytes&&digest.sha256===asset.sha256,`Tracking provenance matches ${asset.file}`);}
    const model='resources/models/object-tracking-vit.onnx';
    check((await sha256(path.join(unpackedDirectory,model))).sha256===(await sha256(path.join(workspace,model))).sha256,'Bundled tracking model matches the pinned source');
    check(asarEntries.has('/dist-electron/tracking-worker.cjs'),'Isolated native tracking worker is bundled');
    check(asar.extractFile(asarFile,'dist-electron/tracking-worker.cjs').equals(await fs.readFile(path.join(workspace,'dist-electron/tracking-worker.cjs'))),'Bundled tracking worker matches the current build');
    const modelFiles = await filesBelow(path.join(unpackedDirectory, 'resources/models'));
    check(modelFiles.length === requiredModels.length && modelFiles.every(file => requiredModels.includes(file)),
      'Exactly the five reviewed tracking and matting models are bundled');
    const modelFilters = pkg.build.extraResources.find(item => item.to === 'models')?.filter;
    check(Array.isArray(modelFilters) && modelFilters.length === requiredModels.length && requiredModels.every(file => modelFilters.includes(file)),
      'The model package allowlist contains exactly the five reviewed models');

    const mattingProvenance = await readJson(path.join(workspace, 'resources/licenses/RVM-provenance.json'));
    check(mattingProvenance.repository === 'https://github.com/PeterL1n/RobustVideoMatting' &&
      mattingProvenance.commit === '53d74c6826735f01f4406b5ca9075eee27bec094' &&
      mattingProvenance.release === 'v1.0.0' && mattingProvenance.license === 'GPL-3.0',
      'RVM provenance identifies the reviewed upstream release and source commit');
    check(Array.isArray(mattingProvenance.assets) && mattingProvenance.assets.length === mattingAssets.length,
      'RVM provenance records exactly the two original models and license');
    for (const asset of mattingAssets) {
      const recorded = mattingProvenance.assets.find(item => item.file === asset.file);
      check(recorded?.bytes === asset.bytes && recorded?.sha256 === asset.sha256,
        `RVM provenance retains the pinned identity of ${asset.file}`);
      const digest = await sha256(path.join(workspace, asset.file));
      check(digest.bytes === asset.bytes && digest.sha256 === asset.sha256,
        `RVM source matches the reviewed bytes of ${asset.file}`);
    }
    check(Object.entries(mattingAdapter).every(([key, value]) => mattingProvenance.adapter?.[key] === value),
      'RVM adapter provenance retains its reviewed model, source model and build recipe identities');
    check(Object.entries(precisionAdapter).every(([key, value]) => mattingProvenance.precisionAdapter?.[key] === value),
      'RVM precision adapter provenance retains its reviewed model, source model and recipe variant identities');
    const recipeDigest = await sha256(path.join(workspace, mattingAdapter.recipe));
    check(recipeDigest.sha256 === mattingAdapter.recipeSha256, 'RVM adapter recipe matches the reviewed source');
    for (const asset of [mattingAssets[0], mattingAssets[1], mattingAdapter, precisionAdapter]) {
      const source = await sha256(path.join(workspace, asset.file));
      const bundled = await sha256(path.join(unpackedDirectory, asset.file));
      check(source.bytes === asset.bytes && source.sha256 === asset.sha256 &&
        bundled.bytes === asset.bytes && bundled.sha256 === asset.sha256,
        `Bundled ${path.basename(asset.file)} matches the pinned source model`);
    }
    const mattingWorker = 'dist-electron/matting-worker.cjs';
    check(asarEntries.has(`/${mattingWorker}`), 'Isolated native matting worker is bundled');
    check(asar.extractFile(asarFile, mattingWorker).equals(await fs.readFile(path.join(workspace, mattingWorker))),
      'Bundled matting worker matches the current build');
    const nativeManifest=await readJson(path.join(workspace,'resources/licenses/ONNXRuntime-binaries.json'));
    check(nativeManifest.version===pkg.dependencies['onnxruntime-node'],'Native inference version matches the package lock requirement');
    const nativeRelative='node_modules/onnxruntime-node/bin/napi-v6/win32/x64',nativeDirectory=path.join(unpackedDirectory,'resources/app.asar.unpacked',nativeRelative);
    const nativeFiles=await filesBelow(nativeDirectory);
    check(nativeFiles.length===nativeManifest.binaries.length&&nativeFiles.every(file=>nativeManifest.binaries.some(b=>b.name===file)),'Exactly the four reviewed Windows x64 inference binaries are unpacked');
    for(const binary of nativeManifest.binaries){
      const digest=await sha256(path.join(nativeDirectory,binary.name)),source=await sha256(path.join(workspace,nativeRelative,binary.name));
      check(digest.bytes===binary.bytes&&digest.sha256===binary.sha256&&source.sha256===binary.sha256,`Native ${binary.name} matches pinned source and packaged bytes`);
    }
    const comparisonPaths=['resources/app.asar',...requiredModels.map(file=>`resources/models/${file}`),...nativeFiles.map(file=>`resources/app.asar.unpacked/${nativeRelative}/${file}`),...requiredBinaries.map(file=>`resources/bin/${file}`)];
    for(const relativePath of comparisonPaths){const full=path.join(unpackedDirectory,...relativePath.split('/'));const digest=await sha256(full);check(digest.bytes>0,`${relativePath} is nonempty`);result.files.push({relativePath,unpackedPath:full,...digest,installerSha256:null,match:false});}
    for(const [name,source] of [['docs',path.join(workspace,'docs')],['licenses',path.join(workspace,'resources','licenses')]]){
      const filters=pkg.build.extraResources.find(item=>item.to===name)?.filter;
      const list=(await filesBelow(source)).filter(file=>!filters||filters.some(pattern=>new RegExp('^'+pattern.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*')+'$').test(file)));
      check(list.length>0,`Source ${name} directory is nonempty`);
      const shipped=await filesBelow(path.join(unpackedDirectory,'resources',name));
      check(shipped.length===list.length&&shipped.every(file=>list.includes(file)),`Only current ${name} files are bundled`);
      if(name==='docs')check(list.includes('사용설명서.html')&&list.includes('검증결과.md'),'User manual and verification report are present');
      else check(['THIRD-PARTY-NOTICES.md','FFmpeg-GPL.txt','Whisper-cli-LICENSE.txt','Electron-LICENSE.txt','RubberBand-LICENSE.txt','RubberBand-SLU-patch.mjs','rubberband-4.0.0-source.tar.bz2','audio-stretch-manifest.json','audio-stretch-toolchain-LICENSES.txt','audio-stretch-toolchain-manifest.json','NotoSansKR-OFL.txt','NotoSansKR-manifest.json','NotoEmoji-OFL.txt','NotoEmoji-manifest.json'].every(file=>list.includes(file)),'Core runtime licenses, audio helper source/patch, toolchain and bundled font notices are present');
      if (name === 'licenses') check(['RVM-LICENSE.txt', 'RVM-provenance.json'].every(file => list.includes(file)),
        'RVM license and original/adapter model provenance are bundled');
      if (name === 'licenses') check(['GmarketSans-LICENSE.txt','GmarketSans-manifest.json'].every(file=>list.includes(file)),
        'Gmarket Sans font license and provenance are bundled');
      for(const file of list){const relativePath=`resources/${name}/${file}`,sourceDigest=await sha256(path.join(source,...file.split('/'))),unpackedDigest=await sha256(path.join(unpackedDirectory,...relativePath.split('/')));check(sourceDigest.sha256===unpackedDigest.sha256,`${relativePath} matches the current release source`);result[name==='docs'?'documentation':'licenses'].push({relativePath,...unpackedDigest,sourceMatches:true});}
    }
    const enhancementSource=path.join(workspace,'native/enhancement');
    const enhancementFiles=(await filesBelow(enhancementSource)).filter(file=>
      ['seedvr_worker.py','tensor_loader.py','backend-manifest.json','worker-contract.json','requirements-lock.txt'].includes(file)||file.startsWith('licenses/'));
    const shippedEnhancement=await filesBelow(path.join(unpackedDirectory,'resources/enhancement'));
    check(shippedEnhancement.length===enhancementFiles.length&&shippedEnhancement.every(file=>enhancementFiles.includes(file)),
      'Exactly the enhancement worker, pinned manifest, contract and notices are bundled');
    for(const file of enhancementFiles){
      const sourceDigest=await sha256(path.join(enhancementSource,file));
      const relativePath=`resources/enhancement/${file}`;
      const unpackedDigest=await sha256(path.join(unpackedDirectory,relativePath));
      check(sourceDigest.sha256===buildReceipt.inputs[`native/enhancement/${file}`],`${file} is bound to the verified build receipt`);
      check(sourceDigest.sha256===unpackedDigest.sha256,`${relativePath} matches the release source`);
      result.enhancement.push({relativePath,...unpackedDigest,sourceMatches:true});
    }
    const listing=await tool(['l','-slt','-sccUTF-8',installerPath],'installer-list');const outer=parseTechnicalList(listing.stdout);
    result.installer.archiveType=outer.header.Type;check(outer.header.Type==='Nsis','Installer is an NSIS archive');
    const payloads=outer.entries.filter(entry=>archiveKey(entry.Path).split('/').at(-1)==='app-64.7z');check(payloads.length===1,'NSIS contains exactly one embedded app-64.7z payload');
    await tool(['t','-bd','-bsp0','-sccUTF-8',installerPath],'installer-test');check(true,'7-Zip integrity test of the NSIS installer passed');
    const embeddedDirectory=path.join(artifactDirectory,'embedded');await fs.mkdir(embeddedDirectory);
    await tool(['e','-y','-bd','-bsp0','-sccUTF-8',`-o${embeddedDirectory}`,installerPath,payloads[0].Path],'extract-payload');
    const extracted=await fs.readdir(embeddedDirectory);check(extracted.length===1&&extracted[0]==='app-64.7z','Only the embedded app-64.7z was extracted from NSIS');
    const payloadPath=path.join(embeddedDirectory,'app-64.7z');result.payload={path:payloadPath,installerEntry:payloads[0].Path,...await sha256(payloadPath),integrityPassed:false};
    const expectedSize=Number(payloads[0].Size);if(Number.isFinite(expectedSize)&&expectedSize>0)check(result.payload.bytes===expectedSize,'Extracted payload size matches the NSIS listing');
    await tool(['t','-bd','-bsp0','-sccUTF-8',payloadPath],'payload-test');result.payload.integrityPassed=true;check(true,'7-Zip integrity test of every embedded application archive member passed');
    const innerListing=await tool(['l','-slt','-sccUTF-8',payloadPath],'payload-list'),inner=parseTechnicalList(innerListing.stdout),entries=new Map();
    for(const entry of inner.entries){const key=archiveKey(entry.Path);if(entries.has(key))throw new Error(`Duplicate case-insensitive archive member: ${entry.Path}`);entries.set(key,entry);}
    const installerModels = [...entries.keys()].filter(key => key.startsWith('resources/models/'));
    check(installerModels.length === requiredModels.length && requiredModels.every(file => installerModels.includes(`resources/models/${file}`)),
      'Installer contains exactly the five reviewed ONNX models');
    result.payload.archiveType=inner.header.Type;result.payload.entryCount=inner.entries.length;check(inner.header.Type==='7z','Embedded application payload is a7z archive');
    for(const file of [...result.files,...result.documentation,...result.licenses,...result.enhancement]){const entry=entries.get(archiveKey(file.relativePath));check(!!entry&&Number(entry.Size)===file.bytes,`Installer contains ${file.relativePath} with the expected size`);}
    // Stream selected members into SHA256 without extracting or executing any
    // application/runtime executable, and without holding large binaries in RAM.
    for(const file of result.files){const entry=entries.get(archiveKey(file.relativePath));const digest=await tool(['x','-so','-bd','-bsp0','-sccUTF-8',payloadPath,entry.Path],`sha256-${path.basename(file.relativePath).replace(/[^A-Za-z0-9.-]/g,'_')}`,{hashOutput:true});file.installerSha256=digest.sha256;file.installerBytes=digest.bytes;file.match=digest.bytes===file.bytes&&digest.sha256===file.sha256;check(file.match,`Installer SHA256 equals unpacked ${file.relativePath}`);}
    // Extract the exact documentation/notice members together: solid 7z archives
    // should be decompressed once for these files, not once per small notice.
    const documents=[...result.documentation,...result.licenses,...result.enhancement],documentDirectory=path.join(artifactDirectory,'documents'),documentList=path.join(artifactDirectory,'document-members.txt');
    await fs.mkdir(documentDirectory);await fs.writeFile(documentList,documents.map(file=>entries.get(archiveKey(file.relativePath)).Path).join('\n')+'\n','utf8');
    await tool(['x','-y','-bd','-bsp0','-sccUTF-8','-scsUTF-8','-spd',`-o${documentDirectory}`,payloadPath,`@${documentList}`],'extract-documentation');
    const extractedDocuments=await filesBelow(documentDirectory),expectedDocuments=new Set(documents.map(file=>archiveKey(file.relativePath)));
    check(extractedDocuments.length===documents.length&&extractedDocuments.every(file=>expectedDocuments.has(archiveKey(file))),'Only the expected documentation and license members were extracted');
    const extractedPaths=new Map(extractedDocuments.map(file=>[archiveKey(file),file]));
    for(const file of documents){
      const extractedPath=extractedPaths.get(archiveKey(file.relativePath));
      const digest=await sha256(path.join(documentDirectory,...extractedPath.split('/')));
      file.installerSha256=digest.sha256;file.installerBytes=digest.bytes;file.match=digest.bytes===file.bytes&&digest.sha256===file.sha256;
      check(file.match,`Installer SHA256 equals current source and unpacked ${file.relativePath}`);
    }
    const helperManifest=await readJson(path.join(unpackedDirectory,'resources','licenses','audio-stretch-manifest.json'));
    const helper=result.files.find(file=>file.relativePath==='resources/bin/slu-audio-stretch.exe');
    check(helperManifest.helperSha256===helper.sha256&&helperManifest.helperBytes===helper.bytes,'Audio helper binary matches its shipped provenance manifest');
    const recipeFiles=['native/audio-stretch.cpp','native/patch-rubberband.mjs','scripts/build-audio-stretch.mjs'];
    check(recipeFiles.every(file=>typeof helperManifest.recipe?.[file]==='string'),'Audio helper manifest records every source/build recipe hash');
    for(const file of recipeFiles)check((await sha256(path.join(workspace,...file.split('/')))).sha256===helperManifest.recipe[file],`Audio helper recipe is current: ${file}`);
    check((await sha256(path.join(workspace,'native','patch-rubberband.mjs'))).sha256===(await sha256(path.join(unpackedDirectory,'resources','licenses','RubberBand-SLU-patch.mjs'))).sha256,'Shipped Rubber Band patch matches the helper build source');
    const toolchainManifest=await readJson(path.join(unpackedDirectory,'resources','licenses','audio-stretch-toolchain-manifest.json'));
    check(toolchainManifest.compiler===helperManifest.compiler,'Static toolchain notices identify the audio helper compiler');
    check(toolchainManifest.licenseFileSha256===(await sha256(path.join(unpackedDirectory,'resources','licenses','audio-stretch-toolchain-LICENSES.txt'))).sha256,'Static toolchain notice bytes match their provenance manifest');
    result.passed=true;result.claims.installerPayloadIntegrityVerified=true;
  }catch(error){result.errors.push(error instanceof Error?error.stack||error.message:String(error));}
  finally{
    process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);result.completedAt=new Date().toISOString();result.durationSeconds=(performance.now()-started)/1000;
    const serialized=JSON.stringify(result,null,2)+'\n';await fs.writeFile(path.join(artifactDirectory,'results.json'),serialized,'utf8');await fs.writeFile(path.join(root,'results.json'),serialized,'utf8');
  }
  console.log(JSON.stringify({version,passed:result.passed,installerPath,resultsPath:path.join(root,'results.json'),artifactDirectory,checks:result.checks.length,errors:result.errors},null,2));
  return result;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--help'))console.log('Usage: node scripts/verify-package.mjs\nChecks the current package.json version in release/win-unpacked and its NSIS installer.\nDoes not launch or install the application. Keeps all extracted artifacts and logs.\nWrites .test-artifacts/package-integrity/results.json and a version/timestamp run directory.');
  else if(process.argv.length>2){console.error('Unknown arguments. Use --help.');process.exitCode=2;}
  else try{if(!(await verifyPackage()).passed)process.exitCode=1;}catch(error){console.error(error);process.exitCode=1;}
}
