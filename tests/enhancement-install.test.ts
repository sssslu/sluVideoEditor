import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {enhancementInstallState,installEnhancementRuntime,verifyEnhancementRuntime,enhancementInventoryDigest,type EnhancementInstallContext} from '../electron/enhancement-install';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function crc32(bytes:Buffer) {
  let value=0xffffffff;
  for(const byte of bytes) {value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}
  return (value^0xffffffff)>>>0;
}
function zip(entries:[string,string][]) {
  const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
  for(const [filename,content] of entries) {
    const name=Buffer.from(filename),bytes=Buffer.from(content),header=Buffer.alloc(30),directory=Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc32(bytes),14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
    directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt32LE(crc32(bytes),16);directory.writeUInt32LE(bytes.length,20);directory.writeUInt32LE(bytes.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
    local.push(header,name,bytes);central.push(directory,name);offset+=header.length+name.length+bytes.length;
  }
  const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,index,end]);
}
function tar(entries:{name:string;type?:string;content:string}[]) {
  const chunks:Buffer[]=[];
  for(const entry of entries) {
    const body=Buffer.from(entry.content),header=Buffer.alloc(512);
    header.write(entry.name,0,100,'utf8');header.write('0000644\0',100,8);header.write(body.length.toString(8).padStart(11,'0')+'\0',124,12);header.fill(32,148,156);header.write(entry.type||'0',156,1);header.write('ustar\0',257,6);
    const checksum=header.reduce((sum,value)=>sum+value,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);
    chunks.push(header,body,Buffer.alloc((512-body.length%512)%512));
  }
  return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
async function fixture(wheelEntries:[string,string][]=[['package.py','x=1'],['demo.data/purelib/pure.py','pure=1'],['demo.data/platlib/native.pyd','binary']]) {
  const root=path.resolve('.test-artifacts/enhancement-install-unit');await fs.mkdir(root,{recursive:true});
  const directory=await fs.mkdtemp(path.join(root,'case-')),payloadDirectory=path.join(directory,'payloads'),licensesDirectory=path.join(directory,'licenses');
  await fs.mkdir(payloadDirectory);await fs.mkdir(licensesDirectory);
  const pythonEntries:[string,string][]=[['python.exe','MZ test fixture'],['python313._pth','old path']];
  const payloads=new Map<string,Buffer>([['python.zip',zip(pythonEntries)],['vendor.whl',zip(wheelEntries)],['model.bin',Buffer.from('model data requiring exact integrity')]]);
  const artifacts=[
    {id:'python',filename:'python.zip',destination:'python',archive:{type:'zip'},unpackedBytes:pythonEntries.reduce((sum,entry)=>sum+Buffer.byteLength(entry[1]),0),maximumEntries:pythonEntries.length},
    {id:'vendor',filename:'vendor.whl',destination:'vendor',archive:{type:'wheel'},unpackedBytes:wheelEntries.reduce((sum,entry)=>sum+Buffer.byteLength(entry[1]),0),maximumEntries:wheelEntries.length},
    {id:'model',filename:'model.bin',destination:'models/model.bin',archive:{type:'file'},unpackedBytes:payloads.get('model.bin')!.length,maximumEntries:1},
  ].map(artifact=>({...artifact,url:`https://example.invalid/${artifact.filename}`,bytes:payloads.get(artifact.filename)!.length,sha256:sha(payloads.get(artifact.filename)!)}));
  for(const [filename,bytes] of payloads)await fs.writeFile(path.join(payloadDirectory,filename),bytes);
  const license=Buffer.from('Fixture license');await fs.writeFile(path.join(licensesDirectory,'LICENSE.txt'),license);
  const manifest={schemaVersion:1,backendId:'fixture',platform:process.platform,architecture:process.arch,pythonExecutable:'python/python.exe',pythonPath:{file:'python/python313._pth',content:'python313.zip\n.\n../vendor\nimport site\n'},minimumFreeBytes:32*1024*1024,totalDownloadBytes:artifacts.reduce((sum,artifact)=>sum+artifact.bytes,0),totalUnpackedBytes:artifacts.reduce((sum,artifact)=>sum+artifact.unpackedBytes,0),artifacts,licenseFiles:[{filename:'LICENSE.txt',bytes:license.length,sha256:sha(license)}],expectedInstalledFilesSha256:''};
  const metadata=JSON.stringify({schemaVersion:1,files:manifest.licenseFiles});
  await fs.writeFile(path.join(licensesDirectory,'metadata.json'),metadata);
  const expectedFiles=new Map<string,Buffer>([
    ['python/python.exe',Buffer.from(pythonEntries[0][1])],['python/python313._pth',Buffer.from(manifest.pythonPath.content)],
    ['models/model.bin',payloads.get('model.bin')!],['licenses/LICENSE.txt',license],['licenses/metadata.json',Buffer.from(metadata)],
  ]);
  for(const [filename,content] of wheelEntries)expectedFiles.set('vendor/'+filename.replace(/^[^/]+\.data\/(?:purelib|platlib)\//,''),Buffer.from(content));
  const manifestPath=path.join(directory,'manifest.json');
  const write=()=>{manifest.expectedInstalledFilesSha256=enhancementInventoryDigest([...expectedFiles].map(([file,bytes])=>({path:file,bytes:bytes.length,sha256:sha(bytes)})));return fs.writeFile(manifestPath,JSON.stringify(manifest));};await write();
  const context:EnhancementInstallContext={runtimeBase:path.join(directory,'runtimes'),manifestPath,payloadDirectory,licensesDirectory};
  return {directory,context,manifest,payloads,expectedFiles,write};
}

test('enhancement installer publishes a complete isolated runtime, maps wheel paths and detects byte/metadata tampering',async()=>{
  const f=await fixture();assert.equal((await enhancementInstallState(f.context)).installed,false);
  const result=await installEnhancementRuntime(f.context);
  assert.equal((await enhancementInstallState(f.context)).installed,true);
  assert.deepEqual(await verifyEnhancementRuntime(f.context),result);
  assert.equal(await fs.readFile(path.join(result.runtimeRoot,'vendor/pure.py'),'utf8'),'pure=1');
  assert.equal(await fs.readFile(path.join(result.runtimeRoot,'vendor/native.pyd'),'utf8'),'binary');
  assert.equal(await fs.readFile(path.join(result.runtimeRoot,'python/python313._pth'),'utf8'),f.manifest.pythonPath.content);
  assert.equal(await fs.readFile(path.join(result.runtimeRoot,'licenses/LICENSE.txt'),'utf8'),'Fixture license');
  const file=path.join(result.runtimeRoot,'vendor/package.py'),before=await fs.stat(file);
  await fs.writeFile(file,'x=2');await fs.utimes(file,before.atime,before.mtime);
  assert.equal((await enhancementInstallState(f.context)).installed,false);
  await assert.rejects(verifyEnhancementRuntime(f.context),/손상/);
  await installEnhancementRuntime(f.context);
  assert.equal((await enhancementInstallState(f.context)).installed,true);
  await fs.writeFile(path.join(result.runtimeRoot,'vendor/unexpected.py'),'unexpected');
  await assert.rejects(verifyEnhancementRuntime(f.context),/구성이 변경/);
});

test('changing both a runtime file and its local registry cannot replace the manifest trust anchor',async()=>{
  const f=await fixture(),result=await installEnhancementRuntime(f.context),file=path.join(result.runtimeRoot,'vendor/package.py');
  await fs.writeFile(file,'x=9');
  const registryPath=path.join(result.runtimeRoot,'.complete.json'),registry=JSON.parse(await fs.readFile(registryPath,'utf8'));
  registry.files.find((record:{path:string})=>record.path==='vendor/package.py').sha256=sha('x=9');
  await fs.writeFile(registryPath,JSON.stringify(registry));
  assert.equal((await enhancementInstallState(f.context)).installed,false);
  await assert.rejects(verifyEnhancementRuntime(f.context),/배포 정보/);
});

test('archive traversal, wheel target collisions and unapproved wheel data fail without publishing',async()=>{
  for(const entries of [[['../outside.py','bad']],[['package.py','first'],['demo.data/purelib/package.py','second']],[['demo.data/scripts/run.exe','bad']]] as [string,string][][]) {
    const f=await fixture(entries);
    await assert.rejects(installEnhancementRuntime(f.context));
    assert.equal((await enhancementInstallState(f.context)).installed,false);
    assert.deepEqual((await fs.readdir(f.context.runtimeBase)).filter(name=>name.startsWith('.install-')),[]);
  }
});

test('download cancellation retains a bounded partial, retries with exact HTTP Range and rejects a bad range',async()=>{
  const f=await fixture(),context={...f.context,payloadDirectory:undefined},originalFetch=globalThis.fetch,controller=new AbortController(),requests:string[]=[];
  let cancel=true;
  globalThis.fetch=async(input,init)=>{
    const filename=new URL(String(input)).pathname.slice(1),bytes=f.payloads.get(filename)!;
    const range=new Headers(init?.headers).get('Range');requests.push(`${filename}:${range||'full'}`);
    const offset=range?Number(range.match(/\d+/)![0]):0,body=bytes.subarray(offset),half=Math.ceil(body.length/2);
    return new Response(new ReadableStream({start(stream){stream.enqueue(body.subarray(0,half));stream.enqueue(body.subarray(half));stream.close();}}),{status:offset?206:200,headers:{'content-length':String(body.length),...(offset?{'content-range':`bytes ${offset}-${bytes.length-1}/${bytes.length}`}:{})}});
  };
  try {
    await assert.rejects(installEnhancementRuntime(context,progress=>{if(cancel&&progress>0){cancel=false;controller.abort();}},controller.signal));
    const partial=path.join(context.runtimeBase,'downloads',f.manifest.artifacts[0].sha256+'.part');
    const received=(await fs.stat(partial)).size;assert.ok(received>0&&received<f.manifest.artifacts[0].bytes);
    await installEnhancementRuntime(context);
    assert.ok(requests.includes(`python.zip:bytes=${received}-`));
    assert.equal((await enhancementInstallState(context)).installed,true);
    const bad=await fixture(),badContext={...bad.context,payloadDirectory:undefined};
    await fs.mkdir(path.join(badContext.runtimeBase,'downloads'),{recursive:true});
    await fs.writeFile(path.join(badContext.runtimeBase,'downloads',bad.manifest.artifacts[0].sha256+'.part'),bad.payloads.get('python.zip')!.subarray(0,12));
    globalThis.fetch=async()=>new Response(Buffer.from('bad'),{status:206,headers:{'content-range':'bytes 0-2/3'}});
    await assert.rejects(installEnhancementRuntime(badContext),/再開|재개/);
    assert.equal((await enhancementInstallState(badContext)).installed,false);
  } finally {globalThis.fetch=originalFetch;}
});

test('concurrent installations refuse a live owner and recover an exact stale owner',async()=>{
  const f=await fixture(),context={...f.context,payloadDirectory:undefined},originalFetch=globalThis.fetch,controller=new AbortController();
  let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),unblock=new Promise<void>(resolve=>{release=resolve;});
  globalThis.fetch=async()=>{entered();await unblock;return new Response(Uint8Array.from(f.payloads.get('python.zip')!));};
  const first=installEnhancementRuntime(context,undefined,controller.signal);
  try {
    await waiting;
    await assert.rejects(installEnhancementRuntime(context),/이미 진행/);
    controller.abort();release();await assert.rejects(first);
    const lock=path.join(context.runtimeBase,'.install-lock');await fs.mkdir(lock);
    await fs.writeFile(path.join(lock,'owner-2147483647-00000000-0000-0000-0000-000000000000.json'),'{}');
    await installEnhancementRuntime(f.context);
    assert.equal((await enhancementInstallState(f.context)).installed,true);
  } finally {controller.abort();release();await first.catch(()=>{});globalThis.fetch=originalFetch;}
});

test('small source tar permits exact timestamp PAX metadata and rejects a path override',async()=>{
  for(const [metadata,accepted] of [['14 mtime=1234\n',true],['21 path=../escape.py\n',false]] as const) {
    const f=await fixture(),items=[{name:'././@PaxHeader',type:'x',content:metadata},{name:'package/src/antlr4/runtime.py',content:'runtime=1'}];
    const bytes=tar(items),filename='source.tar.gz';await fs.writeFile(path.join(f.context.payloadDirectory!,filename),bytes);
    const artifact={id:'source',filename,url:`https://example.invalid/${filename}`,destination:'vendor',archive:{type:'tar.gz',mappings:[{source:'package/src/antlr4/',destination:'antlr4/'}]},bytes:bytes.length,sha256:sha(bytes),unpackedBytes:items.reduce((sum,item)=>sum+Buffer.byteLength(item.content),0),maximumEntries:2};
    f.manifest.artifacts.push(artifact as typeof f.manifest.artifacts[number]);f.manifest.totalDownloadBytes+=bytes.length;f.manifest.totalUnpackedBytes+=artifact.unpackedBytes;f.expectedFiles.set('vendor/antlr4/runtime.py',Buffer.from('runtime=1'));await f.write();
    if(accepted) {const result=await installEnhancementRuntime(f.context);assert.equal(await fs.readFile(path.join(result.runtimeRoot,'vendor/antlr4/runtime.py'),'utf8'),'runtime=1');}
    else await assert.rejects(installEnhancementRuntime(f.context),/PAX/);
  }
});

test('portable CRT mapping replaces only explicitly excluded Python DLLs and never installs debug files',async()=>{
  const f=await fixture(),pythonEntries:[string,string][]=[['python.exe','MZ test fixture'],['python313._pth','old path'],['vcruntime140.dll','older runtime']];
  const python=zip(pythonEntries),first=f.manifest.artifacts[0];
  Object.assign(first,{bytes:python.length,sha256:sha(python),unpackedBytes:pythonEntries.reduce((sum,item)=>sum+Buffer.byteLength(item[1]),0),maximumEntries:pythonEntries.length});
  Object.assign(first.archive,{ignoredPaths:['vcruntime140.dll']});
  await fs.writeFile(path.join(f.context.payloadDirectory!,'python.zip'),python);
  const entries:[string,string][]=[['Contents/retail/msvcp140.dll','retail cpp'],['Contents/retail/vcruntime140.dll','retail c'],['Contents/debug_nonredist/debug.dll','debug excluded'],['manifest.xml','metadata excluded']];
  const bytes=zip(entries),filename='crt.vsix',artifact={id:'crt',filename,url:`https://example.invalid/${filename}`,destination:'python',archive:{type:'zip',mappings:[{source:'Contents/retail/',destination:''}]},bytes:bytes.length,sha256:sha(bytes),unpackedBytes:entries.reduce((sum,item)=>sum+Buffer.byteLength(item[1]),0),maximumEntries:entries.length};
  await fs.writeFile(path.join(f.context.payloadDirectory!,filename),bytes);
  f.manifest.artifacts.push(artifact as typeof f.manifest.artifacts[number]);
  f.manifest.totalDownloadBytes=f.manifest.artifacts.reduce((sum,item)=>sum+item.bytes,0);
  f.manifest.totalUnpackedBytes=f.manifest.artifacts.reduce((sum,item)=>sum+item.unpackedBytes,0);
  f.expectedFiles.set('python/msvcp140.dll',Buffer.from('retail cpp'));f.expectedFiles.set('python/vcruntime140.dll',Buffer.from('retail c'));await f.write();
  const result=await installEnhancementRuntime(f.context);
  assert.equal(await fs.readFile(path.join(result.runtimeRoot,'python/vcruntime140.dll'),'utf8'),'retail c');
  assert.equal(await fs.readFile(path.join(result.runtimeRoot,'python/msvcp140.dll'),'utf8'),'retail cpp');
  assert.equal(await fs.stat(path.join(result.runtimeRoot,'python/debug.dll')).then(()=>true,()=>false),false);
  assert.equal((await enhancementInstallState(f.context)).installed,true);
});

test('stale staging cleanup requires exact name, matching ownership marker and a dead owner',async()=>{
  const f=await fixture();await fs.mkdir(f.context.runtimeBase,{recursive:true});
  const cases=[
    {token:'11111111-1111-1111-1111-111111111111',pid:2147483647,remove:true},
    {token:'22222222-2222-2222-2222-222222222222',pid:process.pid,remove:false},
    {token:'33333333-3333-3333-3333-333333333333',pid:undefined,remove:false},
  ];
  for(const item of cases) {
    const directory=path.join(f.context.runtimeBase,'.install-'+item.token);await fs.mkdir(directory);await fs.writeFile(path.join(directory,'owned.txt'),'staging');
    if(item.pid)await fs.writeFile(directory+'.owner.json',JSON.stringify({token:item.token,pid:item.pid}));
  }
  await fs.mkdir(path.join(f.context.runtimeBase,'personal-files'));
  await installEnhancementRuntime(f.context);
  for(const item of cases)assert.equal(await fs.stat(path.join(f.context.runtimeBase,'.install-'+item.token)).then(()=>true,()=>false),!item.remove);
  assert.equal(await fs.stat(path.join(f.context.runtimeBase,'personal-files')).then(()=>true,()=>false),true);
});

test('an already cancelled runtime verification stops before reading even the manifest',async()=>{
  const controller=new AbortController();controller.abort(new Error('cancel-before-io'));
  await assert.rejects(verifyEnhancementRuntime({runtimeBase:path.resolve('unused'),manifestPath:path.resolve('missing-manifest.json')},controller.signal),/cancel-before-io/);
});
