
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';
const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const root = path.resolve(`.test-artifacts/manual-${version}`);
await fs.mkdir(root, {recursive: true});
const work = await fs.mkdtemp(path.join(root, 'run-'));
const file = path.resolve('docs/사용설명서.html');
const env = {...process.env, SLU_USER_DATA: path.join(work, 'profile'), SLU_TEST_BACKGROUND: '1'};
delete env.ELECTRON_RUN_AS_NODE;
const app = await launchTestElectron({args: electronTestArgs(), env, timeout: 90000});

try {
  const editor = await app.firstWindow();
  await editor.getByRole('button', {name: '가져오기', exact: true}).first().waitFor();
  const pending = app.waitForEvent('window');
  await app.evaluate(async ({BrowserWindow}, file) => {
    globalThis.manualReview = new BrowserWindow({
      show: false,
      width: 1050,
      height: 1120,
      webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false},
    });
    await globalThis.manualReview.loadFile(file);
    if (BrowserWindow.getAllWindows().some(window => window.isVisible())) throw Error('Manual check opened a visible window');
  }, file);
  const page = await pending;
  await page.locator('#cutout').waitFor();
  const checks = await page.evaluate(() => {
    const sectionText = id => {
      const nodes = [];
      for (let node = document.getElementById(id)?.nextElementSibling; node && node.tagName !== 'H2'; node = node.nextElementSibling) nodes.push(node.textContent || '');
      return nodes.join('\n');
    };
    const cutout = sectionText('cutout');
    const stabilization = sectionText('stabilize');
    return {
      anchors: [...document.querySelectorAll('nav a')].every(a => !!document.getElementById(a.getAttribute('href').slice(1))),
      noOverflow: document.documentElement.scrollWidth <= innerWidth,
      duplicateIds: [...document.querySelectorAll('[id]')].map(node => node.id).filter((id, index, ids) => ids.indexOf(id) !== index),
      text: document.querySelector('main>p')?.textContent,
      cutoutInstructions: document.querySelectorAll('#cutout + ol > li').length >= 4,
      cutoutControls: ['기본 · 상반신', '기본 · 전신', 'ResNet50 · 전신', '자동 · GPU 우선', 'CPU', 'GPU', '배경 제거 해제', '배경 제거·이후 처리 해제'].every(label => cutout.includes(label)),
      cutoutStorageAndLimits: ['RVM', '4096', 'SDR', 'FFV1', 'WebM', 'media-derived', '프로젝트 모아 저장'].every(label => cutout.includes(label)),
      cutoutQualityLimits: ['손·팔이 일부 지워지거나', '가장자리에 배경색', '머리카락 사이·팔다리 틈', '밝고 어두운 배경'].every(label => cutout.includes(label)),
      transparentStabilization: ['투명 여백', 'FFV1', '미리보기', 'CPU'].every(label => stabilization.includes(label)),
      projectFormat10: sectionText('save').includes('형식 10'),
      enhancementInstructions: document.querySelectorAll('#enhancement + ol > li').length===4&&['2×','4×','AI 엔진 설치','2.0초 비교','클립에 적용','화질 향상 해제'].every(label=>sectionText('enhancement').includes(label)),
      enhancementRuntime: ['SeedVR2','NVIDIA','CUDA','10.3GB','30GiB','7680','33,177,600','FFV1','media-derived','enhancement-runtime'].every(label=>sectionText('enhancement').includes(label)),
      captionFonts: ['Noto Sans KR','Gmarket Sans','두 종류','500·700'].every(label=>sectionText('captions').includes(label)),
      simpleHsl: ['색상별 HSL','세 슬라이더','색조','채도','밝기'].every(label=>sectionText('color').includes(label)),
      simpleKeyframes: ['그래프의 점','한 번의 드래그','한 번의 실행 취소'].every(label=>sectionText('picture').includes(label)),
    };
  });
  assert.equal(checks.anchors, true);
  assert.equal(checks.noOverflow, true);
  assert.deepEqual(checks.duplicateIds, []);
  assert.ok(checks.text?.includes(version), 'Manual version must match package.json');
  for (const name of ['cutoutInstructions', 'cutoutControls', 'cutoutStorageAndLimits', 'cutoutQualityLimits', 'transparentStabilization', 'projectFormat10','enhancementInstructions','enhancementRuntime','captionFonts','simpleHsl','simpleKeyframes']) {
    assert.equal(checks[name], true, `Manual section is incomplete: ${name}`);
  }

  const sections = ['start', 'reverse', 'freeze', 'stabilize', 'cutout', 'enhancement','picture','color','captions','audio', 'tracking', 'save'];
  for (const section of sections) {
    await page.evaluate(id => {
      document.documentElement.style.scrollBehavior = 'auto';
      document.getElementById(id).scrollIntoView({block: 'start', behavior: 'instant'});
    }, section);
    await page.waitForFunction(id => {
      const top = document.getElementById(id).getBoundingClientRect().top;
      return top >= -1 && top < innerHeight / 3;
    }, section);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const png = await app.evaluate(async ({BrowserWindow}) => {
      if (BrowserWindow.getAllWindows().some(window => window.isVisible())) throw Error('Manual check opened a visible window');
      const window = globalThis.manualReview;
      const [width, height] = window.getContentSize();
      const image = await window.capturePage({x: 0, y: 0, width, height}, {stayHidden: true, stayAwake: true});
      if (image.isEmpty()) throw Error('Manual capture is empty');
      return image.toPNG().toString('base64');
    });
    await fs.writeFile(path.join(root, `${section}.png`), Buffer.from(png, 'base64'));
  }
  const sha256 = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  await fs.writeFile(path.join(root, 'results.json'), JSON.stringify({version, checks, sections, hidden: true, sha256}, null, 2));
  console.log(JSON.stringify(checks));
} finally {
  await app.close();
}
