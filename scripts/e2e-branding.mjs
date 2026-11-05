import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {launchTestElectron,electronTestArgs,captureElectron,assertQuietDialogs} from './e2e-launch.mjs';
import {dismissToasts} from './e2e-toast-helper.mjs';
import {validateBuildReceipt,validatePackagedBuild} from './build-receipt.mjs';
const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const executable=process.env.SLU_TEST_EXE?path.resolve(process.env.SLU_TEST_EXE):null;
const mode=executable?'packaged':'source',root=path.resolve(`.test-artifacts/branding-${version}/${mode}`);
await fs.mkdir(root,{recursive:true});
const receipt=await validateBuildReceipt(process.cwd());
if(executable)await validatePackagedBuild(path.join(path.dirname(executable),'resources/app.asar'),receipt);
const profile=await fs.mkdtemp(path.join(root,'profile-'));
const app=await launchTestElectron({...(executable?{executablePath:executable}:{}),args:electronTestArgs(!!executable),env:{...process.env,SLU_USER_DATA:profile},timeout:90000});
const page=await app.firstWindow(),errors=[],checks=[],captures=[];
page.on('pageerror',error=>errors.push(String(error)));
const title=`SLU Studio v${version}`;
async function shot(name){await dismissToasts(page);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.invalidate());await page.waitForTimeout(500);const file=path.join(root,name+'.png');await captureElectron(app,{path:file});captures.push({file,sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex')});}
async function size(width,height){await app.evaluate(({BrowserWindow},[w,h])=>BrowserWindow.getAllWindows()[0].setSize(w,h),[width,height]);await page.waitForTimeout(180);}
async function layout(){
 const value=await page.evaluate(()=>{
   const rect=s=>{const e=document.querySelector(s),b=e.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height,scroll:e.scrollWidth,client:e.clientWidth};};
   return {width:innerWidth,height:innerHeight,document:document.documentElement.scrollWidth,brand:rect('.brand'),version:rect('.brand-version'),menu:rect('.dropdown-wrap'),project:rect('.project-title'),actions:rect('.header-actions'),inspector:rect('.inspector')};
 });
 assert.ok(value.document<=value.width+1,JSON.stringify(value));
 assert.ok(value.version.right<=value.brand.right+1&&value.brand.right<=value.menu.left+1,JSON.stringify(value));
 assert.ok(value.project.right<=value.actions.left+1&&value.actions.right<=value.width,JSON.stringify(value));
 assert.ok(value.inspector.right<=value.width+1,JSON.stringify(value));
 return value;
}
let result;
try{
 await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
 assert.equal(await page.locator('.brand-version').innerText(),`v${version}`);
 const system=await page.evaluate(()=>window.studio.getSystemInfo());assert.equal(system.version,version);
 assert.equal(await page.title(),title);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle()),title);
 checks.push('Rendered header and native window show the actual application version');
 await page.evaluate(()=>{document.title='A transient page title';});await page.waitForTimeout(100);
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle()),title);
 await page.reload();await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();assert.equal(await page.title(),title);
 checks.push('Native title survives page-title updates; renderer restores title after reload');
 const assets=await page.evaluate(async()=>{await document.fonts.load('700 16px "SluCompany Sans"');const img=document.querySelector('.brand-mark');await img.decode();return {iconLoaded:img.naturalWidth>0,fontLoaded:document.fonts.check('700 16px "SluCompany Sans"'),font:getComputedStyle(document.querySelector('.brand strong')).fontFamily};});
 assert.equal(assets.iconLoaded,true);assert.equal(assets.fontLoaded,true);assert.match(assets.font,/SluCompany Sans/);checks.push('Editor SVG and locally bundled Inter wordmark font load');
 const theme=await page.evaluate(()=>{const css=s=>getComputedStyle(document.querySelector(s));return {ink:css('.brand').color,background:css('.app-header').backgroundColor,accent:css('.button.primary').backgroundColor,rail:css('.tool-rail').backgroundColor,version:css('.brand-version').color};});
 assert.equal(theme.ink,'rgb(244, 243, 239)');assert.equal(theme.background,'rgb(13, 13, 13)');assert.equal(theme.accent,'rgb(255, 214, 160)');
 checks.push('Warm neutral chrome and restrained amber accent are applied');
 await size(1600,1000);const normal=await layout();await shot('empty');
 await page.getByLabel('프로젝트 이름',{exact:true}).fill('아주 긴 프로젝트 이름 '.repeat(12).slice(0,120));
 await size(1100,720);const minimum=await layout();await shot('minimum-long-name');
 checks.push('Header, version, project name and actions do not overlap at 1600x1000 or 1100x720');
 await size(1600,1000);await page.getByLabel('프로젝트 이름',{exact:true}).fill('새로운 장면');
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.resolve('examples/01 - Aurora motion.mp4'));
 await page.getByRole('button',{name:'가져오기',exact:true}).first().click();
 await page.getByRole('button',{name:'01 - Aurora motion.mp4 소스 열기',exact:true}).click();
 await page.getByRole('button',{name:'끝에 추가',exact:true}).click();
 await page.waitForFunction(()=>{const v=document.querySelector('.gpu-media-decoders video');return v&&v.readyState>=2;},null,{timeout:30000});
 await page.getByRole('button',{name:'텍스트',exact:true}).first().click();await page.getByRole('button',{name:'텍스트 추가',exact:true}).click();
 await page.getByLabel('텍스트 내용',{exact:true}).fill('새로운 장면의 시작');
 await page.getByLabel('텍스트 내용',{exact:true}).press('Tab');await page.waitForTimeout(300);await shot('editor');
 const focused=await page.getByLabel('프로젝트 이름',{exact:true}).evaluate(e=>{e.focus();const s=getComputedStyle(e);return {color:s.color,background:s.backgroundColor,border:s.borderColor};});
 assert.notEqual(focused.border,theme.background);checks.push('Real media and captions render with visible editing controls and keyboard focus');
 await page.getByRole('button',{name:'내보내기',exact:true}).first().click();await page.getByRole('dialog').waitFor();
 await shot('export');await page.getByTitle('닫기 (Esc)',{exact:true}).click();checks.push('Export dialog renders within the branded editor');
 await size(1100,720);await page.getByRole('button',{name:'내보내기',exact:true}).first().click();
 const dialogBounds=await page.getByRole('dialog').evaluate(e=>{const b=e.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,width:innerWidth,height:innerHeight};});
 assert.ok(dialogBounds.left>=0&&dialogBounds.right<=dialogBounds.width&&dialogBounds.top>=0&&dialogBounds.bottom<=dialogBounds.height);await shot('minimum-export');await page.getByTitle('닫기 (Esc)',{exact:true}).click();
 checks.push('Export dialog remains fully inside the minimum window');
 const quiet=await assertQuietDialogs(app);assert.deepEqual(errors,[]);
 result={version,mode,executable,buildReceiptId:receipt.contentId,checkedAt:new Date().toISOString(),checks,errors,assets,theme,normal,minimum,dialogBounds,quiet,captures};
}finally{await app.close();}
await fs.writeFile(path.join(root,'results.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({version,mode,checks:checks.length,root}));
