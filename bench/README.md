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

GitHub `macos-15-arm64` runner, vibesurfer 0.2.13, playwright 1.61.1, 2026-11-19. Median of 5 iterations, fresh page per iteration, steady state (browsers installed, daemon running).

| scenario           | testsurfer | playwright-webkit | playwright-chromium |
| ------------------ | ---------- | ----------------- | ------------------- |
| launch             | 4ms        | 2019ms            | 609ms               |
| first paint        | 200ms      | 89ms              | 37ms                |
| add two todos      | 344ms      | 278ms             | 139ms               |
| complete and clear | 537ms      | 308ms             | 208ms               |
| delete a todo      | 356ms      | 170ms             | 110ms               |
| suite total        | 1437ms     | 845ms             | 494ms               |

testsurfer launches in milliseconds against a running daemon and is about 1.7x slower than Playwright-WebKit on the flows themselves, most of it in first paint (navigation plus the first accessibility snapshot). The same workflow on vibesurfer 0.2.12 measured 4152ms for testsurfer: from 0.2.10 every click waited 250ms in case it had opened a new window, and 0.2.13 waits only when the page actually asked for one.

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

Against the pinned 0.1.x contract (the top table), Playwright is roughly 8x faster per scenario once its browser is up. That gap was structural: every vibesurfer mutation paid a full accessibility snapshot, a humanized input path, discarded deltas, and a hidden per-view console eval. The benchmark found each of those; the 0.2 branch fixed them, and the preview table is the result: parity with Playwright-WebKit on suite wall time, ahead once launch is counted, with Playwright-Chromium keeping a ~1.3x action lead because an injected CDP click is cheaper than a real OS-level input event plus a fresh accessibility snapshot.

testsurfer also wins where the weight is: a working install is about 50x smaller than Playwright with one browser, there is nothing to download in CI beyond a 6MB binary, and launching against the resident daemon is effectively free.

So, as of the 0.2 preview: pick testsurfer for install size, CI weight, cold start, semantic locators, the no-automation-surface engine, and WebKit-class suite speed. Pick Playwright-Chromium when raw action throughput on Chromium is the only metric that matters. Claims on the main README are backed by this table, not the other way around, and the preview numbers make no claim until 0.2 is the pinned release.
