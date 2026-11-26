# Compatibility and evidence

## Versions

This version pins vibesurfer 0.2.21 and speaks its frozen wire protocol (v1). Native wheel input, native drops (`locator.drop`), WebM videos, the cookie jar API, right, middle, double and modified clicks, page zoom (`isMobile`), `ignoreHTTPSErrors`, crash events and interception of pages served from `localhost` or `127.0.0.1` on macOS need 0.2.19 (0.2.20 fixes WebSockets in proxy mode on Linux and loopback cookies on macOS before 26; 0.2.21 fixes parallel cold starts and dropped strings under load); popups, dialogs and cross-origin frames on Linux and Windows need 0.2.18; isolated contexts and the proxy network mode need 0.2.16; routes, page events, `addInitScript` and same-origin frames need 0.2.15. testsurfer reads the daemon's capability flags and uses what it offers.

Known issue: on some macOS 27 machines each WebKit navigation stalls for about ten seconds inside the engine, which makes suites much slower. It is tracked in the vibesurfer repo.

## What runs

testsurfer implements Playwright's test API and its library API for the browser it drives:

- **Runner:** `test`, `describe` and their modifiers, hooks, fixtures (`test.extend`, worker scope, `test.use`), projects (`testMatch`, `testIgnore`, `testDir`, `dependencies`, `--project`), test timeouts, `webServer`, `globalSetup` and `globalTeardown`.
- **Pages and contexts:** navigation, locators, actions and assertions, frames, popups, dialogs, downloads, file choosers, workers, WebSockets (`routeWebSocket` too), `page.clock`, `page.screencast`, `exposeFunction` and `exposeBinding`, init scripts, crash events.
- **Network:** `page.route` and `context.route` for every request (documents, scripts, styles, images, fetch, XHR) on any host, network events, `routeFromHAR`, `recordHar`, `page.request` and `request.newContext()` with cookies shared as in Playwright.
- **Context options:** `storageState`, `colorScheme`, `reducedMotion`, `forcedColors`, `contrast`, `locale`, `timezoneId`, `userAgent`, `extraHTTPHeaders`, `httpCredentials`, `geolocation`, `permissions`, `offline`, `javaScriptEnabled`, `isMobile`, `hasTouch`, `bypassCSP`, `serviceWorkers`, `ignoreHTTPSErrors`, `recordVideo`, `recordHar`, and Playwright's device list.
- **Library API:** `webkit`, `chromium` and `firefox` browser types (`launch`, `connect`, `launchPersistentContext` keeping cookies and storage in its directory), `browser.bind`, `request.newContext()`.
- **Tooling:** `context.tracing` writes traces Playwright's trace viewer opens (actions, assertions, DOM snapshots, screenshots, network, console).

Every page renders in the OS web view (WKWebView, WebKitGTK, WebView2), so a project configured for `chromium` or `firefox` runs on that engine too. APIs Playwright offers on Chromium only (`page.pdf`, `page.coverage`, CDP sessions) throw as they do on Playwright's WebKit. `toHaveScreenshot` keeps its own baselines, as Playwright keeps one per browser.

## Evidence

- **Playwright's own specs.** [`compat/`](../compat) runs Playwright's page specs against testsurfer, unmodified except for the import of their fixtures. 488 of 488 pass; [`compat/RESULTS.md`](../compat/RESULTS.md) has the breakdown.
- **Lab.** [`lab/`](../lab) is a set of small fixture pages, one hard case each (locators, actions, assertions, dynamic pages, frames, shadow DOM, popups, network, keyboard, dialogs, pointer input, cookies and storage, context options, clock, WebSockets, workers, HAR, video, tracing, file choosers), with tests written against `@playwright/test`. The same files run on Playwright's WebKit and on testsurfer: 120 of 120 on both. [`lab/RESULTS.md`](../lab/RESULTS.md) has wall time and install size; `node lab/run.mjs` reproduces it.
- **An open-source suite, unedited.** docsify's 105 end-to-end tests pass 105 on testsurfer and 105 on Playwright's WebKit, in 21 s against 22 s. [`bench/OSS.md`](../bench/OSS.md) has details and how to reproduce.
- **Benchmark.** [`bench/`](../bench) runs identical flows through testsurfer and Playwright (WebKit and Chromium) against the same app. On GitHub runners with vibesurfer 0.2.21 the four-flow suite takes 534 ms on macOS against 790 ms for Playwright WebKit and 590 ms for Playwright Chromium, and 336 ms on Linux against 480 ms and 379 ms. Against a running daemon testsurfer launches in 1-11 ms; Playwright takes 0.4-2 s. The 122-case lab passes 122 of 122 on testsurfer on both runners. Tables, method and history are in the bench README.
