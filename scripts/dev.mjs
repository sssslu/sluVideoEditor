import { spawn } from 'node:child_process';
import { createServer,build as buildRenderer } from 'vite';
import { build } from 'esbuild';
import electron from 'electron';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withBuildLock} from './build-lock.mjs';
const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Caption export stays offline and sandboxed in development as in releases.
await withBuildLock(workspace,async()=>{
  await buildRenderer({root:workspace});
  await build({absWorkingDir:workspace,entryPoints:['electron/main.ts','electron/preload.ts','electron/caption-preload.ts','electron/tracking-worker.ts','electron/matting-worker.ts'],outdir:'dist-electron',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron','onnxruntime-node'],outExtension:{'.js':'.cjs'},sourcemap:true});
});
const server=await createServer();await server.listen();
const env={...process.env,SLU_DEV_URL:'http://127.0.0.1:5173'};delete env.ELECTRON_RUN_AS_NODE;
const app=spawn(electron,['.'],{stdio:'inherit',env});
app.on('close',async()=>{await server.close();process.exit();});
