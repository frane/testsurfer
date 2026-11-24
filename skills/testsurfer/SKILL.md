---
name: testsurfer
description: Write and run end-to-end tests with Playwright's API on the OS web view (WKWebView, WebKitGTK, WebView2), with no browser download. Use when a project uses testsurfer, or when adding browser tests to a project without Playwright's browsers.
---

# testsurfer

Playwright's test API on the OS web view. Same imports, locators and assertions; no browser download. A small native daemon (vibesurfer) is fetched on first run.

## Run

```sh
npm install -D testsurfer
npx testsurfer test                     # testDir from playwright.config.*, else ./tests
npx testsurfer test tests/login.spec.ts --grep "sign in"
npx testsurfer test -u                  # rewrite toHaveScreenshot baselines
```

An existing Playwright suite runs unedited: `@playwright/test` imports resolve to testsurfer, and `playwright.config.*` supplies `baseURL`, `webServer`, `globalSetup`, timeouts and snapshot paths. New tests import from `testsurfer`:

```ts
import { test, expect } from 'testsurfer';

test('sign in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
```

Write tests as for Playwright: role and label locators, web-first `expect`, no fixed sleeps.

## Platforms

- macOS: nothing to install.
- Linux: needs WebKitGTK 6 (`libwebkitgtk-6.0-4`) and an X display. Headless: `Xvfb :99 -screen 0 8016x5016x24 &` then `DISPLAY=:99`. Ubuntu 24.04 also needs `sysctl kernel.apparmor_restrict_unprivileged_userns=0`.
- Windows: the WebView2 runtime, present on Windows 10/11 and GitHub runners.
- GitHub Actions: `- uses: frane/testsurfer@v0` before `npx testsurfer test` sets all of this up.

## Debugging a failure

- The error names the call and what it waited for, e.g. `locator.click: Timeout 10000ms exceeded ... waiting for getByRole('button', { name: 'Save' })`.
- `screenshot: 'only-on-failure'` in `testsurfer.config.ts` saves a PNG to `test-results/` and puts its path in the error. Read the PNG.
- Daemon log: `~/.vibesurfer/daemon.log`.

## The engine

- Pages render in the OS web view (WKWebView, WebKitGTK, WebView2). Every project in `playwright.config` runs, each with its own `use`, `testMatch` and `dependencies`; one named `chromium` or `firefox` runs on that engine too.
- Every request goes through vibesurfer's proxy, on any host: routes, HAR, network events and `page.request` see everything.
- `toHaveScreenshot` keeps its own baselines, as Playwright keeps one per browser.

Full docs: https://github.com/frane/testsurfer/tree/main/docs
