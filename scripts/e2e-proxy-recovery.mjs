import {launchTestElectron,electronTestArgs, captureElectron} from './e2e-launch.mjs';
import {editorEvidence} from './e2e-release-evidence.mjs';

import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
import {probeMedia} from '../electron/media.ts';
import {proxyCacheKey} from '../electron/proxy-cache.ts';
import {newClip, newProject} from '../shared/project.ts';

// Run with npx tsx scripts/e2e-proxy-recovery.mjs after the production build.
// A real tiny FFV1 file exercises browser-proxy recovery without AI inference.
const root = path.resolve('.test-artifacts/cutout-recovery-ui', String(Date.now()));
await fs.mkdir(root, {recursive:true});
const ffmpeg = path.resolve('resources/bin/ffmpeg.exe');
const ffprobe = path.resolve('resources/bin/ffprobe.exe');
const source = path.join(root, 'transparent.mov');
const sound = path.join(root, 'tone.wav');
await promisify(execFile)(ffmpeg, [
  '-v', 'error', '-nostdin', '-y', '-f', 'lavfi',
  '-i', 'color=red:s=160x90:r=10:d=1,format=rgba,colorchannelmixer=aa=0.5',
  '-an', '-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'bgra', source,
], {windowsHide:true, timeout:30000});
await promisify(execFile)(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', sound], {windowsHide:true, timeout:30000});
const soundAsset = await probeMedia(sound, {ffmpeg, ffprobe, cacheDir:path.join(root, 'probe-cache')}, undefined, {derivatives:false});
const asset = await probeMedia(source, {
  ffmpeg, ffprobe, cacheDir:path.join(root, 'probe-cache'),
}, undefined, {derivatives:false});
assert.equal(asset.codec, 'ffv1');
assert.equal(asset.hasAlpha, true);

const checks = [];
const reports = [];
const errors = [];
let evidence;
const executable = process.env.SLU_TEST_EXE ? path.resolve(process.env.SLU_TEST_EXE) : null;

for (const mode of ['startup-before-confirm', 'startup-after-confirm', 'archive', 'startup-failure-retry']) {
  const directory = path.join(root, mode);
  const profile = path.join(directory, 'profile');
  const cache = path.join(profile, 'cache');
  await fs.mkdir(cache, {recursive:true});
  const legacyKey = createHash('sha256')
    .update(`proxy-alpha-source-v3|${asset.sourceRevision}`).digest('hex').slice(0, 28);
  const oldProxy = path.join(cache, `${legacyKey}-alpha-proxy.webm`);
  const expectedProxy = path.join(cache, `${proxyCacheKey(asset)}-alpha-proxy.webm`);
  // The obsolete file deliberately cannot decode. Successful playback must use
  // the replacement produced by the normal background-analysis queue.
  const oldContents = Buffer.from('obsolete proxy retained for migration');
  await fs.writeFile(oldProxy, oldContents);

  const project = newProject();
  project.name = `프록시 복구 ${mode}`;
  project.width = 160;
  project.height = 90;
  project.background = '#00ff00';
  project.media = [{...asset, name:'저장한 미디어 이름', proxyPath:oldProxy}, soundAsset];
  project.clips = [{
    ...newClip('video-1', project.media[0]),
    id:'recovery-clip', name:'보존할 편집', start:0.1, in:0.2, duration:0.6, x:7,
  }, {...newClip('audio-1', soundAsset), id:'recovery-audio', duration:0.8}];

  const env = {...process.env, SLU_USER_DATA:profile, SLU_TEST_BACKGROUND:'1'};
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await launchTestElectron({
    ...(executable ? {executablePath:executable, args:electronTestArgs(true)} : {args:electronTestArgs()}),
    env, timeout:90000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push({mode, error:String(error)}));
  page.on('dialog', dialog => dialog.accept());
  const current = () => page.evaluate(() => document.querySelector('.preview-gpu-stage').previewRuntime.project);

  try {
    await page.getByRole('button', {name:'가져오기', exact:true}).first().waitFor();
    await page.evaluate(async () => {
      localStorage.setItem('slu-proxy', 'false');
      await window.studio.listRecoveries();
    });
    if(mode === 'archive'){
      await page.reload();
      await page.getByRole('button', {name:'가져오기', exact:true}).first().waitFor();
      await page.evaluate(() => window.studio.listRecoveries());
    }
    await app.evaluate(({BrowserWindow}, failProxy) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('slu-app://studio/'));
      if (!window || window.isVisible()) throw Error('Recovery test window must stay hidden');
      const send = window.webContents.send.bind(window.webContents);
      const state = globalThis.recoveryProxyAudit = {updates:[], held:[], statuses:[], jobs:[], send, failProxy, failedCommands:[]};
      if(failProxy){
        const {createRequire, syncBuiltinESMExports} = process.getBuiltinModule('module');
        const childProcess = createRequire(process.execPath)('node:child_process');
        const spawn = childProcess.spawn;
        childProcess.spawn = function(file, args, ...options){
          if(state.failProxy && args.includes('libvpx-vp9')){
            state.failProxy = false;
            state.failedCommands.push(args);
            return spawn(file, ['-slu-proxy-recovery-test-failure', ...args], ...options);
          }
          return spawn(file, args, ...options);
        };
        syncBuiltinESMExports();
      }
      window.webContents.send = function(channel, ...args) {
        if(channel === 'media:preview-status')state.statuses.push(args[0]);
        if(channel === 'job:progress' && args[0].type === 'proxy' && args[0].status === 'complete'){
          state.jobs.push(args[0]);
          state.held.push([channel, ...args]);
          return;
        }
        if (channel === 'media:updated') {
          state.updates.push(args[0]);
          state.held.push([channel, ...args]);
          return;
        }
        return send(channel, ...args);
      };
    }, mode === 'startup-failure-retry');
    await page.addInitScript(() => {
      window.recoveryProxyEvents = [];
      window.studio.onMediaUpdated(media => window.recoveryProxyEvents.push(media));
    });

    if (mode === 'archive') {
      const archives = path.join(profile, 'recoveries');
      await fs.mkdir(archives, {recursive:true});
      const key = createHash('sha256').update(project.id).digest('hex');
      await fs.writeFile(path.join(archives, `${key}.sluproj`), JSON.stringify(project));
      await page.getByRole('button', {name:'프로젝트', exact:true}).click();
      await page.getByRole('button', {name:'복구 기록', exact:true}).click();
      await page.getByRole('dialog', {name:'복구 기록', exact:true}).waitFor();
      await page.locator('.recovery-list > button').filter({hasText:project.name}).click();
      await page.waitForFunction(id => document.querySelector('.preview-gpu-stage').previewRuntime.project.id === id, project.id);
    } else {
      await fs.writeFile(path.join(profile, 'recovery.sluproj'), JSON.stringify(project));
      await page.reload();
      await page.getByRole('button', {name:'작업 이어서 열기', exact:true}).waitFor();
    }

    const releaseResults = () => app.evaluate(() => {
      const state = globalThis.recoveryProxyAudit;
      for(const args of state.held.splice(0))state.send(...args);
    });
    const waitForProxy = () => app.evaluate(async (_, expectedProxy) => {
      const started = Date.now();
      while(!globalThis.recoveryProxyAudit.updates.some(media => media.proxyPath === expectedProxy) &&
        !globalThis.recoveryProxyAudit.jobs.some(job => job.media?.proxyPath === expectedProxy)){
        if(Date.now() - started > 30000)throw Error('Recovery never prepared the current transparent proxy');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }, expectedProxy);
    const seekActiveClip = async () => {
      const mute = page.getByRole('button', {name:'미리보기 소리 끄기', exact:true});
      if(await mute.count())await mute.click();
      await page.getByRole('button', {name:'프로그램', exact:true}).click();
      await page.locator('.preview-gpu-stage').focus();
      await page.keyboard.press('Home');
      for(let frame = 0; frame < 9; frame++)await page.keyboard.press('ArrowRight');
    };
    const verifyWaitingTransport = async () => {
      await seekActiveClip();
      await page.waitForFunction(() => {
        const audio = document.querySelector('.preview-gpu-stage').previewRuntime.nodes.get('recovery-audio');
        return audio?.loaded && audio.element.readyState >= 2 && !audio.element.seeking;
      });
      await page.getByRole('button', {name:'재생 (Space)', exact:true}).click();
      await page.waitForTimeout(550);
      const state = await page.evaluate(() => {
        const runtime = document.querySelector('.preview-gpu-stage').previewRuntime;
        const audio = runtime.nodes.get('recovery-audio');
        return {time:runtime.time(), running:runtime.running, waiting:runtime.waitingToStart,
          paused:audio.element.paused, audioTime:audio.element.currentTime, gain:audio.lastGain,
          placeholder:runtime.nodes.get('recovery-clip').waitingForProxy};
      });
      assert.ok(state.running && state.waiting && state.placeholder, JSON.stringify(state));
      assert.ok(Math.abs(state.time - 0.3) < 0.00001, JSON.stringify(state));
      assert.ok(state.paused && state.gain <= 0 && Math.abs(state.audioTime - 0.3) < 0.005, JSON.stringify(state));
      return state;
    };
    let waitingState;
    if(mode === 'startup-failure-retry'){
      await app.evaluate(async () => {
        const started = Date.now();
        while(!globalThis.recoveryProxyAudit.statuses.some(event => event.status === 'failed')){
          if(Date.now() - started > 30000)throw Error('Expected actual FFmpeg preparation failure');
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if(globalThis.recoveryProxyAudit.failedCommands.length !== 1)throw Error('Failure injection did not run FFmpeg');
      });
      await assert.rejects(fs.stat(expectedProxy));
      await page.getByRole('button', {name:'작업 이어서 열기', exact:true}).click();
      await seekActiveClip();
      await page.locator('.gpu-issues').getByText(/미리보기 파일 준비 실패/).waitFor();
      assert.equal(await page.locator('.gpu-seeking').count(), 0);
      waitingState = await verifyWaitingTransport();
      await page.getByRole('button', {name:'일시 정지 (Space)', exact:true}).click();
      await page.getByRole('button', {name:'저장한 미디어 이름 소스 열기', exact:true}).click();
      await page.locator('.source-error').getByText(/미리보기 파일 준비 실패/).waitFor();
      assert.equal(await page.getByRole('button', {name:'소스 재생 (Space)', exact:true}).isDisabled(), true);
      await page.getByRole('button', {name:'프로그램', exact:true}).click();
      await page.locator('.gpu-issues').getByRole('button', {name:'프록시 생성', exact:true}).click();
      await waitForProxy();
      await page.getByRole('button', {name:'작업 패널 닫기', exact:true}).click();
      await page.locator('.gpu-seeking').getByText('미리보기 파일 준비 중', {exact:true}).waitFor();
      assert.equal(await page.locator('.gpu-issues').count(), 0);
      assert.equal(await page.locator('.toast-error').count(), 0);
      // An obsolete first-attempt failure cannot replace a retry already in progress.
      await app.evaluate(() => {
        const state = globalThis.recoveryProxyAudit;
        state.send('media:preview-status', state.statuses.find(event => event.status === 'failed'));
      });
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.gpu-issues').count(), 0);
      waitingState = await verifyWaitingTransport();
      await releaseResults();
    }else{
      await waitForProxy();
      assert.ok((await fs.stat(expectedProxy)).size > 0);
      if(mode === 'startup-before-confirm'){
        await releaseResults();
        await page.waitForFunction(expected => window.recoveryProxyEvents.some(media => media.proxyPath === expected), expectedProxy);
        await page.getByRole('button', {name:'작업 이어서 열기', exact:true}).click();
      }else{
        if(mode === 'startup-after-confirm')await page.getByRole('button', {name:'작업 이어서 열기', exact:true}).click();
        const pending = await current();
        assert.equal(pending.id, project.id);
        assert.equal(pending.media[0].proxyPath, undefined);
        await seekActiveClip();
        await page.locator('.gpu-seeking').getByText('미리보기 파일 준비 중', {exact:true}).waitFor();
        assert.equal(await page.locator('.gpu-issues').count(), 0);
        assert.equal(await page.locator('.toast-error').count(), 0);
        await page.getByRole('button', {name:'저장한 미디어 이름 소스 열기', exact:true}).click();
        await page.locator('.source-monitor').getByRole('status').getByText('미리보기 파일 준비 중', {exact:true}).waitFor();
        assert.equal(await page.locator('.source-monitor video').count(), 0);
        assert.equal(await page.getByRole('button', {name:'소스 재생 (Space)', exact:true}).isDisabled(), true);
        waitingState = await verifyWaitingTransport();
        await releaseResults();
      }
    }
    if(waitingState){
      await page.waitForFunction(() => document.querySelector('.preview-gpu-stage').previewRuntime.time() > 0.35);
      const pause = page.getByRole('button', {name:'일시 정지 (Space)', exact:true});
      if(await pause.count())await pause.click();
    }

    await page.waitForFunction(expected => {
      const runtime = document.querySelector('.preview-gpu-stage').previewRuntime;
      return runtime.project.media[0]?.proxyPath === expected;
    }, expectedProxy);
    const recovered = await current();
    assert.deepEqual(recovered.clips, JSON.parse(JSON.stringify(project.clips)));
    assert.equal(recovered.media[0].id, asset.id);
    assert.equal(recovered.media[0].name, project.media[0].name);
    assert.equal(recovered.media[0].sourceRevision, asset.sourceRevision);
    assert.deepEqual(recovered.media[0].timing, asset.timing);
    assert.ok((await fs.readFile(oldProxy)).equals(oldContents));

    await seekActiveClip();
    await page.waitForFunction(() => {
      const runtime = document.querySelector('.preview-gpu-stage').previewRuntime;
      const node = runtime.nodes.get('recovery-clip');
      return Math.abs(runtime.time() - 0.3) < 0.00001 && node?.loaded && !node.failed &&
        !node.element.seeking && node.element.readyState >= 2 && node.url.includes('alpha-proxy.webm');
    });
    const pixel = await page.evaluate(() => {
      const runtime = document.querySelector('.preview-gpu-stage').previewRuntime;
      if (runtime.proxy) throw Error('Optional proxies must be disabled');
      runtime.snapshot();
      const canvas = document.createElement('canvas');
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext('2d');
      context.drawImage(runtime.renderer.canvas, 0, 0, 160, 90);
      return [...context.getImageData(80, 45, 1, 1).data];
    });
    assert.ok(Math.abs(pixel[0] - 128) <= 5 && Math.abs(pixel[1] - 127) <= 5 && pixel[2] <= 5, JSON.stringify(pixel));
    assert.equal(await page.locator('.gpu-issues').count(), 0);
    assert.equal(await page.locator('.gpu-seeking').count(), 0);
    assert.equal(await page.locator('.toast-error').count(), 0);
    if(mode === 'startup-failure-retry'){
      await app.evaluate(() => {
        const state = globalThis.recoveryProxyAudit;
        const latest = state.statuses.filter(event => event.status === 'preparing').at(-1);
        state.send('media:preview-status', {...latest, status:'failed', message:'obsolete preparation failure after readiness'});
      });
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.gpu-issues').count(), 0);
      assert.equal(await page.locator('.toast-error').count(), 0);
    }
    await app.evaluate(({BrowserWindow}) => {
      if (BrowserWindow.getAllWindows().some(window => window.isVisible())) throw Error('A test window became visible');
    });
    await captureElectron(app, {path:path.join(directory, 'recovered.png')});
    checks.push(`${mode} regenerates the required transparent proxy and restores identical edits with visible alpha composition`);
    reports.push({mode, projectId:project.id, proxy:expectedProxy, pixel, waitingState});
    if(mode === 'startup-failure-retry'){
      // Exercise a genuine browser decode error outside the required-proxy rule.
      // The runtime is given stale codec metadata, while the actual FFV1 bytes
      // remain unsupported. Successful proxy decoding must then clear this error.
      await page.evaluate(() => {
        const runtime = document.querySelector('.preview-gpu-stage').previewRuntime;
        window.recoveryGoodProject = runtime.project;
        runtime.setProject({...runtime.project, media:runtime.project.media.map((media, index) => index ? media : {...media, codec:'unknown', proxyPath:undefined})});
      });
      await page.locator('.gpu-issues').getByText(/미리보기에서 읽을 수 없습니다/).waitFor();
      await page.locator('.toast-error').getByText(/미리보기에서 읽을 수 없습니다/).waitFor();
      assert.equal(await page.locator('.gpu-issues').getByRole('button', {name:'프록시 생성', exact:true}).count(), 1);
      await page.evaluate(() => document.querySelector('.preview-gpu-stage').previewRuntime.setProject(window.recoveryGoodProject));
      await page.waitForFunction(() => !document.querySelector('.gpu-issues') && !document.querySelector('.toast-error'));
      checks.push('Unrelated browser decode failures remain visible and retryable, then clear only after successful decoding');
      evidence = await editorEvidence(app, import.meta.url, {matting:true});
    }
  } catch (error) {
    await captureElectron(app, {path:path.join(directory, 'failure.png')}).catch(() => {});
    await fs.writeFile(path.join(directory, 'failure.json'), JSON.stringify({
      mode, error:String(error), errors, project:await current().catch(() => null),
      audit:await app.evaluate(() => ({updates:globalThis.recoveryProxyAudit?.updates,statuses:globalThis.recoveryProxyAudit?.statuses,failedCommands:globalThis.recoveryProxyAudit?.failedCommands})).catch(() => null),
    }, null, 2));
    throw error;
  } finally {
    await app.close();
  }
}

assert.deepEqual(errors, []);
await fs.writeFile(path.join(root, 'results.json'), JSON.stringify({
  root, ...evidence, checks, reports, errors,
}, null, 2));
await fs.writeFile('.test-artifacts/cutout-recovery-ui-current.txt', root);
console.log(JSON.stringify({root, checks, errors}));
