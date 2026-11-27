/**
 * A `test` wrapper over node:test with Playwright's test API: the
 * `{ page, context, browser }` fixtures, describe blocks with hooks,
 * parallel mode, steps, conditional skips, and custom fixtures through
 * test.extend(). One browser session is shared across the file; each
 * test gets a fresh context and page, closed afterwards.
 *
 * The locator and assertion library is runner-agnostic; under vitest
 * or plain node:test you can skip this wrapper and manage a Browser
 * yourself with `Browser.launch()`.
 */

import { test as nodeTest, describe as nodeDescribe, after, before } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Browser, type LaunchOptions } from './browser.ts';
import { CONTEXT_OPTION_KEYS, type BrowserContext, type ContextOptions } from './context.ts';
import type { StorageState } from './cookies.ts';
import { currentTestInfo, testInfoStore, updateSnapshotsFromEnv, type TestInfo, type UpdateSnapshots } from './testinfo.ts';
import type { Page } from './page.ts';
import { findPlaywrightConfig, importPlaywrightConfig, runnerOptionsFrom } from './pwconfig.ts';

export interface TestFixtures {
  page: Page;
  context: BrowserContext;
  browser: Browser;
}

export interface WorkerFixtures {
  browser: Browser;
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
  /** Directory for failure screenshots and screenshot diffs. Default `test-results`. */
  outputDir?: string;
  /**
   * toHaveScreenshot baselines: `missing` (default) writes absent ones
   * and fails that test, `all` rewrites every one, `none` never
   * writes. TESTSURFER_UPDATE_SNAPSHOTS=1 means `all`.
   */
  updateSnapshots?: UpdateSnapshots;
  /**
   * Give every test its own cookie and storage jar (default true, as
   * Playwright does). false runs all tests in the browser's session,
   * sharing the engine's persistent jar.
   */
  isolate?: boolean;
  /**
   * How page.route() and network events see requests. `proxy` (default)
   * sends every http(s) request through vibesurfer's intercepting
   * proxy: documents, iframes, scripts, images, fetch and XHR are
   * reported and routable, and popups and dialogs are events. `shim`
   * patches fetch and XHR in the page instead and has neither.
   */
  network?: 'shim' | 'proxy';
  /** Cookies and localStorage every test's context starts with (Playwright's `use.storageState`): a state object or a JSON file. */
  storageState?: StorageState | string;
  /** Per-test time limit in ms (Playwright's `timeout`); 0 for none. Default 30000. */
  testTimeout?: number;
  /** newContext() options for every test (Playwright's `use`: colorScheme, locale, timezoneId, userAgent, ...). */
  contextOptions?: ContextOptions;
  /** Where toMatchSnapshot(name) keeps baselines; Playwright's tokens. */
  snapshotPathTemplate?: string;
}

type Fixtures = Record<string, unknown>;
type TestBody<F> = (fixtures: F, testInfo: TestInfo) => Promise<void> | void;
type AllHook = (fixtures: WorkerFixtures) => Promise<void> | void;
type FixtureFn = (fixtures: Fixtures, use: (value: unknown) => Promise<void>) => Promise<void>;
/** A test.extend() definition: a value, a setup function, or `[value, { option: true }]`. */
type FixtureDef = unknown;

let shared: Promise<Browser> | null = null;
let options: RunnerOptions = {};
let teardownRegistered = false;

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
 * Options from the working directory: what applies of a
 * playwright.config.*, then the first testsurfer.config.* on top. Read
 * once, when the first test launches the browser.
 */
async function loadConfigFile(): Promise<RunnerOptions> {
  const pw = findPlaywrightConfig();
  const base = pw ? (runnerOptionsFrom(await importPlaywrightConfig(pw), path.dirname(pw)) as RunnerOptions) : {};
  for (const name of CONFIG_FILES) {
    const file = path.resolve(name);
    if (!fs.existsSync(file)) continue;
    const mod = (await import(pathToFileURL(file).href)) as { default?: RunnerOptions };
    const own = mod.default ?? {};
    return { ...base, ...own, timeouts: { ...base.timeouts, ...own.timeouts } };
  }
  return base;
}

/** The whole session teardown at the end of a test file. */
const TEARDOWN_TIMEOUT_MS = 60_000;

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
  after(
    async () => {
      // Worker fixtures tear down before the browser they may use closes.
      for (const t of workerTeardowns.splice(0).reverse()) await t().catch(() => {});
      if (shared) await (await shared).close();
    },
    // A teardown against a daemon that stopped answering must end the
    // file, not hold it open until the CI job is cancelled.
    { timeout: TEARDOWN_TIMEOUT_MS },
  );
}

/** Worker-scoped fixture values, set up once per worker process (by definition) and torn down at its end. */
const workerValues = new Map<FixtureFn, Promise<unknown>>();
const workerTeardowns: (() => Promise<void>)[] = [];

function workerValue(fn: FixtureFn, base: Fixtures): Promise<unknown> {
  let p = workerValues.get(fn);
  if (!p) {
    p = new Promise<unknown>((resolve, reject) => {
      let release!: () => void;
      const done = new Promise<void>((r) => (release = r));
      let used = false;
      const run = fn(base, async (v) => {
        used = true;
        resolve(v);
        await done;
      }).then(() => {
        if (!used) reject(new Error('worker fixture did not call use()'));
      }, reject);
      workerTeardowns.push(async () => {
        release();
        await run;
      });
    });
    workerValues.set(fn, p);
  }
  return p;
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

// --- registration --------------------------------------------------------

interface TestOpts {
  only?: boolean;
  skip?: boolean | string;
}

interface Scope {
  title?: string;
  /** Group-level skip/fixme/fail/slow, decided per test from its fixtures. */
  conditions?: { kind: 'skip' | 'fixme' | 'fail' | 'slow'; when: (f: Fixtures) => unknown; reason?: string | undefined }[];
  /** test.use() overrides, applied to tests registered after them in this scope. */
  uses?: Record<string, unknown>;
  beforeEach: TestBody<Fixtures>[];
  afterEach: TestBody<Fixtures>[];
  mode: 'default' | 'parallel' | 'serial';
  /** Set while a describe body is being collected; null at file level. */
  items: Item[] | null;
}

type Item =
  | { kind: 'test'; name: string; fn: TestBody<Fixtures>; opts: TestOpts; chain: Scope[]; defs: Record<string, FixtureDef> }
  | { kind: 'describe'; name: string; scope: Scope; opts: TestOpts }
  | { kind: 'beforeAll' | 'afterAll'; fn: AllHook };

const root: Scope = { beforeEach: [], afterEach: [], mode: 'default', items: null };
/** Innermost scope last. */
const stack: Scope[] = [root];
const current = () => stack[stack.length - 1]!;

function add(item: Item): void {
  ensureTeardown();
  const scope = current();
  if (scope.items) scope.items.push(item);
  else register(item);
}

/** Hand an item to node:test. Describe bodies were collected first, so their mode is known. */
function register(item: Item): void {
  switch (item.kind) {
    case 'test':
      nodeTest(item.name, nodeOpts(item.opts), runWith(item.name, item.fn, item.chain, item.defs));
      return;
    case 'beforeAll':
      before(async () => item.fn({ browser: await sharedBrowser() }));
      return;
    case 'afterAll':
      after(async () => item.fn({ browser: await sharedBrowser() }));
      return;
    case 'describe': {
      const { scope } = item;
      const o: Record<string, unknown> = { ...nodeOpts(item.opts) };
      if (scope.mode === 'parallel') o['concurrency'] = true;
      // playwright.config `fullyParallel` (passed on by `testsurfer test`):
      // a group's tests run a few at a time unless it asks for serial.
      else if (scope.mode === 'default' && process.env['TESTSURFER_FULLY_PARALLEL'] === '1') o['concurrency'] = 4;
      nodeDescribe(item.name, o, () => {
        for (const child of scope.items ?? []) register(child);
      });
    }
  }
}

function nodeOpts(o: TestOpts): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.only) out['only'] = true;
  if (o.skip) out['skip'] = o.skip;
  return out;
}

function describeWith(name: string, body: () => void, opts: TestOpts, mode: Scope['mode']): void {
  const scope: Scope = { title: name, beforeEach: [], afterEach: [], mode, items: [] };
  stack.push(scope);
  try {
    body();
  } finally {
    stack.pop();
  }
  add({ kind: 'describe', name, scope, opts });
}

// --- running -------------------------------------------------------------

type NodeTestContext = { filePath?: string | undefined; skip?: (message?: string) => void };

/** Thrown by a conditional test.skip() inside a test to stop it. */
class SkipSignal extends Error {}

/** Playwright's default per-test timeout. */
const DEFAULT_TEST_TIMEOUT_MS = 30_000;

/**
 * skip(), fixme() and friends take (condition?, reason?): no condition,
 * or a string reason alone, means unconditionally.
 */
const when = (c: boolean | string | undefined, r: string | undefined): [boolean, string | undefined] =>
  typeof c === 'string' ? [true, c] : [c ?? true, r];

/** The TestInfo for one run of test `name`. */
function makeTestInfo(name: string, chain: Scope[], t: NodeTestContext, outputDir: string): TestInfo {
  const info: TestInfo = {
    title: name,
    titlePath: [...chain.map((s) => s.title).filter((x): x is string => !!x), name],
    file: t.filePath ?? process.argv[1] ?? 'test',
    snapshotIndex: 0,
    outputDir,
    updateSnapshots: updateSnapshotsFromEnv() ?? options.updateSnapshots ?? 'missing',
    snapshotPathTemplate: options.snapshotPathTemplate,
    annotations: [],
    attachments: [],
    softErrors: [],
    retry: 0,
    workerIndex: 0,
    parallelIndex: 0,
    project: { name: process.env['TESTSURFER_PROJECT'] ?? 'webkit', use: {} },
    timeout: options.testTimeout ?? DEFAULT_TEST_TIMEOUT_MS,
    expectedStatus: 'passed',
    skip: (c, r) => {
      const [on, reason] = when(c, r);
      if (!on) return;
      info.annotations.push({ type: 'skip', description: reason });
      t.skip?.(reason);
      throw new SkipSignal(reason ?? 'skipped');
    },
    fixme: (c, r) => info.skip(c, r),
    fail: (c, r) => {
      const [on, reason] = when(c, r);
      if (!on) return;
      info.annotations.push({ type: 'fail', description: reason });
      info.expectedStatus = 'failed';
    },
    slow: (c, r) => {
      const [on, reason] = when(c, r);
      if (!on) return;
      info.annotations.push({ type: 'slow', description: reason });
      // Like Playwright: a slow test gets three times the timeout.
      info.timeout *= 3;
    },
    setTimeout: (ms) => {
      info.timeout = ms;
    },
    outputPath: (...parts) => path.resolve(outputDir, safeName(name), ...parts),
    attach: async (n, o = {}) => {
      const body = typeof o.body === 'string' ? Buffer.from(o.body) : o.body;
      info.attachments.push({ name: n, contentType: o.contentType ?? 'application/octet-stream', path: o.path, body });
    },
  };
  return info;
}

function runWith(
  name: string,
  fn: TestBody<Fixtures>,
  chain: Scope[],
  defs: Record<string, FixtureDef>,
): (t: NodeTestContext) => Promise<void> {
  return async (t: NodeTestContext) => {
    // Launching merges the config file into `options`; do it before
    // reading outputDir and updateSnapshots.
    await sharedBrowser();
    const info = makeTestInfo(name, chain, t, options.outputDir ?? 'test-results');
    try {
      await testInfoStore.run(info, () => runExpectingStatus(info, runTest(name, fn, chain, defs, info)));
    } catch (e) {
      if (!(e instanceof SkipSignal)) throw e;
    }
  };
}

/** Run the test under its timeout; with test.fail(), a pass is the failure. */
async function runExpectingStatus(info: TestInfo, run: Promise<void>): Promise<void> {
  let threw = false;
  try {
    await withTestTimeout(info, run);
  } catch (e) {
    if (e instanceof SkipSignal || info.expectedStatus !== 'failed') throw e;
    threw = true;
  }
  if (info.expectedStatus === 'failed' && !threw) {
    throw new Error('expected to fail, but passed (test.fail)');
  }
}

/** Contexts of running tests, closed when a test runs out of time. */
const runningContexts = new WeakMap<TestInfo, BrowserContext>();

/**
 * Fail the test once it has run for `info.timeout` ms (0: no limit),
 * as Playwright does; the limit can change while it runs
 * (test.setTimeout, test.slow). Its context is closed so whatever it
 * waits on ends too.
 */
async function withTestTimeout(info: TestInfo, run: Promise<void>): Promise<void> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<never>((_, reject) => {
    const check = () => {
      const limit = info.timeout;
      const left = limit > 0 ? started + limit - Date.now() : 60_000;
      if (limit > 0 && left <= 0) {
        void runningContexts.get(info)?.close().catch(() => {});
        reject(new Error(`Test timeout of ${limit}ms exceeded.`));
        return;
      }
      timer = setTimeout(check, Math.min(left, 1000));
      timer.unref?.();
    };
    check();
  });
  try {
    await Promise.race([run, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Set up test.extend() fixtures in order, run `inner` with all of them, tear down in reverse. */
async function withFixtures(
  base: Fixtures,
  defs: Record<string, FixtureDef>,
  inner: (all: Fixtures) => Promise<void>,
): Promise<void> {
  const entries = Object.entries(defs);
  const step = async (i: number, acc: Fixtures): Promise<void> => {
    if (i === entries.length) return inner(acc);
    const [key, def] = entries[i]!;
    const opts = Array.isArray(def) && def.length === 2 && typeof def[1] === 'object' && def[1] !== null ? (def[1] as { scope?: string }) : null;
    const value = opts ? (def as unknown[])[0] : def;
    if (typeof value !== 'function') return step(i + 1, { ...acc, [key]: value });
    if (opts?.scope === 'worker') return step(i + 1, { ...acc, [key]: await workerValue(value as FixtureFn, acc) });
    let used = false;
    let innerError: unknown = null;
    await (value as FixtureFn)(acc, async (v) => {
      used = true;
      try {
        await step(i + 1, { ...acc, [key]: v });
      } catch (e) {
        innerError = e;
      }
    });
    if (!used) throw new Error(`fixture "${key}" did not call use()`);
    if (innerError) throw innerError;
  };
  await step(0, base);
}

async function runTest(
  name: string,
  fn: TestBody<Fixtures>,
  chain: Scope[],
  defs: Record<string, FixtureDef>,
  info: TestInfo,
): Promise<void> {
  const befores = chain.flatMap((s) => s.beforeEach);
  const afters = chain.flatMap((s) => s.afterEach).reverse();
  const browser = await sharedBrowser();
  // Each test gets a fresh, isolated context unless the suite opts out.
  // Context options: the config's `use`, then test.use() values.
  const ctxOpts: ContextOptions = { ...(options.contextOptions ?? {}) };
  for (const k of CONTEXT_OPTION_KEYS) {
    const d = defs[k];
    const v = Array.isArray(d) && d.length === 2 && typeof d[1] === 'object' ? d[0] : d;
    if (v !== undefined && typeof v !== 'function') (ctxOpts as Record<string, unknown>)[k] = v;
  }
  if (ctxOpts.storageState === undefined && options.storageState !== undefined) ctxOpts.storageState = options.storageState;
  if (typeof ctxOpts.storageState === 'string') ctxOpts.storageState = path.resolve(ctxOpts.storageState);
  const context =
    options.isolate === false
      ? browser.sharedContext()
      : await browser.newContext({ intercept: options.network !== 'shim', ...ctxOpts });
  runningContexts.set(info, context);
  const page = await context.newPage();
  try {
    if (options.auth) {
      await page.goto(options.auth.url);
      await page.loadAuth(options.auth.name);
    }
    await withFixtures({ page, context, browser }, defs, async (all) => {
      try {
        for (const c of chain.flatMap((s) => s.conditions ?? [])) {
          if (c.when(all)) info[c.kind](true, c.reason);
        }
        for (const h of befores) await h(all, info);
        await fn(all, info);
        if (info.softErrors.length > 0) {
          const [first, ...rest] = info.softErrors;
          if (rest.length && first instanceof Error) first.message += `\n\n(and ${rest.length} more soft assertion failure${rest.length > 1 ? 's' : ''})`;
          throw first;
        }
      } catch (e) {
        if (!(e instanceof SkipSignal) && options.screenshot === 'only-on-failure') {
          const file = path.join(options.outputDir ?? 'test-results', `${safeName(name)}.png`);
          const saved = await page.screenshot({ path: file }).then(() => true, () => false);
          if (saved && e instanceof Error) e.message += `\n  screenshot: ${file}`;
        }
        throw e;
      } finally {
        for (const h of afters) await h(all, info);
      }
    });
  } finally {
    await context.close().catch(() => {});
  }
}

// --- the public API ------------------------------------------------------

export interface DescribeFn {
  (name: string, body: () => void): void;
  only: (name: string, body: () => void) => void;
  skip: (name: string, body: () => void) => void;
  /** Tests in this group run at the same time, each with its own page. */
  parallel: (name: string, body: () => void) => void;
  /** Tests in this group run one after another (the default). */
  serial: (name: string, body: () => void) => void;
  /** Inside a describe body: `{ mode: 'parallel' }` runs the group's tests at the same time. */
  configure: (o: { mode?: 'default' | 'parallel' | 'serial'; retries?: number; timeout?: number }) => void;
  fixme: (name: string, body: () => void) => void;
}

export interface TestApi<F extends object> {
  (name: string, fn: TestBody<F>): void;
  only: (name: string, fn: TestBody<F>) => void;
  /** `skip(name, fn)` registers a skipped test; `skip(condition?, reason?)` inside a test skips it. */
  skip: {
    (name: string, fn: TestBody<F>): void;
    (condition?: boolean, reason?: string): void;
  };
  /** Same as skip: a test known to be broken. */
  fixme: {
    (name: string, fn: TestBody<F>): void;
    (condition?: boolean, reason?: string): void;
  };
  /** A test expected to throw: it passes only if its body fails. */
  fail: {
    (name: string, fn: TestBody<F>): void;
    (condition?: boolean, reason?: string): void;
  };
  /** Marks the running test slow (an annotation; there is no timeout tripling). */
  slow: (condition?: boolean, reason?: string) => void;
  setTimeout: (ms: number) => void;
  /** The running test's TestInfo. */
  info: () => TestInfo;
  /** Override fixture values for the tests in this file or describe block. */
  use: (values: Partial<F> & Record<string, unknown>) => void;
  describe: DescribeFn;
  beforeEach: (fn: TestBody<F>) => void;
  afterEach: (fn: TestBody<F>) => void;
  beforeAll: (fn: AllHook) => void;
  afterAll: (fn: AllHook) => void;
  /** A named part of a test. Runs `body` and returns its result; the name shows in errors. */
  step: <T>(name: string, body: () => Promise<T> | T) => Promise<T>;
  /** A test API whose tests also get these fixtures (Playwright's test.extend). */
  extend: <E extends object>(defs: { [K in keyof E]: FixtureDefFor<F & E, E[K]> }) => TestApi<F & E>;
}

/**
 * A fixture value, a setup function that calls `use(value)`, or either
 * with options: `[value, { option: true }]`, `[fn, { scope: 'worker' }]`
 * (set up once per worker and shared by its tests), `auto`, `timeout`.
 */
export type FixtureDefFor<All, V> =
  | V
  | [V | ((fixtures: All, use: (value: V) => Promise<void>) => Promise<void>), { option?: boolean; scope?: 'test' | 'worker'; auto?: boolean; timeout?: number; box?: boolean }]
  | ((fixtures: All, use: (value: V) => Promise<void>) => Promise<void>);

/**
 * skip/fixme/fail/slow called outside a test, in a describe body or at
 * file level: the condition (a boolean, or a function of the fixtures)
 * applies to every test in that scope. Returns false inside a test.
 */
function grouped(kind: 'skip' | 'fixme' | 'fail' | 'slow', a: unknown, reason: string | undefined): boolean {
  if (currentTestInfo()) return false;
  const when = typeof a === 'function' ? (a as (f: Fixtures) => unknown) : () => a ?? true;
  const scope = current();
  (scope.conditions ??= []).push({ kind, when, reason });
  return true;
}

/** The running test's TestInfo; `test.<what>()` outside a test is an error. */
function running(what: string): TestInfo {
  const info = currentTestInfo();
  if (!info) throw new Error(`test.${what}() must be called inside a test`);
  return info;
}

/** test.step(): run `body`, prefixing a failure with the step's name. */
async function step<T>(name: string, body: () => Promise<T> | T): Promise<T> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof Error && !(e instanceof SkipSignal)) e.message = `step "${name}": ${e.message}`;
    throw e;
  }
}

function makeTest<F extends object>(defs: Record<string, FixtureDef>): TestApi<F> {
  const reg = (name: string, fn: TestBody<F>, opts: TestOpts) =>
    add({
      kind: 'test',
      name,
      fn: fn as TestBody<Fixtures>,
      opts,
      chain: [...stack],
      defs: Object.assign({}, defs, ...stack.map((s) => s.uses ?? {})),
    });

  // test(title, body) or test(title, details, body); details are ignored.
  const body = (a: unknown[]) => a.find((x) => typeof x === 'function') as TestBody<F>;
  const t = ((name: string, ...rest: unknown[]) => reg(name, body(rest), {})) as TestApi<F>;
  t.only = ((name: string, ...rest: unknown[]) => reg(name, body(rest), { only: true })) as TestApi<F>['only'];
  const skipper = ((a?: string | boolean, b?: TestBody<F> | string | object, c?: TestBody<F>) => {
    if (typeof a === 'string' && (typeof b === 'function' || typeof c === 'function')) {
      reg(a, (typeof b === 'function' ? b : c) as TestBody<F>, { skip: true });
      return;
    }
    if (grouped('skip', a, typeof b === 'string' ? b : undefined)) return;
    if (a === false) return;
    running('skip').skip(a ?? true, typeof b === 'string' ? b : undefined);
  }) as TestApi<F>['skip'];
  t.skip = skipper;
  t.fixme = skipper;
  t.fail = ((a?: string | boolean, b?: TestBody<F> | string) => {
    if (typeof a === 'string' && typeof b === 'function') {
      reg(a, (async (f: F, info: TestInfo) => {
        info.fail();
        await b(f, info);
      }) as TestBody<F>, {});
      return;
    }
    if (grouped('fail', a, typeof b === 'string' ? b : undefined)) return;
    running('fail').fail(a ?? true, typeof b === 'string' ? b : undefined);
  }) as TestApi<F>['fail'];
  t.slow = (c, r) => {
    if (grouped('slow', c, r)) return;
    running('slow').slow(c ?? true, r);
  };
  t.setTimeout = (ms) => running('setTimeout').setTimeout(ms);
  t.info = () => running('info');
  t.use = (values) => {
    const scope = current();
    scope.uses = { ...scope.uses, ...values };
  };
  t.describe = describeApi;
  t.beforeEach = (fn) => current().beforeEach.push(fn as TestBody<Fixtures>);
  t.afterEach = (fn) => current().afterEach.push(fn as TestBody<Fixtures>);
  t.beforeAll = (fn) => add({ kind: 'beforeAll', fn });
  t.afterAll = (fn) => add({ kind: 'afterAll', fn });
  t.step = step;
  t.extend = <E extends object>(more: Record<string, unknown>) => makeTest<F & E>({ ...defs, ...more });
  return t;
}

/**
 * describe(body), describe(title, body) and describe(title, details,
 * body) all register a group; details ({ tag, annotation }) are
 * accepted and ignored.
 */
function groupArgs(args: unknown[]): [string, () => void] {
  const body = args.find((a) => typeof a === 'function') as (() => void) | undefined;
  if (!body) throw new Error('test.describe() needs a body function');
  return [typeof args[0] === 'string' ? args[0] : '', body];
}

const describeWithArgs = (args: unknown[], opts: TestOpts, mode: Scope['mode']) => {
  const [name, body] = groupArgs(args);
  describeWith(name, body, opts, mode);
};
const describeApi = ((...a: unknown[]) => describeWithArgs(a, {}, 'default')) as DescribeFn;
describeApi.only = ((...a: unknown[]) => describeWithArgs(a, { only: true }, 'default')) as DescribeFn['only'];
describeApi.skip = ((...a: unknown[]) => describeWithArgs(a, { skip: true }, 'default')) as DescribeFn['skip'];
describeApi.parallel = ((...a: unknown[]) => describeWithArgs(a, {}, 'parallel')) as DescribeFn['parallel'];
describeApi.serial = ((...a: unknown[]) => describeWithArgs(a, {}, 'serial')) as DescribeFn['serial'];
describeApi.fixme = describeApi.skip;
describeApi.configure = (o) => {
  // At file level it applies to the file's top-level tests.
  if (o.mode) current().mode = o.mode;
};

export const test: TestApi<TestFixtures> = makeTest<TestFixtures>({});
