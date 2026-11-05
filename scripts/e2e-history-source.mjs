
import {build} from 'esbuild';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {launchTestElectron,electronTestArgs} from './e2e-launch.mjs';
const root=path.resolve('.test-artifacts/history-source');await fs.mkdir(root,{recursive:true});const env={...process.env,SLU_USER_DATA:path.join(root,`profile-${Date.now()}`),SLU_TEST_BACKGROUND:'1'};delete env.ELECTRON_RUN_AS_NODE;
const app=await launchTestElectron({args:electronTestArgs(),env,timeout:90000}),page=await app.firstWindow();
try{
 await page.locator('.preview-gpu-stage').waitFor();
 const code=await build({stdin:{contents:"import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {useHistory} from './src/editor';import {newProject,newClip} from './shared/project';const host=document.createElement('div');host.hidden=true;document.body.append(host);function Harness(){globalThis.historyProbe=useHistory();return null;}flushSync(()=>createRoot(host).render(React.createElement(Harness)));globalThis.historyQA={flushSync,newProject,newClip};",resolveDir:path.resolve('.')},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022'});await page.evaluate(code.outputFiles[0].text);
 const results=await page.evaluate(()=>{
  const {flushSync,newProject,newClip}=window.historyQA,checks=[];const check=(condition,label)=>{if(!condition)throw Error(label);checks.push(label);};const edit=fn=>{flushSync(()=>fn(window.historyProbe));return window.historyProbe.current.current;};
  const old={id:'source',path:'C:/history-source.mp4',name:'source',kind:'video',duration:20,width:640,height:360,fps:30,hasAudio:true,sourceRevision:'1'.repeat(64),videoStart:0,videoEnd:20,proxyPath:'C:/old-color-proxy.mp4',thumbnail:'C:/old-thumbnail.jpg',waveform:[.1,.2]};
  const fixture={...newProject(),media:[old],clips:[{...newClip('video-1',old),id:'a',in:3,duration:2},{...newClip('video-1',old,2),id:'b',in:8,duration:2}],transitions:[{id:'ab',fromClipId:'a',toClipId:'b',kind:'dissolve',durationFrames:30}]};
  const fresh={...old,sourceRevision:'2'.repeat(64),duration:5.1,videoEnd:5.1,proxyPath:undefined,thumbnail:undefined,waveform:undefined};
  edit(h=>h.reset(fixture));edit(h=>h.change(p=>({...p,clips:p.clips.map(c=>c.id==='a'?{...c,x:10}:c)})));edit(h=>h.change(p=>({...p,clips:p.clips.map(c=>c.id==='a'?{...c,x:20}:c)})));const captured=window.historyProbe.current.current;
  let p=edit(h=>h.change(p=>({...p,media:[fresh]})));check(p.clips[0].x===20&&p.media[0].sourceRevision===fresh.sourceRevision&&!p.media[0].proxyPath&&!p.transitions?.length,'Refresh retains edits, clears obsolete derivatives and detaches unavailable source handles');
  p=edit(h=>h.undo());check(p.clips[0].x===10&&p.media[0].sourceRevision===fresh.sourceRevision&&!p.transitions?.length,'First undo changes the prior edit rather than undoing external refresh');
  p=edit(h=>h.undo());check(p.clips[0].x===0&&p.media[0].sourceRevision===fresh.sourceRevision&&!p.media[0].proxyPath&&!p.transitions?.length,'Older undo snapshots retain actual source identity and cannot restore invalid transitions');
  p=edit(h=>h.redo());check(p.clips[0].x===10&&p.media[0].sourceRevision===fresh.sourceRevision,'Redo rebases historical source metadata');
  edit(h=>h.change(p=>({...p,media:p.media.map(m=>({...m,proxyPath:'C:/current-color-proxy.mp4',thumbnail:'C:/current.jpg',waveform:[.7,.8]}))}),false));p=edit(h=>h.redo());check(p.clips[0].x===20&&p.media[0].proxyPath==='C:/current-color-proxy.mp4'&&p.media[0].waveform[0]===.7,'Same-revision derivative completion survives undo/redo');
  p=edit(h=>h.change({...captured,clips:captured.clips.map(c=>c.id==='a'?{...c,y:30}:c)}));check(p.clips[0].y===30&&p.media[0].sourceRevision===fresh.sourceRevision&&!p.transitions?.length,'A gesture carrying an obsolete project snapshot cannot restore obsolete source metadata');
  const third={...fresh,sourceRevision:'3'.repeat(64),duration:20,videoEnd:20};p=edit(h=>h.change(p=>({...p,media:[third],clips:p.clips.map(c=>c.id==='a'?{...c,x:40}:c)})));p=edit(h=>h.undo());check(p.clips[0].x===20&&p.media[0].sourceRevision===third.sourceRevision,'An edit accompanying a source revision change still gets its own undo checkpoint');
  const other={...old,id:'other',path:'C:/other.mp4'};edit(h=>h.change(p=>({...p,media:[...p.media,other]})));p=edit(h=>h.undo());check(p.media.length===1&&p.media[0].sourceRevision===third.sourceRevision,'Undo still removes newly imported media while retaining refreshed source facts');
  p=edit(h=>h.change(p=>({...p,media:[old]}),true,{authoritativeSources:[old]}));check(p.media[0].sourceRevision===old.sourceRevision&&p.media[0].proxyPath===old.proxyPath,'Explicitly reprobed sources may restore a previously seen filesystem identity');
  p=edit(h=>h.change(p=>({...p,media:[third],clips:p.clips.map(c=>({...c,y:41}))})));check(p.media[0].sourceRevision===old.sourceRevision&&p.clips[0].y===41,'A stale gesture still cannot roll back the explicitly restored source identity');
  const beforeNoop=window.historyProbe.current.current,undoBefore=window.historyProbe.canUndo;p=edit(h=>h.change(p=>({...p,media:p.media.map(m=>({...m}))}),true,{authoritativeSources:[old]}));check(p===beforeNoop&&window.historyProbe.canUndo===undoBefore,'Reimporting identical source metadata creates no dirty state or undo entry');
  edit(h=>h.reset(fixture));p=edit(h=>h.change(p=>({...p,clips:p.clips.map(c=>({...c,x:3}))})));p=edit(h=>h.undo());check(p.media[0].sourceRevision===old.sourceRevision&&p.media[0].proxyPath===old.proxyPath&&p.transitions.length===1,'Reset clears external-source authority for the new project session');
  return {checks};
 });await fs.writeFile(path.join(root,'results.json'),JSON.stringify(results,null,2));assert.equal(results.checks.length,12);console.log(JSON.stringify(results));
}finally{await app.close();}
