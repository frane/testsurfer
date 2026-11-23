# AGENTS.md

Notes for agents working on this repo. Using testsurfer in another project: [skills/testsurfer/SKILL.md](skills/testsurfer/SKILL.md).

## Layout

- `src/` the library and CLI (TypeScript, ESM). `src/cli.ts` is `npx testsurfer`; `src/runner.ts` wraps node:test; `src/page.ts`, `src/locator.ts` the Playwright API; `src/injected.ts` the in-page engine; `src/client.ts` talks to the vibesurfer daemon and pins its version.
- `test/` unit and e2e tests (`node:test`).
- `lab/` one hard case per fixture, specs written against `@playwright/test`, run on both engines. See `lab/README.md`.
- `compat/` Playwright's own page specs run on testsurfer.
- `bench/` testsurfer vs Playwright timings; `.github/workflows/bench.yml` runs it and the lab on clean runners.
- `action.yml` the GitHub Action users add before `npx testsurfer test`.

## Commands

```sh
npm ci && npm run build
npm run typecheck
npm run test:unit
cd lab && node ../src/cli.ts test        # lab on testsurfer, from source
node lab/run.mjs                         # lab on both engines (needs bench/ deps)
```

`TESTSURFER_VS=/path/to/vs` runs a locally built vibesurfer instead of the pinned release. `TESTSURFER_PROFILE=1` prints per-call wire timings at exit.

## Rules

- A change to page behavior gets a lab case or a unit test. A lab case must pass on Playwright's WebKit too.
- Match Playwright's behavior and error text; when it differs, say so in `docs/compatibility.md`.
- Every feature works on macOS, Linux and Windows. Engine work belongs in vibesurfer; do not paper over an engine gap here.
- Docs: plain declarative sentences, no marketing words, no em-dashes. README stays short; details go in `docs/`.
- Releases are tagged `vX.Y.Z`; CI publishes to npm. Do not publish by hand.
