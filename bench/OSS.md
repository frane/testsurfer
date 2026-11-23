# An open-source suite, unedited

[docsify](https://github.com/docsifyjs/docsify)'s end-to-end suite (`test/e2e`, 105 tests, `@playwright/test`), run as the project ships it: its `playwright.config.js`, global setup (a browser-sync server on `127.0.0.1:4000`) and helpers, no file changed. testsurfer reads the config and maps `@playwright/test` to itself; Playwright runs its `webkit` project.

docsify at `0e0cd50`, macOS 27 on Apple silicon, vibesurfer 0.2.16, Playwright 1.61.1 (WebKit build 2311), default worker counts.

| | testsurfer | Playwright WebKit |
|---|---|---|
| passed | 99 / 105 (two runs) | 104 / 105 |
| wall time | 123 s | 25 s |
| install | 10.4 MB | 308 MB (291 MB of it the WebKit build) |

The six testsurfer failures share one cause. The tests route images and scripts (`page.route` with `route.fulfill`) on the suite's own server at `127.0.0.1`. WebKit on macOS never sends loopback requests through a proxy, so testsurfer's proxy mode cannot see them, and the default mode only sees fetch and XHR. A suite that serves from a name under `.localhost` does not hit this. Four of the six wait 30 s each for an image that never arrives, which accounts for most of the time gap.

The one Playwright failure is `does not pull back after user input following a fallback scroll`, a timing test.

What the run took to get here, all in testsurfer 0.3.0 / vibesurfer 0.2.16: a routed main document on any host (`vs goto --html`), `page.addScriptTag`, `page.addStyleTag`, `page.emulateMedia`, `mouse.wheel`, console message `args()`, `page.click(selector)` taking the first match as Playwright does, `waitForFunction` returning a handle, and test files exiting when their tests are done.

Reproduce:

```sh
git clone https://github.com/docsifyjs/docsify && cd docsify && git checkout 0e0cd50
npm ci --ignore-scripts && npm run build
npx testsurfer test                                  # testsurfer
npx playwright test --project=webkit                 # Playwright
```
