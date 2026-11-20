# Playwright compatibility

Playwright's own page specs (v1.59.1, Apache-2.0) run against testsurfer, unmodified except for the import of their fixtures. 2026-11-20, darwin arm64, vs 0.2.15. Reproduce with `node compat/run.mjs`.

**371 of 488 tests pass (76.0%)**; 7 are skipped by the specs themselves for WebKit or this platform.

| spec | passed | failed | skipped |
| ---- | ------ | ------ | ------- |
| expect-boolean | 86 | 0 | 0 |
| expect-misc | 52 | 8 | 0 |
| expect-to-have-text | 28 | 0 | 0 |
| expect-to-have-value | 11 | 0 | 0 |
| expect-timeout | 7 | 1 | 0 |
| locator-click | 5 | 0 | 0 |
| locator-convenience | 20 | 2 | 0 |
| locator-frame | 6 | 16 | 0 |
| locator-is-visible | 8 | 0 | 0 |
| locator-list | 1 | 0 | 0 |
| locator-misc-1 | 12 | 1 | 0 |
| locator-misc-2 | 13 | 3 | 0 |
| locator-query | 20 | 4 | 0 |
| selectors-css | 23 | 4 | 0 |
| selectors-get-by | 19 | 1 | 0 |
| selectors-role | 15 | 0 | 0 |
| selectors-text | 21 | 1 | 0 |
| page-route | 12 | 40 | 3 |
| page-network-request | 4 | 22 | 3 |
| page-network-response | 8 | 14 | 1 |

A test counts as failed when it errors for any reason, including APIs testsurfer does not have (`page.$`, `elementHandle`, `locator.evaluate`, ...). The failures with their first error line are in `compat/failures.json`.
