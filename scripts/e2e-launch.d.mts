import type { _electron } from 'playwright';

export declare function launchTestElectron(
  options?: Parameters<typeof _electron.launch>[0],
): ReturnType<typeof _electron.launch>;
