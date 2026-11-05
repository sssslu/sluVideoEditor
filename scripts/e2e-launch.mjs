// Electron45 on this Windows GPU still schedules never-shown windows at1Hz
// despite backgroundThrottling:false. Chromium's compositor switch restores
// frame callbacks without exposing a test window on the desktop.
// Use only for UI correctness; performance benchmarks must retain normal flags.
// Apply before importing scripts construct their isolated launch environment.
// A caller may explicitly set 0 for interactive debugging.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {_electron as electron} from 'playwright';

process.env.SLU_TEST_BACKGROUND??='1';

// Playwright's Windows Electron launcher uses a shell without windowsHide.
// Keep this override confined to the test process, including its helper launches.
export function hiddenSpawn(original) {
  return function(command, args, options) {
    if (args && !Array.isArray(args) && typeof args === 'object') return original.call(this, command, {...args, windowsHide:true});
    return original.call(this, command, args, {...options, windowsHide:true});
  };
}
const spawnGuard = Symbol.for('slu.test.hiddenSpawn');
if (!childProcess[spawnGuard]) {
  childProcess.spawn = hiddenSpawn(childProcess.spawn);
  childProcess[spawnGuard] = true;
  syncBuiltinESMExports();
}

export function installRendererQuietDialogs() {
  if (globalThis.__sluQuietDialogs) return;
  const known = '저장하지 않은 변경 사항이 있습니다. 현재 프로젝트를 닫고 계속할까요? 프로젝트 파일로 보관하려면 취소한 뒤 Ctrl+S로 저장하세요.';
  const documentId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const state = {documentId, sequence:0, records:[], unexpected:[], pendingConfirmResponses:[], guards:{}, writeErrors:[]};
  const emit = console.debug.bind(console);
  state.report = () => {
    const payload = {documentId, sequence:++state.sequence, url:globalThis.location?.href ?? '', records:state.records.map(entry=>({...entry})), pendingConfirmResponses:[...state.pendingConfirmResponses]};
    try { emit('SLU_QA_DIALOG_RECORD '+JSON.stringify(payload)); }
    catch (error) { state.writeErrors.push(String(error)); }
  };
  const record = (type, message, response, expected) => {
    const entry = {documentId, sequence:state.sequence+1, type, message:String(message ?? ''), response, expected};
    state.records.push(entry);
    if (!expected) state.unexpected.push(entry);
    state.report();
    return response;
  };
  state.guards.confirm = message => {
    const expected = String(message ?? '') === known;
    const response = expected ? (state.pendingConfirmResponses.shift() ?? true) : false;
    return record('confirm', message, response, expected);
  };
  state.guards.alert = message => { record('alert', message, null, false); };
  state.guards.prompt = message => record('prompt', message, null, false);
  Object.defineProperty(globalThis, '__sluQuietDialogs', {value:state});
  for (const name of ['confirm','alert','prompt']) Object.defineProperty(globalThis, name, {value:state.guards[name], configurable:false, writable:false});
  state.report();
}

export function recordQuietDialog(state, payload) {
  assert.ok(typeof payload.documentId==='string'&&payload.documentId.length>0);
  assert.ok(Number.isSafeInteger(payload.sequence)&&payload.sequence>0);
  assert.ok(Array.isArray(payload.records)&&Array.isArray(payload.pendingConfirmResponses));
  assert.ok(payload.pendingConfirmResponses.every(value=>typeof value==='boolean'));
  let document=state.documents.get(payload.documentId);
  if(!document){document={documentId:payload.documentId,url:payload.url,sequence:0,records:new Map(),pendingConfirmResponses:[]};state.documents.set(payload.documentId,document);}
  for(const entry of payload.records){
    assert.equal(entry.documentId,payload.documentId);
    assert.ok(Number.isSafeInteger(entry.sequence)&&entry.sequence>0&&entry.sequence<=payload.sequence);
    assert.ok(['confirm','alert','prompt'].includes(entry.type)&&typeof entry.expected==='boolean');
    const previous=document.records.get(entry.sequence);
    if(previous)assert.deepEqual(previous,entry,'Conflicting quiet-dialog record');
    else document.records.set(entry.sequence,{...entry});
  }
  if(payload.sequence>=document.sequence){document.sequence=payload.sequence;document.url=payload.url;document.pendingConfirmResponses=[...payload.pendingConfirmResponses];}
}

export function installNativeQuietDialogs({app, BrowserWindow, dialog}, {auditPath}) {
  const state = {records:[], unexpected:[], writeError:null};
  globalThis.__sluQuietNativeDialogs = state;
  const fs = process.getBuiltinModule('node:fs');
  const record = (method, options, response, expected = false) => {
    const entry = {method, message:String(options?.message ?? ''), title:String(options?.title ?? ''), response, expected};
    state.records.push(entry);
    if (!expected) state.unexpected.push(entry);
    // Preserve calls made during app.quit, after the last renderer audit.
    // Error reporting itself must never trigger another native error box.
    try { fs.appendFileSync(auditPath, JSON.stringify(entry)+'\n'); }
    catch (error) { state.writeError = String(error); }
  };
  const checkAudio = window => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed() && !window.webContents.isAudioMuted()) {
      record('quietAudio', {message:`Window ${window.id} has an unmuted output sink`}, null);
    }
  };
  // Keep creation failures even if a short-lived caption/manual window closes
  // before the next audit. Muting belongs to the application, never this guard.
  app.on('browser-window-created', (_event, window) => checkAudio(window));
  for (const window of BrowserWindow.getAllWindows()) checkAudio(window);
  const optionsOf = args => args.length > 1 ? args[1] : args[0];
  for (const method of ['showOpenDialog','showOpenDialogSync','showSaveDialog','showSaveDialogSync']) {
    dialog[method] = (...args) => {
      record(method, optionsOf(args), null);
      if (method.endsWith('Sync')) return undefined;
      return Promise.resolve(method === 'showOpenDialog' ? {canceled:true, filePaths:[]} : {canceled:true, filePath:''});
    };
  }
  for (const method of ['showMessageBox','showMessageBoxSync']) {
    dialog[method] = (...args) => {
      const options = optionsOf(args) ?? {};
      const shutdown = method === 'showMessageBoxSync' && options.message === '진행 중인 작업이 있습니다. 종료할까요?' && JSON.stringify(options.buttons) === JSON.stringify(['계속 작업','작업 취소 후 종료']);
      const response = shutdown ? 1 : (Number.isInteger(options.cancelId) && options.cancelId >= 0 ? options.cancelId : Math.max(0, (options.buttons?.length ?? 1)-1));
      record(method, options, response, shutdown);
      return method.endsWith('Sync') ? response : Promise.resolve({response, checkboxChecked:false});
    };
  }
  dialog.showErrorBox = (title, content) => { record('showErrorBox', {title, message:content}, null); };
  dialog.showCertificateTrustDialog = (...args) => {
    record('showCertificateTrustDialog', optionsOf(args), null);
    return Promise.resolve();
  };
}

const quietApplications = new WeakMap();

export async function queueConfirmResponses(page, responses) {
  assert.ok(Array.isArray(responses) && responses.every(value => typeof value === 'boolean'), 'Confirm responses must be booleans');
  await page.evaluate(values => {
    if (!globalThis.__sluQuietDialogs) throw Error('Quiet dialog guard is missing');
    globalThis.__sluQuietDialogs.pendingConfirmResponses.push(...values);
    globalThis.__sluQuietDialogs.report();
  }, responses);
}

async function nativeRecords(state) {
  return (await fs.readFile(state.auditPath, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

export async function readQuietDialogs(app) {
  const state = quietApplications.get(app);
  assert.ok(state, 'Application was not launched through the quiet test helper');
  const currentDocuments = new Map();
  for (const page of app.context().pages()) {
    if (page.isClosed()) continue;
    const current=await page.evaluate(() => {
      const state = globalThis.__sluQuietDialogs;
      if (!state) return {url:location.href, records:[], unexpected:[{type:'missing-guard'}], pendingConfirmResponses:[],writeErrors:[]};
      // The console event precedes this evaluation's reply. Return the same
      // snapshot as well so live-document collection deduplicates it exactly.
      state.report();
      const unexpected = [];
      for (const name of ['confirm','alert','prompt']) if (globalThis[name] !== state.guards[name]) unexpected.push({type:'replaced-guard', name});
      return {documentId:state.documentId,sequence:state.sequence,url:location.href, records:state.records, unexpected, pendingConfirmResponses:state.pendingConfirmResponses,writeErrors:state.writeErrors};
    });
    if(current.documentId)recordQuietDialog(state,current);
    currentDocuments.set(current.documentId??current.url,current);
  }
  const renderer=[...state.documents.values()].map(document=>{
    const current=currentDocuments.get(document.documentId),records=[...document.records.values()].sort((a,b)=>a.sequence-b.sequence);
    return {documentId:document.documentId,url:document.url,records,unexpected:[...records.filter(entry=>!entry.expected),...(current?.unexpected??[])],pendingConfirmResponses:document.pendingConfirmResponses,writeErrors:current?.writeErrors??[]};
  });
  for(const current of currentDocuments.values())if(!current.documentId)renderer.push(current);
  const main = await app.evaluate(({BrowserWindow}) => ({hidden:BrowserWindow.getAllWindows().every(window => !window.isVisible()), audioMuted:BrowserWindow.getAllWindows().every(window => window.webContents.isAudioMuted()), writeError:globalThis.__sluQuietNativeDialogs?.writeError ?? null}));
  const records = await nativeRecords(state);
  return {renderer, native:{records, unexpected:records.filter(record => !record.expected), writeError:main.writeError}, hidden:main.hidden, audioMuted:main.audioMuted, setupErrors:[...state.pageErrors,...state.ledgerErrors], auditPath:state.auditPath};
}

export async function assertQuietDialogs(app) {
  const audit = await readQuietDialogs(app);
  assert.equal(audit.hidden, true, 'Test application exposed a window');
  assert.equal(audit.audioMuted, true, 'Test application has an unmuted output sink');
  assert.deepEqual(audit.setupErrors, [], 'Quiet dialog guard setup failed');
  assert.equal(audit.native.writeError, null, 'Native dialog audit could not be written');
  assert.deepEqual(audit.native.unexpected, [], 'Unexpected native dialog was suppressed');
  for (const page of audit.renderer) {
    assert.deepEqual(page.unexpected, [], `Unexpected renderer dialog was suppressed in ${page.url}`);
    assert.deepEqual(page.writeErrors, [], `Quiet dialog callback failed in ${page.url}`);
    assert.deepEqual(page.pendingConfirmResponses, [], `Unused confirm response in ${page.url}`);
  }
  return audit;
}

async function terminateTestProcess(app) {
  const owned = app.process();
  if (!owned?.pid || owned.exitCode !== null || owned.signalCode !== null) return;
  if (process.platform === 'win32') await promisify(childProcess.execFile)('taskkill', ['/PID',String(owned.pid),'/T','/F'], {windowsHide:true}).catch(error => {
    if (owned.exitCode === null && owned.signalCode === null) throw error;
  });
  else owned.kill('SIGTERM');
}

export async function prepareQuietPages(app, state, timeout) {
  const context = app.context();
  state.documents??=new Map();state.ledgerErrors??=[];
  const registeredPages = new Map();
  const injectCurrentDocument = async page => {
    if (page.isClosed()) return;
    try { await page.evaluate(installRendererQuietDialogs); }
    catch (error) {
      // A new document replaces this context. Its init/load handlers inject again.
      if (!page.isClosed() && !/Execution context was destroyed|Cannot find context/.test(String(error))) state.pageErrors.push(String(error));
    }
  };
  const registerPage = page => {
    if (!registeredPages.has(page)) {
      page.on('console',message=>{
        const prefix='SLU_QA_DIALOG_RECORD ',text=message.text();
        if(message.type()!=='debug'||!text.startsWith(prefix))return;
        try {recordQuietDialog(state,JSON.parse(text.slice(prefix.length)));}
        catch(error){state.ledgerErrors.push(String(error));}
      });
      page.on('domcontentloaded', () => { void injectCurrentDocument(page); });
      const ready = page.addInitScript(installRendererQuietDialogs).then(() => injectCurrentDocument(page));
      ready.catch(error => { if (!page.isClosed()) state.pageErrors.push(String(error)); });
      registeredPages.set(page, ready);
    }
    return registeredPages.get(page);
  };
  context.on('page', page => { void registerPage(page); });
  await context.addInitScript(installRendererQuietDialogs);
  // Electron can return from launch before its asynchronous first load begins.
  // Wait for the editor's actual document rather than snapshotting an empty context.
  const first = await app.firstWindow();
  await registerPage(first);
  await first.waitForURL(url => !!url.href && url.href !== 'about:blank', {waitUntil:'domcontentloaded', timeout});
  await first.evaluate(installRendererQuietDialogs);
  for (const page of context.pages()) if (!page.isClosed()) await registerPage(page);
}

export async function launchTestElectron(options = {}) {
  const auditRoot = path.resolve('.test-artifacts/quiet-ui');
  await fs.mkdir(auditRoot, {recursive:true});
  const directory = await fs.mkdtemp(path.join(auditRoot, 'run-'));
  const auditPath = path.join(directory, 'native.jsonl');
  await fs.writeFile(auditPath, '');
  const env = {...process.env, ...options.env, SLU_TEST_BACKGROUND:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({...options, env});
  const state = {auditPath, pageErrors:[]};
  quietApplications.set(app, state);
  try {
    await app.evaluate(installNativeQuietDialogs, {auditPath});
    await prepareQuietPages(app, state, options.timeout ?? 30000);
    await assertQuietDialogs(app);
  } catch (error) {
    await terminateTestProcess(app);
    throw error;
  }
  const originalClose = app.close.bind(app);
  let closing;
  app.close = (...args) => closing ??= (async () => {
    let auditError;
    try { await assertQuietDialogs(app); } catch (error) { auditError = error; }
    let timer;
    try {
      await Promise.race([originalClose(...args), new Promise((_,reject) => { timer=setTimeout(() => reject(Error('Quiet test application did not close within30 seconds')),30000); })]);
    } catch (error) {
      await terminateTestProcess(app);
      auditError ??= error;
    } finally { clearTimeout(timer); }
    const records = await nativeRecords(state);
    assert.deepEqual(records.filter(record => !record.expected), [], 'Unexpected native dialog during test or shutdown was suppressed');
    if (auditError) throw auditError;
  })();
  return app;
}
export function electronTestArgs(packaged=false){
  return ['--disable-frame-rate-limit',...(packaged?[]:['.'])];
}

// Native capture supports hidden Electron windows without a CDP compositor
// screenshot waiting forever after a resize. Never expose the test window.
export async function captureElectron(app,{path:file}){
  const png=await app.evaluate(async({BrowserWindow})=>{
    const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('slu-app://studio/'));
    if(!window)throw Error('Editor window missing');
    const visible=window.isVisible(),[width,height]=window.getContentSize();let timer;
    try{
      const snapshot=await Promise.race([window.capturePage({x:0,y:0,width,height},{stayHidden:true,stayAwake:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native capture timed out')),15000);})]);
      if(snapshot.isEmpty()||snapshot.getSize().width<100||snapshot.getSize().height<100)throw Error('Native capture returned an empty image');
      if(window.isVisible()!==visible)throw Error('Capture changed window visibility');
      return snapshot.toPNG().toString('base64');
    }finally{clearTimeout(timer);}
  });
  await fs.writeFile(file,Buffer.from(png,'base64'));
}
