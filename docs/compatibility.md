# Compatibility and evidence

## Versions

This version pins vibesurfer 0.2.18 and speaks its frozen wire protocol (v1). Popups, dialogs and cross-origin frames on Linux and Windows need 0.2.18; isolated contexts, the proxy network mode, routed main documents and, on macOS, popups, dialogs and cross-origin frames need 0.2.16; routes, page events, `addInitScript` and same-origin frames need 0.2.15; `level`, `checked` and `<label>` lookups need 0.2.12; the rest works with older daemons.

Known issue: on some macOS 27 machines each WebKit navigation stalls for about ten seconds inside the engine, which makes suites much slower. It is tracked in the vibesurfer repo.

## Differences from Playwright

A suite that relies on these will not run unchanged:

- Without `network: 'proxy'`, `page.route` and network events cover `fetch`, XHR and routed main documents only (see [Network](network.md)).
- On macOS, WebKit never sends requests for `localhost` or `127.0.0.1` through a proxy, so routing images, scripts or stylesheets there does not work in either mode; serve the app under a name like `app.localhost`. A routed main document works on any host.
- `page.request` sends requests from the test process, so it does not share the page's cookies.
- Popups and dialogs need `network: 'proxy'`.
- `toHaveScreenshot` compares against baselines recorded by testsurfer; Playwright's baselines come from different engines and will not match.
- `page.emulateMedia` covers `matchMedia` and readable `@media` rules only. `mouse.wheel` is not a trusted event.
- Worker-scoped fixtures in `test.extend` are set up per test.
- A response a service worker builds itself, without a network request, is not reported.

## Evidence

- **Playwright's own specs.** [`compat/`](../compat) runs Playwright's page specs against testsurfer, unmodified except for the import of their fixtures. 488 of 488 pass; [`compat/RESULTS.md`](../compat/RESULTS.md) has the breakdown.
- **Lab.** [`lab/`](../lab) is a set of small fixture pages, one hard case each (locators, actions, assertions, dynamic pages, frames, shadow DOM, popups, network, keyboard, dialogs, pointer input), with tests written against `@playwright/test`. The same files run on Playwright's WebKit and on testsurfer: 84 of 84 on both. [`lab/RESULTS.md`](../lab/RESULTS.md) has wall time and install size; `node lab/run.mjs` reproduces it.
- **An open-source suite, unedited.** docsify's 105 end-to-end tests pass 99 on testsurfer and 104 on Playwright's WebKit, in 123 s against 25 s. All six testsurfer failures route subresources on `127.0.0.1` (above). [`bench/OSS.md`](../bench/OSS.md) has details and how to reproduce.
- **Benchmark.** [`bench/`](../bench) runs identical flows through testsurfer and Playwright (WebKit and Chromium) against the same app. On GitHub runners with vibesurfer 0.2.18 the four-flow suite takes 405 ms on macOS against 576 ms for Playwright WebKit and 445 ms for Playwright Chromium, and 364 ms on Linux against 600 ms and 365 ms. Against a running daemon testsurfer launches in 1-11 ms; Playwright takes 0.4-1.3 s. Tables, method and history are in the bench README.
