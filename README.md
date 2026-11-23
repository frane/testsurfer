# testsurfer

End-to-end testing for the web, driven by [vibesurfer](https://github.com/frane/vibesurfer).

testsurfer is lightweight. It drives the browser engine already on your machine through vibesurfer, a small native binary. Nothing bundles Chromium or Firefox or WebKit; you add one small dependency and get a real WebKit engine with fast cold starts and cheap CI.

The API is Playwright's: `test`, fixtures, locators, web-first assertions, routes. Because the engine is a plain OS webview, no automation protocol is attached to the page: no WebDriver, no CDP, and `navigator.webdriver` is `undefined`.

```ts
import { test, expect } from 'testsurfer';

test('login', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.getByRole('textbox', { name: 'Email' }).fill('a@b.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
```

Install it and run:

```sh
npm install -D testsurfer
npx testsurfer test            # or: node --test tests/
```

`testsurfer test` runs an existing Playwright suite without edits: imports of `@playwright/test` resolve to testsurfer, and extensionless imports (`../fixtures`) resolve as Playwright's runner resolves them. It takes paths, `--grep`, `--workers` and `--update-snapshots`; with no paths it runs the `testDir` from `playwright.config.*`, else `./tests`. Node 22.18 or newer runs `.ts` test files directly.

From a `playwright.config.*` it takes `use.baseURL`, `use.testIdAttribute`, `use.viewport`, `use.actionTimeout` and `navigationTimeout`, `expect.timeout`, `outputDir` and the snapshot paths, with a WebKit project's `use` applied over the top level. It starts each `webServer` (or reuses one with `reuseExistingServer`), runs `globalSetup` before the tests and `globalTeardown` after, and passes environment variables the config or setup set on to the tests, as Playwright does. A `testsurfer.config.*` next to it overrides those options.

## How it works

vibesurfer is a daemon that owns one real WebKit engine and speaks a line protocol over a Unix socket. testsurfer is a TypeScript client for that protocol. Locators resolve inside the page, in one evaluate per call, with Playwright's semantics: CSS that pierces open shadow roots, text, role and label queries, strict mode, actionability checks. vibesurfer supplies trusted native input, screenshots, navigation and the accessibility tree behind `toMatchAriaSnapshot`.

The daemon is fetched automatically. If `vs` is not on your PATH, testsurfer runs `npx vibesurfer@0.2.17` (pinned, checksum-verified) to download and start it. Set `TESTSURFER_VS` to point at a specific binary. testsurfer reads the daemon's protocol version and feature flags at launch and uses what it offers, so a newer `vs` on your PATH works too.

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
      - run: node --test tests/
```

`vibesurfer-version` overrides the pinned daemon. This repo's own CI runs the same action on all three.

## API

Locators resolve lazily at action time, against a fresh view:

- `page.getByRole(role, { name, exact, level, checked, disabled, expanded, pressed, selected, includeHidden })` matches ARIA roles, explicit or implicit (`button`, `textbox`, `heading`, `link`, ...), by accessible name. Name matching is substring and case-insensitive by default; `exact: true` makes it whole-string and case-sensitive. RegExp names are supported.
- `page.getByText(text, { exact })` matches visible text, substring and case-insensitive by default.
- `page.getByLabel(text, { exact })` matches form fields by their `<label>` (for, wrapping, or `aria-labelledby`) or `aria-label`.
- `page.getByTestId(id)` matches `data-testid` exactly (string or RegExp). The `testIdAttribute` option changes the attribute.
- `page.getByPlaceholder(text)`, `page.getByAltText(text)` and `page.getByTitle(text)` match those attributes, substring and case-insensitive by default, whole-string with `{ exact: true }`.
- `page.locator(selector, { hasText, has })` takes Playwright selectors: CSS (searching open shadow roots, with `:has-text()`, `:text()`, `:text-is()`, `:text-matches()` and `:visible` anywhere), `xpath=` or `//...`, `text=`, `role=button[name="OK"]`, `id=`, `data-testid=`, `nth=`, `visible=`, and `>>` chains.
- `page.frameLocator(selector)` or `locator.contentFrame()` searches inside an iframe; plain locators stay in their own frame, as in Playwright. A cross-origin iframe is searched through vibesurfer, which evaluates inside it directly (macOS; on Linux and Windows only same-origin iframes are reachable).
- Every `getBy*` and `locator()` also exists on a locator and searches inside its matches: `page.getByTestId('cart').getByRole('button', { name: 'Remove' })`.
- `.filter({ hasText, hasNotText, has, hasNot, visible })` narrows matches; `has` and `hasNot` take a locator searched inside each match.
- `.and(locator)` keeps elements matching both, `.or(locator)` takes either.
- `.first()`, `.last()` and `.nth(i)` pick one match when several qualify, and `all()` returns one locator per match. Otherwise a locator that matches more than one element fails the action, like Playwright's strict mode.

Actions wait until their element is attached, visible, enabled and not covered by another element, then act: `click()` (trusted native click; `button`, `modifiers`, `clickCount` and `position` options), `dblclick()`, `hover()`, `fill(value)`, `clear()`, `pressSequentially(text)` / `type(text)` (trusted native keystrokes, for rich-text editors), `press(key)`, `check()`, `uncheck()`, `setChecked()`, `selectOption()`, `setInputFiles()`, `focus()`, `blur()`, `dispatchEvent()`, `scrollIntoViewIfNeeded()`, `selectText()`, `dragTo(locator)`, `waitFor({ state })`. Reads: `textContent()`, `innerText()`, `innerHTML()`, `inputValue()`, `getAttribute(name)`, `isChecked()`, `isVisible()`, `isHidden()`, `isEnabled()`, `isDisabled()`, `isEditable()`, `boundingBox()`, `count()`, `all()`, `allTextContents()`, `allInnerTexts()`, `evaluate(fn, arg)`, `evaluateAll(fn, arg)`, `screenshot()`, `ariaSnapshot()`, `elementHandle()`. Element handles (`page.$`, `page.$$`, `elementHandle()`) are locators pinned to one element, so every locator method works on them.

Clicks and keystrokes dispatch as native OS input. The cadence is configurable per browser: the default `inputMode: 'robotic'` is instant, which is what tests want; `'human'` moves the cursor along a humanized path with realistic timing for flows that score input behavior.

Assertions poll until they pass or time out, and fail with Playwright's message layout:

- `expect(locator).toBeVisible()` / `.toBeHidden()` / `.toBeAttached()` / `.toBeInViewport({ ratio })`
- `expect(locator).toHaveText(value)` / `.toContainText(value)` (string, RegExp or an array for several matches; `ignoreCase`, `useInnerText`)
- `expect(locator).toHaveValue(value)` / `.toHaveValues(values)` / `.toBeChecked({ checked, indeterminate })` / `.toBeEmpty()`
- `expect(locator).toBeEnabled()` / `.toBeDisabled()` / `.toBeEditable()` / `.toBeFocused()`
- `expect(locator).toHaveAttribute(name, value?)` / `.toHaveClass(value)` / `.toContainClass(value)` / `.toHaveId(value)` / `.toHaveCSS(name, value)` / `.toHaveJSProperty(name, value)`
- `expect(locator).toHaveRole(role)` / `.toHaveAccessibleName(name)` / `.toHaveAccessibleDescription(text)`
- `expect(locator).toHaveCount(n)`
- `expect(response).toBeOK()`, and the generic matchers (`toBe`, `toEqual`, `toMatchObject`, `toThrow`, ...), `expect.poll`, `expect.soft` and `expect.configure`
- `expect(locator).toHaveScreenshot(name?, { threshold, maxDiffPixels, maxDiffPixelRatio })` / `expect(page).toHaveScreenshot(...)` compare against a baseline PNG stored next to the test file, in `<file>-snapshots/<name>-<os>.png`. A missing baseline is written and fails the test once; a mismatch writes the actual image and a diff to `outputDir`. `TESTSURFER_UPDATE_SNAPSHOTS=1` rewrites baselines.
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

- A new page starts at `about:blank`. `page.goto(url)` navigates and returns the main document's response (status, headers, body); relative URLs resolve against the `baseURL` option. `page.setContent(html)` and `page.content()` set and read the document.
- `page.evaluate(fn, arg)` runs in the page and awaits promises; values round-trip with their types (`undefined`, `Date`, `RegExp`, `Map`, `Set`, `BigInt`, ...), and handles can be passed in. `page.evaluateHandle`, `page.$eval`, `page.$$eval`, `page.waitForFunction` and `page.exposeFunction` / `exposeBinding` work as in Playwright.
- `page.screenshot({ path, fullPage, clip })` returns the PNG and writes it to `path` when given. The viewport is 1280x720 by default; `page.setViewportSize()` changes it.
- `page.keyboard.press(key)`, `down`, `up`, `insertText` and `type`, with the browser's default actions (Enter submits a form, Tab moves focus, Backspace deletes).
- `page.mainFrame()`, `page.frames()` and `page.frame(name)` reach iframes, with `evaluate` running in the frame's own window (cross-origin ones on macOS).
- `page.click(selector)`, `page.fill(selector, value)` and the rest of the selector shorthands, `page.waitForSelector`, `page.waitForNavigation`, `page.addLocatorHandler`.
- `page.mouse.move(x, y)`, `page.mouse.click(x, y)`, `page.mouse.down()` / `up()` and `page.mouse.drag(x1, y1, x2, y2)` send trusted pointer input at viewport coordinates, for canvas, maps, sliders and other surfaces with no accessibility tree. A drag also fires the HTML5 drag events, so native `draggable` lists see the drop.
- `page.reload()`, `page.goBack()`, `page.goForward()`, `page.waitForURL(url)`, `page.waitForTimeout(ms)`.
- `page.addInitScript(fn | string | { path }, arg)` runs a script at document start in every later document, before the page's own scripts. The page's Content Security Policy does not block it.

## Network and events

`page.route(url, handler, { times })` intercepts `fetch` and `XMLHttpRequest` requests whose URL matches a glob (`**/api/*`), a RegExp or a predicate. The handler gets a route:

```ts
await page.route('**/api/items', (route) => route.fulfill({ json: { items: ['mocked'] } }));
await page.route('**/api/items', async (route) => {
  const res = await route.fetch();
  await route.fulfill({ response: res, json: { ...(await res.json()), extra: true } });
});
await page.route('**/analytics/**', (route) => route.abort());
```

`fulfill({ status, headers, contentType, body, json, path, response })`, `continue({ url, method, headers, postData })`, `abort()`, `fallback()` (the next matching handler decides) and `fetch()` work as in Playwright. Routes added later win. Register routes before `goto` to catch requests made while the page loads; routes added afterwards apply from then on. `page.unroute(url)` and `page.unrouteAll()` remove them, and `context.route()` covers every page in a context.

`page.on(event, listener)` (and `once`, `off`) reports `console` (`msg.type()`, `msg.text()`), `pageerror`, `request`, `response`, `requestfinished` and `requestfailed`. `page.waitForRequest(url)`, `page.waitForResponse(url)` and `page.waitForEvent(name, predicate)` wait for one.

By default both work through a script testsurfer installs in the page, so they see what page script does: `fetch`, `XMLHttpRequest`, `console`, uncaught errors. While a page has routes, each `fetch` and XHR waits a poll interval (15ms) for the handler's decision.

With `configure({ network: 'proxy' })` every request goes through vibesurfer's intercepting proxy instead (vibesurfer 0.2.16+), http and https: documents, iframes, scripts, stylesheets, images, fetch and XHR, each redirect hop on its own. All of them are reported and routable, `page.goto` returns the real response, `setExtraHTTPHeaders` reaches every request, and `context.addCookies` sets cookies in the context's jar. Popups open as their own pages (`page.on('popup')`, `context.on('page')`, `page.opener()`, `close` when they call `window.close()`), `page.on('dialog')` gets `alert`, `confirm` and `prompt` to accept or dismiss (with no listener they are dismissed, as in Playwright), and a response a service worker handed on reports `fromServiceWorker()`. Two limits: on macOS, WebKit sends requests to `localhost` and `127.0.0.1` around any proxy, so serve the app under a `.localhost` name (`http://app.localhost:3000`), which resolves to the same loopback address; and popups and dialogs are macOS only: other platforms load popups in the page that opened them and dismiss dialogs.

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

The `test` export wraps node:test with Playwright's test API. Each test gets fresh `page` and `context` fixtures plus the shared `browser`; one browser session is shared across the file.

- `test.describe(name, fn)` groups tests; `.only`, `.skip`, `.parallel` and `.serial` variants exist.
- `test.beforeEach` / `test.afterEach` get the test's fixtures; `test.beforeAll` / `test.afterAll` get `{ browser }`.
- `test.only`, `test.skip(name, fn)` and `test.fixme(name, fn)` register; `test.skip(condition, reason)` inside a test skips it there.
- `test.step(name, fn)` runs a named part of a test and puts the name in its errors.
- `test.extend({ ... })` adds fixtures: a value, `[value, { option: true }]`, or a setup function that receives the other fixtures and calls `use(value)`, with teardown after `use` returns.
- `context.newPage()` opens more pages in a test; `browser.newContext()` opens another context with its own cookie and storage jar. Each test gets a fresh context, as in Playwright; `isolate: false` runs a file's tests in one shared jar instead. `context.on('page')`, `context.on('request')` and `context.waitForEvent(name)` report what the context's pages do (proxy mode).

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
- `updateSnapshots`: `missing` (default), `all` or `none`, for `toHaveScreenshot` baselines. `TESTSURFER_UPDATE_SNAPSHOTS=1` means `all`.
- `network`: `shim` (default) or `proxy` (see Network and events).
- `isolate`: `true` (default) gives every test its own context and jar; `false` shares the browser's session.

Test files run in parallel: `node --test` gives each file its own process (one less than the CPU count at a time; set it with `--test-concurrency=N`), and each process opens its own session on the shared daemon. Inside a file, tests run one after another unless a describe block calls `test.describe.configure({ mode: 'parallel' })` (or is `test.describe.parallel`); then its tests run at the same time, each with its own page.

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

This version pins vibesurfer 0.2.17 and speaks its frozen wire protocol (v1). Isolated contexts, the proxy network mode, popups, dialogs, cross-origin frames and routed main documents need 0.2.16; routes, page events, `addInitScript` and same-origin frames need 0.2.15; `level`, `checked` and `<label>` lookups need 0.2.12; the rest works with older daemons. Known issue: on some macOS 27 machines each WebKit navigation stalls for about ten seconds inside the engine, which makes suites much slower than the benchmark below; it is tracked in the vibesurfer repo.

[`compat/`](compat) runs Playwright's own page specs against testsurfer, unmodified except for the import of their fixtures; [`compat/RESULTS.md`](compat/RESULTS.md) has the current numbers.

Differences from Playwright, so a suite that relies on these will not run unchanged:

- Without `network: 'proxy'`, `page.route` and network events cover `fetch` and XHR only (see Network and events).
- `page.request` sends requests from the test process, so it does not share the page's cookies.
- On macOS, WebKit never sends requests for `localhost` or `127.0.0.1` through a proxy, so routing images, scripts or stylesheets there does not work in either mode; serve the app under a name like `app.localhost`. A routed main document works on any host.
- Popups, dialogs and cross-origin iframes are macOS only, and popups and dialogs need `network: 'proxy'` (see above).
- `toHaveScreenshot` compares against baselines recorded by testsurfer; Playwright's baselines come from different engines and will not match.
- `page.emulateMedia` rewrites `matchMedia` and the page's readable `@media` rules; `media` attributes on `<link>` and cross-origin stylesheets do not follow. `mouse.wheel` dispatches an untrusted wheel event and scrolls.
- Worker-scoped fixtures in `test.extend` are set up per test.
- A response a service worker builds itself, without a network request, is not reported.

## Lab

[`lab/`](lab) is a set of small fixture pages, one hard case each (locators, actions, assertions, dynamic pages, frames, shadow DOM, popups, network, keyboard, dialogs, pointer input), with tests written against `@playwright/test`. The same files run on Playwright's WebKit and on testsurfer; [`lab/RESULTS.md`](lab/RESULTS.md) has both side by side, with wall time and install size. `node lab/run.mjs` reproduces it.

An open-source suite, unedited: docsify's 105 end-to-end tests pass 99 on testsurfer and 104 on Playwright's WebKit, in 123 s against 25 s, from a 10.4 MB install against 308 MB. All six testsurfer failures route subresources on `127.0.0.1` (above). Details and how to reproduce: [`bench/OSS.md`](bench/OSS.md).

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
