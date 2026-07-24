/**
 * A thin `test` wrapper over node:test that provides the `{ page }`
 * fixture. One browser session is shared across the file; each test
 * gets a fresh page that is closed afterwards.
 *
 * The locator and assertion library is runner-agnostic; under vitest
 * or plain node:test you can skip this wrapper and manage a Browser
 * yourself with `Browser.launch()`.
 */

import { test as nodeTest, after } from 'node:test';
import { Browser, type LaunchOptions } from './browser.ts';
import type { Page } from './page.ts';

export interface TestFixtures {
  page: Page;
}

type TestFn = (fixtures: TestFixtures) => Promise<void> | void;

let shared: Promise<Browser> | null = null;
let launchOptions: LaunchOptions = {};

/** Override launch options for the shared browser. Call before the first test runs. */
export function configure(options: LaunchOptions): void {
  launchOptions = options;
}

function sharedBrowser(): Promise<Browser> {
  if (!shared) {
    shared = Browser.launch(launchOptions);
    after(async () => {
      const b = await shared;
      await b?.close();
    });
  }
  return shared;
}

async function withPage(fn: TestFn): Promise<void> {
  const browser = await sharedBrowser();
  const page = browser.newPage();
  try {
    await fn({ page });
  } finally {
    await page.close().catch(() => {});
  }
}

export function test(name: string, fn: TestFn): void {
  nodeTest(name, () => withPage(fn));
}

test.only = (name: string, fn: TestFn): void => {
  nodeTest(name, { only: true }, () => withPage(fn));
};

test.skip = (name: string, fn: TestFn): void => {
  nodeTest(name, { skip: true }, () => withPage(fn));
};
