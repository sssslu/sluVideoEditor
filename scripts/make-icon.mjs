// The SVG is the source; Chromium rasterizes it for Windows PNG/ICO consumers.
import electron from 'electron';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(typeof electron==='string'){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[fileURLToPath(import.meta.url)],{cwd:root,env,windowsHide:true,stdio:'inherit'});
  child.on('error',error=>{console.error(error);process.exitCode=1;});
  child.on('exit',code=>{process.exitCode=code??1;});
}else{
  void (async()=>{
  const {app,BrowserWindow}=electron;
  app.setPath('userData',path.join(root,'.build-cache','icon-profile'));
  app.disableHardwareAcceleration();
  let window;
  try{
    await app.whenReady();
    window=new BrowserWindow({show:false,width:512,height:512,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    window.webContents.setAudioMuted(true);
    await window.loadURL('data:text/html,<html><body></body></html>');
    const svg=await fs.readFile(path.join(root,'src/assets/studio-icon.svg'),'utf8');
    const sizes=[16,24,32,48,64,128,256,512];
    const encoded=await window.webContents.executeJavaScript(`(async()=>{
      const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(${JSON.stringify(svg)});await img.decode();
      return ${JSON.stringify(sizes)}.map(size=>{const c=document.createElement('canvas');c.width=c.height=size;c.getContext('2d').drawImage(img,0,0,size,size);return c.toDataURL('image/png').split(',')[1];});
    })()`);
    const images=encoded.map(value=>Buffer.from(value,'base64'));
    await fs.writeFile(path.join(root,'resources/icon.png'),images[6]);
    const header=Buffer.alloc(6+7*16);header.writeUInt16LE(1,2);header.writeUInt16LE(7,4);
    let offset=header.length;
    for(let i=0;i<7;i++){
      const at=6+i*16;header[at]=header[at+1]=sizes[i]===256?0:sizes[i];
      header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);
      header.writeUInt32LE(images[i].length,at+8);header.writeUInt32LE(offset,at+12);offset+=images[i].length;
    }
    await fs.writeFile(path.join(root,'resources/icon.ico'),Buffer.concat([header,...images.slice(0,7)]));
    const previews=path.join(root,'.test-artifacts','brand-icon');await fs.mkdir(previews,{recursive:true});
    await Promise.all(images.map((bytes,i)=>fs.writeFile(path.join(previews,`icon-${sizes[i]}.png`),bytes)));
    console.log('Generated editor icon: 16–256 px ICO, 256 px PNG.');
  }catch(error){console.error(error);process.exitCode=1;}
  finally{window?.destroy();app.exit(process.exitCode||0);}
  })();
}
