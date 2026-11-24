# An open-source suite, unedited

[docsify](https://github.com/docsifyjs/docsify)'s end-to-end suite (`test/e2e`, 105 tests, `@playwright/test`), run as the project ships it: its `playwright.config.js`, global setup (a browser-sync server on `127.0.0.1:4000`) and helpers, no file changed. testsurfer reads the config and maps `@playwright/test` to itself; Playwright runs its `webkit` project.

docsify at `0e0cd50`, macOS 27 on Apple silicon, vibesurfer 0.2.19, Playwright 1.61.1 (WebKit build 2311), default worker counts, `--project=webkit` on both.

| | testsurfer | Playwright WebKit |
|---|---|---|
| passed | 105 / 105 | 105 / 105 |
| wall time | 21 s | 22 s |
| install | 10.7 MB | 308 MB (291 MB of it the WebKit build) |

On vibesurfer 0.2.16 testsurfer passed 99 in 123 s: the suite routes images and scripts on `127.0.0.1`, which WebKit on macOS sent around the intercepting proxy. vibesurfer 0.2.19 serves loopback pages through the proxy itself. Without `--project`, testsurfer runs all three of the suite's projects, as Playwright does (105 / 105 each).

Reproduce:

```sh
git clone https://github.com/docsifyjs/docsify && cd docsify && git checkout 0e0cd50
npm ci --ignore-scripts && npm run build
npx testsurfer test --project=webkit                 # testsurfer
npx playwright test --project=webkit                 # Playwright
```
