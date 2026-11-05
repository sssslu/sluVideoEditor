import {launchTestElectron} from './e2e-launch.mjs';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('.test-artifacts/review-1.1');await mkdir(root,{recursive:true});
const env={...process.env,SLU_USER_DATA:path.join(root,`profile-${Date.now()}`)};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({args:['.'],env,timeout:60000});const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
try{
  await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
  await page.screenshot({path:path.join(root,'empty.png')});
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.resolve('examples/AURORA.sluproj'));
  await page.keyboard.press('Control+o');await page.waitForFunction(()=>document.querySelectorAll('.timeline-clip').length>0);await page.waitForTimeout(1000);await page.keyboard.press('Home');await page.keyboard.press('Shift+ArrowRight');await page.waitForTimeout(600);
  await page.screenshot({path:path.join(root,'editor.png')});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,720));await page.waitForTimeout(500);await page.screenshot({path:path.join(root,'small.png')});
  await writeFile(path.join(root,'review.json'),JSON.stringify({errors,body:await page.locator('body').innerText()},null,2));
}finally{await app.close();}
const browser=await chromium.launch({channel:'chrome',headless:true});const p=await browser.newPage({viewport:{width:1280,height:900}});await p.goto('file:///'+path.resolve('docs/사용설명서.html').replaceAll('\\','/'));await p.screenshot({path:path.join(root,'manual.png'),fullPage:true});await browser.close();console.log(root);
