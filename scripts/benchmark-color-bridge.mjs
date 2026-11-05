
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';
const root=path.resolve('.test-artifacts/color-bridge');await fs.mkdir(root,{recursive:true});const env={...process.env,SLU_USER_DATA:path.join(root,`profile-${Date.now()}`),SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({args:electronTestArgs(),env,timeout:60000});
try{
 const page=await app.firstWindow();await page.getByRole('button',{name:'가져오기',exact:true}).first().waitFor();
 const fixture=JSON.parse(await fs.readFile('.test-artifacts/color-render/fixture.json','utf8')),lut=fixture.cases.find(c=>c.name==='cube65').lut;
 await page.evaluate(paths=>window.studio.importMedia(paths),fixture.project.media.map(m=>m.path));
 const results=await page.evaluate(async({project,lut})=>{
  const results=[];
  for(const include of [false,true]){
   const p={...project,colorLuts:include?[lut]:[],clips:project.clips.map(c=>({...c,colorGrade:include?{enabled:true,intensity:1,lutId:lut.id}:undefined}))};
   const sync=[],settled=[];for(let i=0;i<12;i++){const start=performance.now(),promise=window.studio.autosave({...p,updatedAt:new Date().toISOString()});sync.push(performance.now()-start);settled.push(promise);await new Promise(r=>setTimeout(r,16));}await Promise.all(settled);results.push({lut:include?'65 cube':'none',jsonBytes:new TextEncoder().encode(JSON.stringify(p)).length,synchronousBridgeMs:sync,mean:sync.reduce((a,b)=>a+b,0)/sync.length,max:Math.max(...sync)});
  }return results;
 },{project:fixture.project,lut});
 await fs.writeFile(path.join(root,'results.json'),JSON.stringify({scope:'Synchronous contextBridge clone and IPC dispatch cost; excludes asynchronous save delay and frame rendering',results},null,2));console.log(JSON.stringify(results));
}finally{await app.close();}
