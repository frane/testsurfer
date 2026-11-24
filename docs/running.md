# Running tests

## Running a Playwright suite

`npx testsurfer test` runs an existing Playwright suite without edits: imports of `@playwright/test` resolve to testsurfer, and extensionless imports (`../fixtures`) resolve as Playwright's runner resolves them. It takes paths, `--grep`, `--workers` and `--update-snapshots`; with no paths it runs the `testDir` from `playwright.config.*`, else `./tests`. Node 22.18 or newer runs `.ts` test files directly.

From a `playwright.config.*` it takes `use.baseURL`, `use.testIdAttribute`, `use.viewport`, `use.actionTimeout` and `navigationTimeout`, `expect.timeout`, `outputDir` and the snapshot paths, with a WebKit project's `use` applied over the top level. It starts each `webServer` (or reuses one with `reuseExistingServer`), runs `globalSetup` before the tests and `globalTeardown` after, and passes environment variables the config or setup set on to the tests, as Playwright does. A `testsurfer.config.*` next to it overrides those options. A test file ends when its tests do, even if something left a timer running.

## The runner

The `test` export wraps node:test with Playwright's test API. Each test gets fresh `page` and `context` fixtures plus the shared `browser`; one browser session is shared across the file.

- `test.describe(name, fn)` groups tests; `.only`, `.skip`, `.parallel` and `.serial` variants exist.
- `test.beforeEach` / `test.afterEach` get the test's fixtures; `test.beforeAll` / `test.afterAll` get `{ browser }`.
- `test.only`, `test.skip(name, fn)` and `test.fixme(name, fn)` register; `test.skip(condition, reason)` inside a test skips it there.
- `test.step(name, fn)` runs a named part of a test and puts the name in its errors.
- `test.extend({ ... })` adds fixtures: a value, `[value, { option: true }]`, or a setup function that receives the other fixtures and calls `use(value)`, with teardown after `use` returns.
- `context.newPage()` opens more pages in a test; `browser.newContext()` opens another context with its own cookie and storage jar. Each test gets a fresh context, as in Playwright; `isolate: false` runs a file's tests in one shared jar instead. `context.on('page')`, `context.on('request')` and `context.waitForEvent(name)` report what the context's pages do.

```ts
const it = test.extend<{ todos: TodoPage }>({
  todos: async ({ page }, use) => {
    const todos = new TodoPage(page);
    await todos.open();
    await use(todos);
  },
});

it('adds one', async ({ todos }) => {
  await todos.add('Buy milk');
});
```

Test files run in parallel: `node --test` gives each file its own process (one less than the CPU count at a time; set it with `--test-concurrency=N`), and each process opens its own session on the shared daemon. Inside a file, tests run one after another unless a describe block calls `test.describe.configure({ mode: 'parallel' })` (or is `test.describe.parallel`); then its tests run at the same time, each with its own page.

Runner integration is optional. Under vitest or any other runner, use `Browser.launch()` directly:

```ts
import { Browser, expect } from 'testsurfer';

const browser = await Browser.launch();
const page = browser.newPage();
await page.goto('https://example.com');
await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible();
await browser.close();
```

## Configuration

Options come from `testsurfer.config.ts` (or `.mts`, `.js`, `.mjs`) in the directory you run the tests from, and from `configure(options)` in a test file, which wins over the file:

```ts
// testsurfer.config.ts
import { defineConfig } from 'testsurfer';

export default defineConfig({ baseURL: 'http://localhost:3000', screenshot: 'only-on-failure' });
```

- `baseURL`: resolve relative `goto` URLs against it.
- `auth: { name, url }`: start every page logged in (see [API](api.md#logging-in-once)).
- `screenshot: 'only-on-failure'` with `outputDir` (default `test-results`): save a PNG when a test fails and add its path to the error.
- `timeouts: { action, expect, navigation }`, in milliseconds.
- `inputMode`: `robotic` (default, instant), `careful`, or `human` (a humanized cursor path for flows that score input behavior).
- `testIdAttribute`: the attribute `getByTestId` reads, default `data-testid`.
- `updateSnapshots`: `missing` (default), `all` or `none`, for `toHaveScreenshot` baselines. `TESTSURFER_UPDATE_SNAPSHOTS=1` means `all`.
- `network`: `proxy` (default) or `shim` (see [Network](network.md)).
- `isolate`: `true` (default) gives every test its own context and jar; `false` shares the browser's session.

## CI

testsurfer runs on macOS, Linux and Windows GitHub runners. On Linux it needs WebKitGTK 6 and an X display, and on Windows the WebView2 runtime the runners already have. The action in this repo installs what is missing and starts the pinned vibesurfer daemon:

```yaml
jobs:
  test:
    runs-on: ubuntu-24.04 # or macos-15, windows-2025
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - uses: frane/testsurfer@v0
      - run: npx testsurfer test
```

`vibesurfer-version` overrides the pinned daemon. This repo's own CI runs the same action on all three.

## How it works

vibesurfer is a daemon that owns one real WebKit engine and speaks a line protocol over a Unix socket. testsurfer is a TypeScript client for that protocol. Locators resolve inside the page, in one evaluate per call, with Playwright's semantics: CSS that pierces open shadow roots, text, role and label queries, strict mode, actionability checks. vibesurfer supplies trusted native input, screenshots, navigation and the accessibility tree behind `toMatchAriaSnapshot`.

The daemon is fetched automatically. If `vs` is not on your PATH, testsurfer runs `npx vibesurfer@0.2.19` (pinned, checksum-verified) to download and start it. Set `TESTSURFER_VS` to point at a specific binary. testsurfer reads the daemon's protocol version and feature flags at launch and uses what it offers, so a newer `vs` on your PATH works too.

## Working on testsurfer

```sh
npm install
npm run test:unit   # protocol and locator tests, no daemon needed
npm run test:e2e    # drives a real page through a local daemon
npm run build
```
