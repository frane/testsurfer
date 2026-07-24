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
let teardownRegistered = false;

/** Override launch options for the shared browser. Call before the first test runs. */
export function configure(options: LaunchOptions): void {
  launchOptions = options;
}

/**
 * Register the session teardown as a root-level after() hook. This
 * must happen at test registration time (when the user's test file
 * calls test() at module scope), not during a test run: a hook
 * registered mid-test attaches to that test and would close the
 * shared browser after the first test finishes.
 */
function ensureTeardown(): void {
  if (teardownRegistered) return;
  teardownRegistered = true;
  after(async () => {
    if (shared) await (await shared).close();
  });
}

function sharedBrowser(): Promise<Browser> {
  shared ??= Browser.launch(launchOptions);
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
  ensureTeardown();
  nodeTest(name, () => withPage(fn));
}

test.only = (name: string, fn: TestFn): void => {
  ensureTeardown();
  nodeTest(name, { only: true }, () => withPage(fn));
};

test.skip = (name: string, fn: TestFn): void => {
  ensureTeardown();
  nodeTest(name, { skip: true }, () => withPage(fn));
};
