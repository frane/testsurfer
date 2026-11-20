/**
 * Stand-in for Playwright's tests/page/pageTest.ts: the same `test`
 * and `expect` names, built on testsurfer, with the fixtures the
 * ported specs read. Engine facts answer as WebKit on this OS.
 */

import * as path from 'node:path';
import { after } from 'node:test';
import { expect as tsExpect, test as tsTest } from '../src/index.ts';
import { TestServer } from './server.ts';

const ASSETS = path.resolve(process.env['COMPAT_ASSETS'] ?? path.join(import.meta.dirname, '.cache/playwright/tests/assets'));

let server: TestServer | null = null;
async function sharedServer(): Promise<TestServer> {
  if (!server) {
    server = new TestServer(ASSETS);
    await server.start();
    after(() => server?.stop());
  }
  server.reset();
  return server;
}

export const test = tsTest.extend<{
  server: TestServer;
  browserName: string;
  browserMajorVersion: number;
  channel: string | undefined;
  headless: boolean;
  isAndroid: boolean;
  isElectron: boolean;
  isWebView2: boolean;
  isLinux: boolean;
  isWindows: boolean;
  isMac: boolean;
  mode: string;
  asset: (p: string) => string;
}>({
  server: async (_f, use) => use(await sharedServer()),
  browserName: 'webkit',
  browserMajorVersion: 0,
  channel: undefined,
  headless: true,
  isAndroid: false,
  isElectron: false,
  isWebView2: false,
  isLinux: process.platform === 'linux',
  isWindows: process.platform === 'win32',
  isMac: process.platform === 'darwin',
  mode: 'default',
  asset: (p: string) => path.join(ASSETS, p),
});

export const it = test;
export const expect = tsExpect;

/** Two animation frames, as Playwright's helper waits for. */
export async function rafraf(page: { evaluate: (s: string) => Promise<unknown> }): Promise<void> {
  await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
}
