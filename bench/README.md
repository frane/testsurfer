# testsurfer vs Playwright benchmark

Identical flows against the same local todo app (`examples/todo`), driven through each tool's locator API. One shared scenario body runs on all targets, so no tool gets friendlier code. Playwright runs WebKit for engine parity with vibesurfer and Chromium as its common default.

Run it:

```sh
npm install
npx playwright install webkit chromium
npm run bench
```

## Results

macOS 26.3 arm64, vibesurfer daemon 0.1.27, playwright 1.61.1, 2026-07-24. Median of 5 iterations, fresh page per iteration, steady state (browser binaries installed, daemon running).

| scenario           | testsurfer | playwright-webkit | playwright-chromium |
| ------------------ | ---------- | ----------------- | ------------------- |
| launch             | 6ms        | 283ms             | 270ms               |
| first paint        | 100ms      | 29ms              | 20ms                |
| add two todos      | 840ms      | 101ms             | 82ms                |
| complete and clear | 1396ms     | 162ms             | 113ms               |
| delete a todo      | 791ms      | 94ms              | 76ms                |
| suite total        | 3127ms     | 386ms             | 291ms               |

Disk footprint for a working install:

| | package | browser | total |
| - | - | - | - |
| testsurfer | 192KB, zero runtime deps | 6.2MB `vs` binary (drives the OS webview) | ~6.4MB |
| playwright + webkit | 17MB | 291MB | ~308MB |
| playwright + chromium | 17MB | 344MB | ~361MB |

Playwright's very first WebKit launch on a fresh machine also paid an 8.7s one-time cost (macOS verifying the downloaded binary); steady state is the 283ms shown. The vibesurfer daemon's own one-time spawn is not measured here because this machine keeps it running; it is amortized across every run and every tool on the machine.

## Honest reading

Playwright is roughly 8x faster per scenario once its browser is up. That is structural today: Playwright drives the browser over a wire protocol with cheap per-action calls, while every vibesurfer mutation takes a full accessibility snapshot on the engine main thread, dispatches input through native OS events, and writes an audit row. Two upstream fixes already agreed with the vibesurfer maintainer (a fast mode for `vs_act` click, and act returning its tree delta instead of discarding it) will narrow this, but a CDP-style call will stay cheaper than a snapshot for the foreseeable future.

testsurfer wins where the weight is: a working install is about 50x smaller than Playwright with one browser, there is nothing to download in CI beyond a 6MB binary, and launching against the resident daemon is effectively free.

So: pick testsurfer when install size, CI weight, cold start, semantic locators, or the no-automation-surface engine matter more than raw action throughput. Pick Playwright when suite wall-time dominates and hundreds of megabytes of browser binaries are fine. Claims on the main README are backed by this table, not the other way around.
