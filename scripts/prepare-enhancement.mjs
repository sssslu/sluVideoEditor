import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {tsImport} from 'tsx/esm/api';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
const args = process.argv.slice(2);
let verifyOnly = false;
for (let index = 0; index < args.length; index++) {
  const name = args[index];
  if (name === '--verify-only') {
    verifyOnly = true;
    continue;
  }
  if (!['--runtime-base', '--cache-directory', '--payload-directory', '--result-file'].includes(name) || !args[index + 1] || options.has(name)) {
    throw new Error(`Invalid prepare-enhancement option ${name}`);
  }
  options.set(name, path.resolve(args[++index]));
}
const context = {
  runtimeBase: options.get('--runtime-base') || path.join(root, '.build-cache/enhancement/installed'),
  cacheDirectory: options.get('--cache-directory') || path.join(root, '.build-cache/enhancement/install-cache'),
  payloadDirectory: options.get('--payload-directory') || path.join(root, '.build-cache/enhancement/payloads'),
  manifestPath: path.join(root, 'native/enhancement/backend-manifest.json'),
  licensesDirectory: path.join(root, 'native/enhancement/licenses'),
};
const resultFile = options.get('--result-file') || path.join(root, '.build-cache/enhancement/prepared-runtime.json');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort(new Error('Enhancement preparation cancelled')));
process.once('SIGTERM', () => controller.abort(new Error('Enhancement preparation cancelled')));

const installer = await tsImport('../electron/enhancement-install.ts', import.meta.url);
const progress = (value, message) => console.log(JSON.stringify({type: 'progress', progress: value, message}));
const runtime = verifyOnly
  ? await installer.verifyEnhancementRuntime(context, controller.signal)
  : await installer.installEnhancementRuntime(context, progress, controller.signal);
await fs.mkdir(path.dirname(resultFile), {recursive: true});
await fs.writeFile(resultFile, JSON.stringify(runtime, null, 2) + '\n');
console.log(JSON.stringify({type: 'result', verified: true, ...runtime}));
