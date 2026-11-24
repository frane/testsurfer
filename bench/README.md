# testsurfer vs Playwright benchmark

Identical flows against the same local todo app (`examples/todo`), driven through each tool's locator API. One shared scenario body runs on all targets, so no tool gets friendlier code. Playwright runs WebKit for engine parity with vibesurfer and Chromium as its common default.

Run it:

```sh
npm install
npx playwright install webkit chromium
npm run bench
```

## Results

Current numbers come from the `bench` workflow (`.github/workflows/bench.yml`), run by hand on a clean GitHub runner so anyone can reproduce them.

Run [45259755466](https://github.com/frane/testsurfer/actions/runs/45259755466) on 2026-11-23, vibesurfer 0.2.18 (built from `de81230`), playwright 1.61.1. Median of 5 iterations, a fresh context and page per iteration. The workflow builds vibesurfer from source, which restarts the daemon, so testsurfer's launch row includes the daemon's start; against a running daemon a launch takes 1-11 ms.

GitHub `macos-15-arm64` runner:

| scenario           | testsurfer | playwright-webkit | playwright-chromium |
| ------------------ | ---------- | ----------------- | ------------------- |
| launch             | 365ms      | 1193ms            | 483ms               |
| first paint        | 49ms       | 65ms              | 27ms                |
| add two todos      | 100ms      | 140ms             | 108ms               |
| complete and clear | 162ms      | 242ms             | 198ms               |
| delete a todo      | 94ms       | 129ms             | 112ms               |
| suite total        | 405ms      | 576ms             | 445ms               |

GitHub `ubuntu-24.04` x86_64 runner (WebKitGTK 6 under Xvfb):

| scenario           | testsurfer | playwright-webkit | playwright-chromium |
| ------------------ | ---------- | ----------------- | ------------------- |
| launch             | 143ms      | 550ms             | 180ms               |
| first paint        | 54ms       | 42ms              | 28ms                |
| add two todos      | 102ms      | 183ms             | 90ms                |
| complete and clear | 126ms      | 213ms             | 157ms               |
| delete a todo      | 82ms       | 162ms             | 90ms                |
| suite total        | 364ms      | 600ms             | 365ms               |

testsurfer runs the suite in about two thirds of Playwright-WebKit's time on both runners, and level with Playwright-Chromium on Linux. In the same run the lab (84 cases, files in parallel) took 23.4 s for testsurfer against 44.7 s for Playwright-WebKit on macOS, and 19.8 s against 19.3 s on Linux.

What closed the gap since 0.2.14: macOS waits that ran in fixed 50 ms slices now end when due, Linux input settles in milliseconds instead of sleeping, routed requests no longer queue behind the event poll, each bench iteration gets an isolated context (the shared persistent store cost about a second per navigation on some machines), and on Linux the daemon serves other pages while a new page's web process starts.

### November 2026: vibesurfer 0.2.14

Two runs of the workflow on 2026-11-20, playwright 1.61.1. Runs [44693388662](https://github.com/frane/testsurfer/actions/runs/44693388662) and [44693736927](https://github.com/frane/testsurfer/actions/runs/44693736927).

GitHub `macos-15-arm64` runner, second run:

| scenario           | testsurfer | playwright-webkit | playwright-chromium |
| ------------------ | ---------- | ----------------- | ------------------- |
| launch             | 3ms        | 1327ms            | 381ms               |
| first paint        | 162ms      | 81ms              | 35ms                |
| add two todos      | 279ms      | 144ms             | 102ms               |
| complete and clear | 356ms      | 217ms             | 181ms               |
| delete a todo      | 171ms      | 119ms             | 98ms                |
| suite total        | 968ms      | 561ms             | 416ms               |

GitHub `ubuntu-24.04` x86_64 runner (WebKitGTK 6 under Xvfb), second run:

| scenario           | testsurfer | playwright-webkit | playwright-chromium |
| ------------------ | ---------- | ----------------- | ------------------- |
| launch             | 4ms        | 399ms             | 1096ms              |
| first paint        | 91ms       | 40ms              | 28ms                |
| add two todos      | 237ms      | 163ms             | 90ms                |
| complete and clear | 305ms      | 214ms             | 158ms               |
| delete a todo      | 209ms      | 132ms             | 92ms                |
| suite total        | 842ms      | 549ms             | 368ms               |

Across the two runs the suite took 702-968ms for testsurfer against 561-627ms for Playwright-WebKit on macOS, and 842-873ms against 549-664ms on Linux. testsurfer launches in milliseconds against a running daemon and is 1.1-1.7x slower than Playwright-WebKit on the flows themselves. First paint on the macOS runner varies most: 23ms in the first run, 162ms in the second, and within a run the first page is the slow one (193ms, then 22-27ms), which points at web-process startup rather than the actions.

On vibesurfer 0.2.13 the same workflow measured 1437ms for testsurfer on macOS, and on 0.2.12 4152ms: from 0.2.10 every click waited 250ms in case it had opened a new window, and 0.2.13 waits only when the page actually asked for one.

The tables below are the July history on a local Mac, kept for comparison.

### July 2026: vibesurfer 0.1.27

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

### July 2026: vibesurfer 0.2 branch preview

The engine fixes filed from this benchmark are landed on the vibesurfer 0.2 branch: act returns its delta inline, wait tokens valid, dirty-flag snapshot caching, robotic click fast path, console-error read folded into the snapshot hop, a 4ms serve-loop pump slice (every engine hop ~50ms to ~10ms), and vs_goto nav-in-place (~15ms vs ~90ms page open). testsurfer auto-negotiates all of it from the vs_status daemon line (proto=1, flags). Same machine, sandboxed 0.2 daemon built from `0d31740`, representative of three consecutive runs:

| scenario           | testsurfer @0.2 | (was @0.1.27) | playwright-webkit | playwright-chromium |
| ------------------ | --------------- | ------------- | ----------------- | ------------------- |
| launch             | 8ms             | 6ms           | 358ms             | 251ms               |
| first paint        | 23ms            | 100ms         | 27ms              | 22ms                |
| add two todos      | 117ms           | 840ms         | 115ms             | 83ms                |
| complete and clear | 168ms           | 1396ms        | 164ms             | 114ms               |
| delete a todo      | 92ms            | 791ms         | 101ms             | 74ms                |
| suite total        | 400ms           | 3127ms        | 407ms             | 293ms               |

Across three runs (testsurfer 400-424ms, playwright-webkit 407-491ms, playwright-chromium 293-315ms): testsurfer is at parity with Playwright-WebKit on suite wall time and ahead once launch is included; Playwright-Chromium keeps a ~1.3x lead on actions. Remaining per-action delta vs Chromium: the ~35ms trusted native robotic click (real OS input dispatch plus post-click snapshot) versus Chromium's ~10ms injected click. That preview ran on a local Mac against a sandboxed daemon; the CI table above, on a shared runner with the released 0.2.13, does not reproduce parity.

## Honest reading

On vibesurfer 0.2.18 testsurfer is faster than Playwright-WebKit on every flow but first paint on Linux, on both runners. Playwright-Chromium is level on Linux and a little ahead on first paint everywhere: its injected click is cheaper than a real OS input event. Earlier releases were slower, by 8x on 0.1.27 and 1.1-1.7x on 0.2.14; the history above shows where that time went.

The install is about 50x smaller than Playwright with one browser, there is nothing to download in CI beyond the vibesurfer binary, and launching against the resident daemon takes milliseconds.

Pick Playwright when you need Chromium or Firefox. Claims on the main README are backed by these tables, not the other way around.
