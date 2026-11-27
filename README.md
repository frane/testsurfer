# testsurfer

**Your Playwright tests on a 10 MB install instead of 300 MB.**

testsurfer runs end-to-end tests with Playwright's API on the WebKit engine your OS already ships. There is no browser download: `npm install` and you are testing.

```sh
npm install -D testsurfer
npx testsurfer test
```

That command runs an existing Playwright suite as it is. `@playwright/test` imports resolve to testsurfer, and `playwright.config.*` is read, including `webServer`, `globalSetup` and `baseURL`.

## Write a test

```ts
import { test, expect } from 'testsurfer';

test('sign in', async ({ page }) => {
  await page.goto('https://example.com/login');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
```

Locators, auto-waiting, web-first assertions, fixtures, projects, routes, HAR, WebSockets, the clock, traces, videos and aria snapshots all work as you know them from Playwright.

## Why testsurfer

- **Small and fast to install.** One npm package plus a few-MB native daemon, fetched and checksum-verified on first run. CI caches stay small and cold starts take milliseconds.
- **The engine your users have.** Pages render in the OS web view: WKWebView (Safari's engine) on macOS, WebKitGTK on Linux, WebView2 on Windows.
- **Real input.** Clicks and keystrokes are native OS events, so `isTrusted` is true and rich-text editors, canvas apps and drag-and-drop behave as they do for users.
- **No automation protocol.** No WebDriver, no DevTools protocol, and `navigator.webdriver` is `undefined`, so flows behind bot checks stay testable.

## Use cases

- Run your Playwright suite in CI without downloading browsers.
- Add end-to-end tests to a project that never had room for 300 MB of browsers.
- Test sign-up, checkout and login flows that block automated browsers.
- Check your app in Safari's engine on a Mac without extra setup.

## Compared to Playwright

| | testsurfer | Playwright |
|---|---|---|
| Install | ~10 MB | ~300 MB per browser |
| Browser download | none | required |
| Launch | 3-11 ms | 0.4-2 s |
| Engines | the OS web view | bundled Chromium, Firefox, WebKit |
| Input | native OS events | events sent over a browser protocol |
| `navigator.webdriver` | `undefined` | `true` |
| API | Playwright's | Playwright's |
| Bench suite (CI runners) | 443-548 ms | 634-764 ms (WebKit) |

Playwright's own page specs pass 488 of 488 on testsurfer. An unedited open-source suite (docsify, 105 tests) passes 105 of 105, as on Playwright's WebKit. Numbers and how to reproduce them: [compatibility and evidence](docs/compatibility.md).

## CI

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
- run: npm ci
- uses: frane/testsurfer@v0   # installs what the OS lacks, starts the daemon
- run: npx testsurfer test
```

macOS, Linux and Windows runners are supported.

## Documentation

- [Running tests](docs/running.md): the CLI, Playwright configs, the runner, options, CI, how it works
- [API](docs/api.md): locators, actions, assertions, aria snapshots, the page, saved logins
- [Network](docs/network.md): routes, events, WebSockets, HAR, popups and dialogs
- [Compatibility and evidence](docs/compatibility.md): differences from Playwright, test results, benchmarks
- [Example project](examples/todo): a small app with a complete suite
- [For AI agents](skills/testsurfer/SKILL.md): a skill file shipped in the package; copy `node_modules/testsurfer/skills/testsurfer` into your agent's skills folder (`.claude/skills/` for Claude Code)

testsurfer is built on [vibesurfer](https://github.com/frane/vibesurfer). Apache-2.0.
