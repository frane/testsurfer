# testsurfer lab

Small fixture pages, one hard case each, with tests written against `@playwright/test`. The same spec files run unchanged on Playwright and on testsurfer, so the lab doubles as public evidence of what works. Results: [RESULTS.md](RESULTS.md).

- `fixtures/` the pages, grouped by area (locators, actions, assertions, dynamic, frames, shadow, popups, network, keyboard, page, canvas).
- `tests/` one spec file per group of areas.
- `server.mjs` serves `fixtures/` plus a few dynamic routes (JSON, header echo, redirects, cookies) on every host of its port, so `127.0.0.1` and `localhost` are two origins.
- `playwright.config.ts` starts the server as a `webServer` and sets `baseURL`; `testsurfer test` reads it.

Run it:

```sh
cd lab && npx testsurfer test         # testsurfer
node lab/run.mjs                      # both engines, writes RESULTS.md
```

`run.mjs` takes Playwright from `bench/node_modules` (`npm ci` and `npx playwright install webkit` in `bench/`).

A case belongs here when it is something a real suite does and an engine can get wrong: trusted input, actionability waits, shadow DOM, frames, popups, routing, dialogs. Each test must pass on Playwright's WebKit; one that only testsurfer passes is not evidence.
