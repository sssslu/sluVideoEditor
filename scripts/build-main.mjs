import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withBuildLock} from './build-lock.mjs';
const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await withBuildLock(workspace,()=>build({absWorkingDir:workspace,entryPoints:['electron/main.ts','electron/preload.ts','electron/caption-preload.ts','electron/tracking-worker.ts','electron/matting-worker.ts'],outdir:'dist-electron',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron','onnxruntime-node'],outExtension:{'.js':'.cjs'},sourcemap:true}));
