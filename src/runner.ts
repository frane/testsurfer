/**
 * A thin `test` wrapper over node:test that provides the `{ page }`
 * fixture. One browser session is shared across the file; each test
 * gets a fresh page that is closed afterwards.
 *
 * The locator and assertion library is runner-agnostic; under vitest
 * or plain node:test you can skip this wrapper and manage a Browser
 * yourself with `Browser.launch()`.
 */

import { test as nodeTest, describe as nodeDescribe, after } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Browser, type LaunchOptions } from './browser.ts';
import type { Page } from './page.ts';

export interface TestFixtures {
  page: Page;
}

export interface RunnerOptions extends LaunchOptions {
  /**
   * Start every test's page logged in: open `url` (any page on the
   * site), restore the login saved under `name` with page.saveAuth(),
   * and hand the test the page. Storage is per origin, which is why a
   * URL on the site is needed.
   */
  auth?: { name: string; url: string };
  /** Save a PNG of the page when a test fails. Default `off`. */
  screenshot?: 'off' | 'only-on-failure';
  /** Directory for failure screenshots. Default `test-results`. */
  outputDir?: string;
}

type TestFn = (fixtures: TestFixtures) => Promise<void> | void;
type HookFn = (fixtures: TestFixtures) => Promise<void> | void;

let shared: Promise<Browser> | null = null;
let options: RunnerOptions = {};
let teardownRegistered = false;

/** Hooks registered at each describe depth, innermost last. */
const hookStack: { before: HookFn[]; after: HookFn[] }[] = [{ before: [], after: [] }];

/** Override options for the shared browser. Call before the first test runs. Wins over the config file. */
export function configure(next: RunnerOptions): void {
  options = next;
}

/** Identity helper that types a config file's default export. */
export function defineConfig(config: RunnerOptions): RunnerOptions {
  return config;
}

const CONFIG_FILES = ['testsurfer.config.ts', 'testsurfer.config.mts', 'testsurfer.config.js', 'testsurfer.config.mjs'];

/**
 * The default export of the first testsurfer.config.* in the working
 * directory, or `{}`. Read once, when the first test launches the
 * browser.
 */
async function loadConfigFile(): Promise<RunnerOptions> {
  for (const name of CONFIG_FILES) {
    const file = path.resolve(name);
    if (!fs.existsSync(file)) continue;
    const mod = (await import(pathToFileURL(file).href)) as { default?: RunnerOptions };
    return mod.default ?? {};
  }
  return {};
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
  shared ??= loadConfigFile().then((file) => {
    options = { ...file, ...options, timeouts: { ...file.timeouts, ...options.timeouts } };
    return Browser.launch(options);
  });
  return shared;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || 'test';
}

function runWith(name: string, fn: TestFn): () => Promise<void> {
  // Capture the scopes now, at registration (a describe block pops its
  // scope once its body has run), but read their hooks at run time so
  // a hook declared after a test in the same scope still applies.
  const scopes = [...hookStack];
  return async () => {
    const befores = scopes.flatMap((h) => h.before);
    const afters = scopes.flatMap((h) => h.after).reverse();
    const browser = await sharedBrowser();
    const page = browser.newPage();
    try {
      if (options.auth) {
        await page.goto(options.auth.url);
        await page.loadAuth(options.auth.name);
      }
      try {
        for (const h of befores) await h({ page });
        await fn({ page });
      } catch (e) {
        if (options.screenshot === 'only-on-failure') {
          const file = path.join(options.outputDir ?? 'test-results', `${safeName(name)}.png`);
          const saved = await page.screenshot({ path: file }).catch(() => null);
          if (saved && e instanceof Error) e.message += `\n  screenshot: ${saved}`;
        }
        throw e;
      } finally {
        for (const h of afters) await h({ page });
      }
    } finally {
      await page.close().catch(() => {});
    }
  };
}

export function test(name: string, fn: TestFn): void {
  ensureTeardown();
  nodeTest(name, runWith(name, fn));
}

test.only = (name: string, fn: TestFn): void => {
  ensureTeardown();
  nodeTest(name, { only: true }, runWith(name, fn));
};

test.skip = (name: string, fn: TestFn): void => {
  ensureTeardown();
  nodeTest(name, { skip: true }, runWith(name, fn));
};

/** Group tests. Hooks registered inside apply to the group's tests only. */
test.describe = (name: string, body: () => void): void => {
  ensureTeardown();
  nodeDescribe(name, () => {
    hookStack.push({ before: [], after: [] });
    try {
      body();
    } finally {
      hookStack.pop();
    }
  });
};

/** Run before each test in the current scope, with the test's page. */
test.beforeEach = (fn: HookFn): void => {
  hookStack[hookStack.length - 1]!.before.push(fn);
};

/** Run after each test in the current scope, pass or fail. */
test.afterEach = (fn: HookFn): void => {
  hookStack[hookStack.length - 1]!.after.push(fn);
};
