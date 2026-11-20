# Playwright compatibility

Playwright's own page specs (v1.59.1, Apache-2.0) run against testsurfer, unmodified except for the import of their fixtures. 2026-11-20, darwin arm64, vs 0.2.14. Reproduce with `node compat/run.mjs`.

**0 of 409 tests pass (0.0%)**; 0 are skipped by the specs themselves for WebKit or this platform.

| spec | passed | failed | skipped |
| ---- | ------ | ------ | ------- |
| expect-boolean | 0 | 0 (does not load) | 0 |
| expect-misc | 0 | 60 | 0 |
| expect-to-have-text | 0 | 28 | 0 |
| expect-to-have-value | 0 | 11 | 0 |
| expect-timeout | 0 | 8 | 0 |
| locator-click | 0 | 5 | 0 |
| locator-convenience | 0 | 22 | 0 |
| locator-frame | 0 | 22 | 0 |
| locator-is-visible | 0 | 8 | 0 |
| locator-list | 0 | 1 | 0 |
| locator-misc-1 | 0 | 13 | 0 |
| locator-misc-2 | 0 | 16 | 0 |
| locator-query | 0 | 24 | 0 |
| selectors-css | 0 | 27 | 0 |
| selectors-get-by | 0 | 20 | 0 |
| selectors-role | 0 | 15 | 0 |
| selectors-text | 0 | 22 | 0 |
| page-route | 0 | 55 | 0 |
| page-network-request | 0 | 29 | 0 |
| page-network-response | 0 | 23 | 0 |

A test counts as failed when it errors for any reason, including APIs testsurfer does not have (`page.$`, `elementHandle`, `locator.evaluate`, ...). The failures with their first error line are in `compat/failures.json`.
