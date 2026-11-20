# testsurfer

End-to-end testing for the web, driven by [vibesurfer](https://github.com/frane/vibesurfer).

testsurfer is lightweight. It drives the browser engine already on your machine through vibesurfer, a small native binary. Nothing bundles Chromium or Firefox or WebKit; you add one small dependency and get a real WebKit engine with fast cold starts and cheap CI.

Tests address the page through its accessibility tree. You assert on roles and labels instead of CSS selectors, so tests survive DOM and styling churn. And because the engine is a plain OS webview, no automation protocol is attached to the page: no WebDriver, no CDP, and `navigator.webdriver` is `undefined`.

```ts
import { test, expect } from 'testsurfer';

test('login', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.getByRole('textbox', { name: 'Email' }).fill('a@b.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
```

Install it and run with node's built-in test runner:

```sh
npm install -D testsurfer
node --test tests/
```

Node 22.18 or newer runs the `.ts` test files directly.

## How it works

vibesurfer is a daemon that owns one real WebKit engine and speaks a line protocol over a Unix socket. testsurfer is a TypeScript client for that protocol. It opens a session, resolves your locators against the live accessibility tree, and handles the daemon's optimistic-concurrency tokens internally. You never see a token, a ref, or a retry.

The daemon is fetched automatically. If `vs` is not on your PATH, testsurfer runs `npx vibesurfer@0.2.14` (pinned, checksum-verified) to download and start it. Set `TESTSURFER_VS` to point at a specific binary. testsurfer reads the daemon's protocol version and feature flags at launch and uses what it offers, so a newer `vs` on your PATH works too.

## CI

testsurfer runs on macOS and Linux GitHub runners. On Linux it needs WebKitGTK 6 and an X display; the action in this repo installs both and starts the pinned vibesurfer daemon:

```yaml
jobs:
  test:
    runs-on: ubuntu-24.04 # or macos-15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - uses: frane/testsurfer@v0
      - run: node --test tests/
```

`vibesurfer-version` overrides the pinned daemon. This repo's own CI runs the same action on both runners. Windows (WebView2) is supported by vibesurfer but not yet tested here.

## API

Locators resolve lazily at action time, against a fresh view:

- `page.getByRole(role, { name, exact, level })` matches ARIA roles (`button`, `textbox`, `heading`, `link`, ...). Name matching is whole-string and case-insensitive by default; `exact: true` makes it case-sensitive. RegExp names are supported.
- `page.getByText(text, { exact })` matches visible text, substring and case-insensitive by default.
- `page.getByLabel(text, { exact })` matches form fields by their `<label>` (for, wrapping, or `aria-labelledby`) or `aria-label`.
- `page.getByTestId(id)` matches `data-testid` exactly (string or RegExp). The `testIdAttribute` option changes the attribute.
- `page.getByPlaceholder(text)`, `page.getByAltText(text)` and `page.getByTitle(text)` match those attributes, substring and case-insensitive by default, whole-string with `{ exact: true }`.
- `page.locator(css)` takes a CSS selector.
- Every `getBy*` and `locator()` also exists on a locator and searches inside its matches: `page.getByTestId('cart').getByRole('button', { name: 'Remove' })`.
- `.filter({ hasText, hasNotText, has, hasNot, visible })` narrows matches; `has` and `hasNot` take a locator searched inside each match.
- `.and(locator)` keeps elements matching both, `.or(locator)` takes either.
- `.first()`, `.last()` and `.nth(i)` pick one match when several qualify, and `all()` returns one locator per match. Otherwise a locator that matches more than one element fails the action, like Playwright's strict mode.

Role, text and label queries match the accessibility tree. CSS and attribute queries run in the page and map each element to its node in that tree. An element the tree does not report resolves to the first reported element inside it, or to its nearest reported ancestor when there is none: a `<span>` whose text the tree folded into its list item acts as that item, so `toHaveText` sees the item's text.

Actions auto-wait for their element and retry when the page changes underneath them: `click()`, `fill(value)`, `type(text)` (trusted native keystrokes, for rich-text editors), `press(key)`, `hover()`, `focus()`, `check()`, `uncheck()`, `dragTo(locator)`. Reads: `textContent()`, `innerText()`, `inputValue()`, `getAttribute(name)`, `isChecked()`, `isVisible()`, `isHidden()`, `isEnabled()`, `isDisabled()`, `isEditable()`, `isFocused()`, `boundingBox()`, `count()`, `all()`, `ariaSnapshot()`.

Clicks and keystrokes dispatch as native OS input. The cadence is configurable per browser: the default `inputMode: 'robotic'` is instant, which is what tests want; `'human'` moves the cursor along a humanized path with realistic timing for flows that score input behavior.

Assertions poll until they pass or time out:

- `expect(locator).toBeVisible()` / `.toBeHidden()`
- `expect(locator).toHaveText(value)` / `.toContainText(value)` (string or RegExp)
- `expect(locator).toHaveValue(value)` / `.toBeChecked()`
- `expect(locator).toBeEnabled()` / `.toBeDisabled()` (native `disabled`, a disabled fieldset, or `aria-disabled="true"`) / `.toBeEditable()` / `.toBeFocused()`
- `expect(locator).toHaveAttribute(name, value?)` / `.toHaveClass(value)` / `.toHaveId(value)`
- `expect(locator).toHaveCount(n)` / `.toBeAttached()`
- `expect(locator).toMatchAriaSnapshot(template)` / `expect(page).toMatchAriaSnapshot(template)`
- `expect(page).toHaveTitle(value)` / `.toHaveURL(value)`
- every matcher takes `{ timeout }` and negates with `.not`

## Tree snapshots

`toMatchAriaSnapshot` compares part of the page against a template of roles and names:

```ts
await expect(page.getByRole('main')).toMatchAriaSnapshot(`
  - heading "Settings" [level=1]
  - textbox "Work email"
  - checkbox "Send me news" [checked]
  - list:
    - listitem "Alpha"
    - listitem /bravo/i
`);
```

Template siblings must appear in that order, and a child can sit at any depth under its parent, so wrapper elements do not break a template. Nodes the template does not mention are ignored. A name in quotes matches the whole name; `/regex/flags` is tested as written; no name matches any. `[level=N]` and `[checked]` constrain headings and checkboxes. A form field is printed under its `<label>` text when it has one; in a template, either that text or the field's current value names it. `await locator.ariaSnapshot()` (or `page.ariaSnapshot()`) prints the current tree in this format, ready to paste in and trim.

## The page

- `page.goto(url)` navigates; relative URLs resolve against the `baseURL` option.
- `page.url()`, `page.title()`, and `page.evaluate(expr | fn)` read the page. `evaluate` returns the JSON-serialized result.
- `page.screenshot({ path, fullPage })` saves a PNG and returns its path.
- `page.mouse.move(x, y)`, `page.mouse.click(x, y)` and `page.mouse.drag(x1, y1, x2, y2)` send trusted pointer input at viewport coordinates, for canvas, maps, sliders and other surfaces with no accessibility tree. A drag also fires the HTML5 drag events, so native `draggable` lists see the drop.

## Logging in once

`page.saveAuth(name)` stores the page's cookies, local and session storage, and IndexedDB, encrypted by the daemon. `page.loadAuth(name)` restores them in a later run; `page.clearAuth(name)` deletes them. Storage is per origin, so load on a page of the same site, then navigate:

```ts
// once, after logging in through the UI
await page.saveAuth('staging-admin');

// every run after that
configure({ auth: { name: 'staging-admin', url: 'https://staging.example.com/' } });
```

With the `auth` option, every test's `page` starts logged in.

## Runner

The `test` export wraps node:test. Each test gets a fresh `page`; one browser session is shared across the file. `test.describe(name, fn)` groups tests, `test.beforeEach(fn)` and `test.afterEach(fn)` receive the same `{ page }`, and `test.only` / `test.skip` work as in node:test.

Options come from `testsurfer.config.ts` (or `.mts`, `.js`, `.mjs`) in the directory you run the tests from, and from `configure(options)` in a test file, which wins over the file:

```ts
// testsurfer.config.ts
import { defineConfig } from 'testsurfer';

export default defineConfig({ baseURL: 'http://localhost:3000', screenshot: 'only-on-failure' });
```

The options:

- `baseURL`: resolve relative `goto` URLs against it.
- `auth: { name, url }`: start every page logged in (see above).
- `screenshot: 'only-on-failure'` with `outputDir` (default `test-results`): save a PNG when a test fails and add its path to the error.
- `timeouts: { action, expect, navigation }`, in milliseconds.
- `inputMode`: `robotic` (default, instant), `careful`, or `human` (a humanized cursor path for flows that score input behavior).
- `testIdAttribute`: the attribute `getByTestId` reads, default `data-testid`.

Test files run in parallel: `node --test` gives each file its own process (one less than the CPU count at a time; set it with `--test-concurrency=N`), and each process opens its own session on the shared daemon. Tests inside a file run one after another.

```ts
import { test, expect, configure } from 'testsurfer';

configure({ baseURL: 'http://localhost:3000', screenshot: 'only-on-failure' });

test.describe('todos', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('adds one', async ({ page }) => {
    await page.getByLabel('New todo').fill('Buy milk');
    await page.getByLabel('New todo').press('Enter');
    await expect(page.getByRole('listitem')).toHaveCount(1);
  });
});
```

Runner integration is optional. Under vitest or any other runner, use `Browser.launch()` directly:

```ts
import { Browser, expect } from 'testsurfer';

const browser = await Browser.launch();
const page = browser.newPage();
await page.goto('https://example.com');
await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible();
await browser.close();
```

## Status

Version 0.1 pins vibesurfer 0.2.14 and speaks its frozen wire protocol (v1). Older daemons work for everything except `level`, `checked` and `<label>` lookups, which need the tree attributes 0.2.12 added. Known issue: on some macOS 27 machines each WebKit navigation stalls for about ten seconds inside the engine, which makes suites much slower than the benchmark below; it is tracked in the vibesurfer repo.

Not supported yet, so a suite that relies on these will not run unchanged: request mocking (`page.route`), frames (`frameLocator`), CSS that pierces shadow roots, `toHaveScreenshot`, page events (`page.on`), multiple pages or contexts per test, parallel tests inside one file, and Windows runners.

## Benchmark

[`bench/`](bench) runs identical flows through testsurfer and Playwright (WebKit and Chromium) against the same app and reports the numbers, favorable and not. On GitHub runners with vibesurfer 0.2.14, testsurfer launches in 3-11ms against Playwright's 0.4-1.3s. The four-flow suite takes 702-968ms on macOS against 561-627ms for Playwright-WebKit and 416-483ms for Playwright-Chromium, and 842-873ms on Linux against 549-664ms and 368-408ms. A working install is ~6MB against ~300MB+ per Playwright browser. The full tables, methodology and history are in the bench README; the `bench` workflow reproduces them.

## Example

[`examples/todo`](examples/todo) is a small todo app with a complete e2e suite: locators by role and label, polling assertions, and the `{ page }` fixture. It installs testsurfer as a package dependency, so it also exercises the published module shape.

## Development

```sh
npm install
npm run test:unit   # protocol and locator tests, no daemon needed
npm run test:e2e    # drives a real page through a local daemon
npm run build
```
