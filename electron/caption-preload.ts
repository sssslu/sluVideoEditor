import {ipcRenderer} from 'electron';

// A dedicated sandbox preload grants only one private MessagePort. No file,
// shell, application IPC or network capability is exposed to this renderer.
ipcRenderer.once('slu-caption:port',event=>{
  if(event.ports.length!==1)return;
  window.postMessage({type:'slu-caption:port'},'*',event.ports);
});
