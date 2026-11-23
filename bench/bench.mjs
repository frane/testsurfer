/**
 * testsurfer vs Playwright on identical flows against the same app.
 *
 * The locator APIs are close enough that one scenario body drives all
 * targets; only the expect implementation differs. Playwright runs
 * WebKit (engine parity with vibesurfer) and Chromium (its common
 * default). Each target: launch once, fresh page per iteration,
 * median of N iterations reported.
 *
 * Methodology note: Playwright launches a browser process per
 * launch(); vibesurfer keeps a long-lived daemon, so its "launch" is
 * a session open against a running daemon. Both are the tools' steady
 * states for local development. See README.md for the cold-daemon
 * number and disk footprint.
 */

import { webkit, chromium } from 'playwright';
import { expect as pwExpect } from '@playwright/test';
import { Browser as TsBrowser, expect as tsExpect } from 'testsurfer';
import { startServer } from '../examples/todo/app/server.js';

const ITERATIONS = 5;

const scenarios = {
  'first paint': async (page, expect, url) => {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'surf todos' })).toBeVisible();
  },
  'add two todos': async (page, expect, url) => {
    await page.goto(url);
    await page.getByLabel('New todo').fill('Buy milk');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText('1 item left')).toBeVisible();
    await page.getByLabel('New todo').fill('Walk the dog');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(2);
  },
  'complete and clear': async (page, expect, url) => {
    await page.goto(url);
    for (const todo of ['Buy milk', 'Walk the dog']) {
      await page.getByLabel('New todo').fill(todo);
      await page.getByRole('button', { name: 'Add' }).click();
    }
    await page.getByRole('checkbox', { name: 'Mark Buy milk done' }).click();
    await expect(page.getByText('1 item left')).toBeVisible();
    await page.getByRole('button', { name: 'Clear completed' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(1);
  },
  'delete a todo': async (page, expect, url) => {
    await page.goto(url);
    await page.getByLabel('New todo').fill('Buy milk');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await page.getByRole('button', { name: 'Delete Buy milk' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(0);
  },
};

function makeTargets() {
  const tsOnly = process.env.TS_ONLY === '1';
  return [
    {
      name: 'testsurfer',
      expect: tsExpect,
      async setup() {
        this.browser = await TsBrowser.launch({
          ...(process.env.TESTSURFER_SOCKET ? { socketPath: process.env.TESTSURFER_SOCKET } : {}),
          ...(process.env.TESTSURFER_CLICK_VIA ? { clickVia: process.env.TESTSURFER_CLICK_VIA } : {}),
          ...(process.env.TESTSURFER_ACT_DELTAS === '1' ? { protocol: { actDeltas: true } } : {}),
        });
      },
      async newPage() {
        // Untimed page pre-warm, mirroring the Playwright targets where
        // newContext+newPage are also outside the timer; the timed
        // goto is then a nav-in-place. A fresh isolated context per
        // iteration, as Playwright's target gets and as testsurfer's
        // own runner gives every test.
        const context = await this.browser.newContext();
        const page = await context.newPage();
        await page.goto('about:blank');
        return { page, done: () => context.close() };
      },
      async teardown() {
        await this.browser.close();
      },
    },
    ...(tsOnly
      ? []
      : [
          ['playwright-webkit', webkit],
          ['playwright-chromium', chromium],
        ]
    ).map(([name, engine]) => ({
      name,
      expect: pwExpect,
      async setup() {
        this.browser = await engine.launch();
      },
      async newPage() {
        const context = await this.browser.newContext();
        const page = await context.newPage();
        return { page, done: () => context.close() };
      },
      async teardown() {
        await this.browser.close();
      },
    })),
  ];
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const app = await startServer();
const results = {};
const launchTimes = {};

for (const target of makeTargets()) {
  const t0 = Date.now();
  await target.setup();
  launchTimes[target.name] = Date.now() - t0;
  results[target.name] = {};

  for (const [name, scenario] of Object.entries(scenarios)) {
    const times = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const { page, done } = await target.newPage();
      const s0 = Date.now();
      try {
        await scenario(page, target.expect, app.url);
        times.push(Date.now() - s0);
      } finally {
        await done();
      }
    }
    results[target.name][name] = times;
    console.error(`${target.name}  ${name}  ${times.join(' ')}ms`);
  }
  await target.teardown();
}

await app.close();

const targets = Object.keys(results);
const rows = [['scenario', ...targets]];
rows.push(['launch', ...targets.map((t) => `${launchTimes[t]}ms`)]);
for (const name of Object.keys(scenarios)) {
  rows.push([name, ...targets.map((t) => `${median(results[t][name])}ms`)]);
}
rows.push([
  `suite total (median of ${ITERATIONS})`,
  ...targets.map((t) => `${Object.keys(scenarios).reduce((sum, n) => sum + median(results[t][n]), 0)}ms`),
]);

const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
console.log('');
for (const [i, row] of rows.entries()) {
  console.log('| ' + row.map((c, j) => String(c).padEnd(widths[j])).join(' | ') + ' |');
  if (i === 0) console.log('| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |');
}
