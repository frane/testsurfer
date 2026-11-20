#!/usr/bin/env node
// Run a pinned set of Playwright's own page specs against testsurfer
// and write the pass rate to compat/RESULTS.md.
//
//   node compat/run.mjs            # all specs
//   node compat/run.mjs expect-boolean locator-query
//
// The specs come from the Playwright repository (Apache-2.0) at
// PW_TAG, fetched with a sparse git checkout into compat/.cache. Each
// one runs unmodified except for two import paths, which point at
// compat/pageTest.ts and compat/utils.ts instead of Playwright's
// fixtures.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PW_TAG = 'v1.59.1';
const SPECS = [
  'expect-boolean',
  'expect-misc',
  'expect-to-have-text',
  'expect-to-have-value',
  'expect-timeout',
  'locator-click',
  'locator-convenience',
  'locator-frame',
  'locator-is-visible',
  'locator-list',
  'locator-misc-1',
  'locator-misc-2',
  'locator-query',
  'selectors-css',
  'selectors-get-by',
  'selectors-role',
  'selectors-text',
  'page-route',
  'page-network-request',
  'page-network-response',
];

const here = import.meta.dirname;
const cache = path.join(here, '.cache', 'playwright');
const work = path.join(here, '.work');

function fetchPlaywright() {
  if (fs.existsSync(path.join(cache, 'tests', 'page'))) return;
  fs.mkdirSync(cache, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: cache, stdio: 'inherit' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://github.com/microsoft/playwright.git');
  git('config', 'core.sparseCheckout', 'true');
  fs.writeFileSync(path.join(cache, '.git', 'info', 'sparse-checkout'), 'tests/page/\ntests/assets/\nLICENSE\n');
  git('fetch', '-q', '--depth', '1', 'origin', 'tag', PW_TAG);
  git('checkout', '-q', PW_TAG);
}

function prepare(name) {
  const src = fs.readFileSync(path.join(cache, 'tests', 'page', `${name}.spec.ts`), 'utf8');
  const out = src
    .replace(/from '\.\/pageTest'/g, "from '../pageTest.ts'")
    .replace(/from '\.\.\/config\/utils'/g, "from '../utils.ts'");
  const file = path.join(work, `${name}.spec.ts`);
  fs.writeFileSync(file, out);
  return file;
}

fetchPlaywright();
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const only = process.argv.slice(2);
const specs = only.length ? SPECS.filter((s) => only.includes(s)) : SPECS;
const rows = [];
const failures = [];
const JOBS = Number(process.env.COMPAT_JOBS ?? 3);

/** Run one spec file in its own node:test process. */
function runSpec(name) {
  const file = prepare(name);
  const dest = path.join(work, `${name}.jsonl`);
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '--test',
        '--test-concurrency=1',
        '--test-timeout=30000',
        `--test-reporter=${path.join(here, 'reporter.mjs')}`,
        `--test-reporter-destination=${dest}`,
        file,
      ],
      { cwd: work, env: { ...process.env, COMPAT_ASSETS: path.join(cache, 'tests', 'assets') } },
    );
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.stdout.resume();
    child.on('exit', () => {
      const results = fs.existsSync(dest)
        ? fs.readFileSync(dest, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
      // A spec that cannot load reports one failure named after the file.
      const tests = results.filter((t) => !t.name.endsWith('.spec.ts'));
      const loadError = results.find((t) => t.name.endsWith('.spec.ts') && t.status === 'failed');
      const count = (s) => tests.filter((t) => t.status === s).length;
      const row = { name, passed: count('passed'), failed: count('failed'), skipped: count('skipped') };
      if (loadError && tests.length === 0) row.loadError = loadError.error ?? stderr.split('\n')[0];
      console.log(
        `${name}: ${row.passed} passed, ${row.failed} failed, ${row.skipped} skipped${row.loadError ? ` (load error: ${row.loadError})` : ''}`,
      );
      resolve({ row, tests });
    });
  });
}

// A few spec files at a time; results are kept in the SPECS order.
const results = new Array(specs.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(JOBS, specs.length) }, async () => {
    while (next < specs.length) {
      const i = next++;
      results[i] = await runSpec(specs[i]);
    }
  }),
);
for (const { row, tests } of results) {
  rows.push(row);
  for (const t of tests.filter((t) => t.status === 'failed')) failures.push({ spec: row.name, test: t.name, error: t.error });
}

const total = rows.reduce(
  (a, r) => ({ passed: a.passed + r.passed, failed: a.failed + r.failed, skipped: a.skipped + r.skipped }),
  { passed: 0, failed: 0, skipped: 0 },
);
const ran = total.passed + total.failed;
const pct = ran ? ((100 * total.passed) / ran).toFixed(1) : '0';
console.log(`\ntotal: ${total.passed}/${ran} passed (${pct}%), ${total.skipped} skipped`);

if (!only.length) {
  const vsCmd = (process.env.TESTSURFER_VS ?? 'vs').split(' ').filter(Boolean);
  const vs = spawnSync(vsCmd[0], [...vsCmd.slice(1), '--version'], { encoding: 'utf8' }).stdout?.trim();
  const lines = [
    '# Playwright compatibility',
    '',
    `Playwright's own page specs (${PW_TAG}, Apache-2.0) run against testsurfer, unmodified except for the import of their fixtures. ${new Date().toISOString().slice(0, 10)}, ${process.platform} ${process.arch}, ${vs || 'vs'}. Reproduce with \`node compat/run.mjs\`.`,
    '',
    `**${total.passed} of ${ran} tests pass (${pct}%)**; ${total.skipped} are skipped by the specs themselves for WebKit or this platform.`,
    '',
    '| spec | passed | failed | skipped |',
    '| ---- | ------ | ------ | ------- |',
    ...rows.map((r) => `| ${r.name} | ${r.passed} | ${r.failed}${r.loadError ? ' (does not load)' : ''} | ${r.skipped} |`),
    '',
    'A test counts as failed when it errors for any reason, including APIs testsurfer does not have (`page.$`, `elementHandle`, `locator.evaluate`, ...). The failures with their first error line are in `compat/failures.json`.',
    '',
  ];
  fs.writeFileSync(path.join(here, 'RESULTS.md'), lines.join('\n'));
  fs.writeFileSync(path.join(here, 'failures.json'), JSON.stringify(failures, null, 2) + '\n');
}
