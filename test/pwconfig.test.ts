/**
 * playwright.config mapping: what testsurfer reads from a Playwright
 * config. No daemon needed.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { effectiveUse, runnerOptionsFrom } from '../src/pwconfig.ts';

test('use, expect and timeouts map to runner options', () => {
  const o = runnerOptionsFrom(
    {
      timeout: 20_000,
      expect: { timeout: 7_000 },
      use: { baseURL: 'http://app.localhost:3000', testIdAttribute: 'data-qa', actionTimeout: 0, navigationTimeout: 9_000 },
      outputDir: 'out',
    },
    '/repo',
  );
  assert.equal(o['baseURL'], 'http://app.localhost:3000');
  assert.equal(o['testIdAttribute'], 'data-qa');
  // actionTimeout 0 means no limit; the test's timeout bounds it.
  assert.deepEqual(o['timeouts'], { action: 20_000, navigation: 9_000, expect: 7_000 });
  assert.equal(o['outputDir'], path.resolve('/repo', 'out'));
});

test("a WebKit project's use wins over the top level", () => {
  const use = effectiveUse({
    use: { baseURL: 'http://a', viewport: { width: 800, height: 600 } },
    projects: [
      { name: 'chromium', use: { defaultBrowserType: 'chromium', baseURL: 'http://c' } },
      { name: 'webkit', use: { defaultBrowserType: 'webkit', viewport: { width: 390, height: 664 } } },
    ],
  });
  assert.equal(use.baseURL, 'http://a');
  assert.deepEqual(use.viewport, { width: 390, height: 664 });
});

test('without a WebKit project the first project applies', () => {
  const use = effectiveUse({ projects: [{ name: 'chromium', use: { baseURL: 'http://c' } }, { name: 'firefox' }] });
  assert.equal(use.baseURL, 'http://c');
});

test('snapshotDir becomes a snapshot path template', () => {
  const o = runnerOptionsFrom({ testDir: 'tests', snapshotDir: 'snaps' }, '/repo');
  assert.equal(o['snapshotPathTemplate'], `${path.resolve('/repo', 'snaps')}/{relTestFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}`);
});
