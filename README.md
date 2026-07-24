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

Run it with the built-in node:test wrapper:

```sh
node --test tests/
```

## How it works

vibesurfer is a daemon that owns one real WebKit engine and speaks a line protocol over a Unix socket. testsurfer is a TypeScript client for that protocol. It opens a session, resolves your locators against the live accessibility tree, and handles the daemon's optimistic-concurrency tokens internally. You never see a token, a ref, or a retry.

The daemon is fetched automatically. If `vs` is not on your PATH, testsurfer runs `npx vibesurfer@0.1.28` (pinned, checksum-verified) to download and start it. Set `TESTSURFER_VS` to point at a specific binary.

## API

Locators resolve lazily at action time, against a fresh view:

- `page.getByRole(role, { name, exact, level })` matches ARIA roles (`button`, `textbox`, `heading`, `link`, ...). Name matching is whole-string and case-insensitive by default; `exact: true` makes it case-sensitive. RegExp names are supported.
- `page.getByText(text, { exact })` matches visible text, substring and case-insensitive by default.
- `page.getByLabel(text, { exact })` matches form fields by accessible label.
- `.first()` and `.nth(i)` pick one match when several qualify. Otherwise a locator that matches more than one element fails the action, like Playwright's strict mode.

Actions auto-wait for their element and retry when the page changes underneath them: `click()`, `fill(value)`, `type(text)` (trusted native keystrokes, macOS today), `press(key)`, `hover()`, `focus()`, `textContent()`.

Clicks and keystrokes dispatch as native OS input. The cadence is configurable per browser: the default `inputMode: 'robotic'` is instant, which is what tests want; `'human'` moves the cursor along a humanized path with realistic timing for flows that score input behavior.

Assertions poll until they pass or time out:

- `expect(locator).toBeVisible()` / `.toBeHidden()`
- `expect(locator).toHaveText(value)` / `.toContainText(value)` (string or RegExp)
- `expect(locator).toHaveCount(n)`
- `expect(page).toHaveTitle(value)`
- every matcher takes `{ timeout }` and negates with `.not`

Runner integration is optional. The `test` export wraps node:test and provides the `{ page }` fixture. Under vitest or any other runner, use `Browser.launch()` directly:

```ts
import { Browser, expect } from 'testsurfer';

const browser = await Browser.launch();
const page = browser.newPage();
await page.goto('https://example.com');
await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible();
await browser.close();
```

## Status

Version 0.1 targets vibesurfer 0.1.28 as its wire contract. Locators, actions, and the assertion set above are implemented. Trusted-input coordinate actions, a11y-tree snapshot assertions, and session/auth fixtures are next.

## Example

[`examples/todo`](examples/todo) is a small todo app with a complete e2e suite: locators by role and label, polling assertions, and the `{ page }` fixture. It installs testsurfer as a package dependency, so it also exercises the published module shape.

## Development

```sh
npm install
npm run test:unit   # protocol and locator tests, no daemon needed
npm run test:e2e    # drives a real page through a local daemon
npm run build
```
