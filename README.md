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

The daemon is fetched automatically. If `vs` is not on your PATH, testsurfer runs `npx vibesurfer@0.2.12` (pinned, checksum-verified) to download and start it. Set `TESTSURFER_VS` to point at a specific binary. testsurfer reads the daemon's protocol version and feature flags at launch and uses what it offers, so a newer `vs` on your PATH works too.

## API

Locators resolve lazily at action time, against a fresh view:

- `page.getByRole(role, { name, exact, level })` matches ARIA roles (`button`, `textbox`, `heading`, `link`, ...). Name matching is whole-string and case-insensitive by default; `exact: true` makes it case-sensitive. RegExp names are supported.
- `page.getByText(text, { exact })` matches visible text, substring and case-insensitive by default.
- `page.getByLabel(text, { exact })` matches form fields by their `<label>` (for, wrapping, or `aria-labelledby`) or `aria-label`.
- `.first()` and `.nth(i)` pick one match when several qualify. Otherwise a locator that matches more than one element fails the action, like Playwright's strict mode.

Actions auto-wait for their element and retry when the page changes underneath them: `click()`, `fill(value)`, `type(text)` (trusted native keystrokes, for rich-text editors), `press(key)`, `hover()`, `focus()`, `check()`, `uncheck()`, `dragTo(locator)`. Reads: `textContent()`, `inputValue()`, `isChecked()`, `isVisible()`, `boundingBox()`, `count()`, `ariaSnapshot()`.

Clicks and keystrokes dispatch as native OS input. The cadence is configurable per browser: the default `inputMode: 'robotic'` is instant, which is what tests want; `'human'` moves the cursor along a humanized path with realistic timing for flows that score input behavior.

Assertions poll until they pass or time out:

- `expect(locator).toBeVisible()` / `.toBeHidden()`
- `expect(locator).toHaveText(value)` / `.toContainText(value)` (string or RegExp)
- `expect(locator).toHaveValue(value)` / `.toBeChecked()`
- `expect(locator).toHaveCount(n)`
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

`configure(options)` sets the shared browser up before the first test runs:

- `baseURL`: resolve relative `goto` URLs against it.
- `auth: { name, url }`: start every page logged in (see above).
- `screenshot: 'only-on-failure'` with `outputDir` (default `test-results`): save a PNG when a test fails and add its path to the error.
- `timeouts: { action, expect, navigation }`, in milliseconds.
- `inputMode`: `robotic` (default, instant), `careful`, or `human` (a humanized cursor path for flows that score input behavior).

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

Version 0.1 pins vibesurfer 0.2.12 and speaks its frozen wire protocol (v1). Older daemons work for everything except `level`, `checked` and `<label>` lookups, which need the tree attributes 0.2.12 added. Known issue: on some macOS 27 machines each WebKit navigation stalls for about ten seconds inside the engine, which makes suites much slower than the benchmark below; it is tracked in the vibesurfer repo.

## Benchmark

[`bench/`](bench) runs identical flows through testsurfer and Playwright (WebKit and Chromium) against the same app and reports the numbers, favorable and not. Summary from the July runs against vibesurfer 0.1.x: a working testsurfer install is ~6MB against ~300MB+ per Playwright browser and launches in single-digit milliseconds against the resident daemon, while Playwright is ~8x faster per action once its browser is running. The full table, methodology, and the reasons live in the bench README.

## Example

[`examples/todo`](examples/todo) is a small todo app with a complete e2e suite: locators by role and label, polling assertions, and the `{ page }` fixture. It installs testsurfer as a package dependency, so it also exercises the published module shape.

## Development

```sh
npm install
npm run test:unit   # protocol and locator tests, no daemon needed
npm run test:e2e    # drives a real page through a local daemon
npm run build
```
