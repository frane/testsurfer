# Playwright compatibility

Playwright's own page specs (v1.59.1, Apache-2.0) run against testsurfer, unmodified except for the import of their fixtures. 2026-11-22, darwin arm64, vibesurfer main at 9fc43c8 (released as 0.2.16). Reproduce with `node compat/run.mjs`.

**488 of 488 tests pass (100.0%)**; 7 are skipped by the specs themselves for WebKit or this platform.

| spec | passed | failed | skipped |
| ---- | ------ | ------ | ------- |
| expect-boolean | 86 | 0 | 0 |
| expect-misc | 60 | 0 | 0 |
| expect-to-have-text | 28 | 0 | 0 |
| expect-to-have-value | 11 | 0 | 0 |
| expect-timeout | 8 | 0 | 0 |
| locator-click | 5 | 0 | 0 |
| locator-convenience | 22 | 0 | 0 |
| locator-frame | 22 | 0 | 0 |
| locator-is-visible | 8 | 0 | 0 |
| locator-list | 1 | 0 | 0 |
| locator-misc-1 | 13 | 0 | 0 |
| locator-misc-2 | 16 | 0 | 0 |
| locator-query | 24 | 0 | 0 |
| selectors-css | 27 | 0 | 0 |
| selectors-get-by | 20 | 0 | 0 |
| selectors-role | 15 | 0 | 0 |
| selectors-text | 22 | 0 | 0 |
| page-route | 52 | 0 | 3 |
| page-network-request | 26 | 0 | 3 |
| page-network-response | 22 | 0 | 1 |

A test counts as failed when it errors for any reason. The failures with their first error line are in `compat/failures.json`.

Some tests are marked `test.fail()` for Playwright's own WebKit, for a bug it has. Where testsurfer does not have the bug, the test passes and counts as passed:

- page-network-response: should return set-cookie header after route.fulfill
