import {app} from 'electron';
import path from 'node:path';
import {electronTestLifecycle} from './electron-test-lifecycle';
import {newProject,newClip} from '../shared/project';
import {defaultCaptionStyle} from '../shared/captions';
import {createCaptionRasterWithPaths} from '../electron/caption-raster';
if(process.env.SLU_USER_DATA)app.setPath('userData',process.env.SLU_USER_DATA);
const lifecycle=electronTestLifecycle();app.on('window-all-closed',()=>{});
void(async()=>{
  await app.whenReady();const project=newProject(),clip=newClip('text-1');project.width=320;project.height=180;clip.text='안전한 테스트';clip.captionStyle=defaultCaptionStyle();clip.duration=1;project.clips=[clip];
  const session=await createCaptionRasterWithPaths(project,{width:320,height:180,fps:30,format:'mp4',codec:'h264',encoder:'cpu',quality:'high'},lifecycle.signal,undefined,{directory:path.resolve('dist'),preload:path.resolve('dist-electron/caption-preload.cjs')});lifecycle.registerCleanup(()=>session.close());
  const group=await session.prepare(project.clips);await session.frame(group,0);
  process.stdout.write('READY\n');setInterval(()=>process.stdout.write('closed sink regression\n'),50);
})();
