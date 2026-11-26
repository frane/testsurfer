#!/usr/bin/env node
// Run the lab on testsurfer and on Playwright's WebKit, and write
// lab/RESULTS.md: every case on both, wall time and install size.
//
//   node lab/run.mjs            # both
//   node lab/run.mjs testsurfer # one
//
// Playwright comes from bench/node_modules (`npm ci` in bench/ and
// `npx playwright install webkit` there); the lab links it in as
// lab/node_modules so the spec files' `@playwright/test` imports
// resolve to it. testsurfer redirects them to itself either way.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const here = import.meta.dirname;
const repo = path.dirname(here);
const which = process.argv[2];

// Playwright's browsers live under the real home, even when HOME points
// testsurfer at a separate vibesurfer daemon.
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.userInfo().homedir, 'Library', 'Caches', 'ms-playwright');

function run(cmd, args) {
  const t0 = Date.now();
  const env = { ...process.env, CI: '', PLAYWRIGHT_BROWSERS_PATH: browsers };
  const r = spawnSync(cmd, args, { cwd: here, encoding: 'utf8', maxBuffer: 64 << 20, env });
  return { out: r.stdout ?? '', err: r.stderr ?? '', ms: Date.now() - t0 };
}

/** name -> passed, from the node:test JSONL reporter. */
function testsurfer() {
  const r = run(process.execPath, [path.join(repo, 'src', 'cli.ts'), 'test', '--reporter', path.join(repo, 'compat', 'reporter.mjs')]);
  const rows = new Map();
  for (const line of r.out.split('\n')) {
    if (!line.startsWith('{')) continue;
    const t = JSON.parse(line);
    if (!t.name.endsWith('.ts')) rows.set(t.name, t.status === 'passed');
  }
  return { rows, ms: r.ms, err: r.err };
}

function playwright() {
  const link = path.join(here, 'node_modules');
  if (!fs.existsSync(link)) fs.symlinkSync(path.join('..', 'bench', 'node_modules'), link);
  const r = run(process.execPath, [path.join(link, '@playwright', 'test', 'cli.js'), 'test', '--reporter=json']);
  const rows = new Map();
  const errors = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const ok = spec.tests.every((t) => t.status === 'expected');
      rows.set(spec.title, ok);
      const msg = spec.tests.flatMap((t) => t.results ?? []).map((x) => x.error?.message).find(Boolean);
      if (!ok && msg && errors.length < 5) errors.push(`${spec.title}: ${msg.slice(0, 400)}`);
    }
    for (const s of suite.suites ?? []) walk(s);
  };
  const json = JSON.parse(r.out.slice(r.out.indexOf('{')));
  for (const s of json.suites) walk(s);
  for (const e of json.errors ?? []) errors.push(`global: ${String(e.message).slice(0, 400)}`);
  return { rows, ms: r.ms, err: [...errors, r.err].join('\n') };
}

function du(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.lstatSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, e) => n + du(path.join(p, e)), 0);
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

const ts = which === 'playwright' ? null : testsurfer();
const pw = which === 'testsurfer' ? null : playwright();

// Cases in the order the spec files list them.
const cases = [];
for (const f of fs.readdirSync(path.join(here, 'tests')).sort()) {
  const src = fs.readFileSync(path.join(here, 'tests', f), 'utf8');
  let area = '';
  for (const m of src.matchAll(/test\.describe\('([^']+)'|test\('((?:[^'\\]|\\.)+)'/g)) {
    if (m[1]) area = m[1];
    else cases.push({ area, name: m[2].replace(/\\'/g, "'") });
  }
}

const mark = (r, n) => (!r ? '' : r.rows.get(n) === true ? 'pass' : r.rows.has(n) ? 'FAIL' : 'missing');
const count = (r) => (r ? cases.filter((c) => r.rows.get(c.name) === true).length : 0);

const vs = (process.env.TESTSURFER_VS ?? 'vs').split(' ').filter(Boolean);
const vsVersion = process.env.LAB_VS_LABEL ?? spawnSync(vs[0], [...vs.slice(1), '--version'], { encoding: 'utf8' }).stdout?.trim() ?? '';
// Measure the binary, not a package manager's symlink to it.
const vsWhich = spawnSync('which', [vs[0]], { encoding: 'utf8' }).stdout?.trim() || vs[0];
const vsBin = fs.existsSync(vsWhich) ? fs.realpathSync(vsWhich) : vsWhich;
const tsSize = du(path.join(repo, 'src')) + du(path.join(repo, 'package.json'));
const pwRoot = path.join(here, 'node_modules');
const pwBrowsers = browsers;
const webkitDir = fs.existsSync(pwBrowsers) ? fs.readdirSync(pwBrowsers).filter((d) => d.startsWith('webkit')).sort().pop() : null;
const pwSize = du(path.join(pwRoot, '@playwright')) + du(path.join(pwRoot, 'playwright')) + du(path.join(pwRoot, 'playwright-core'));
const pwVersion = fs.existsSync(path.join(pwRoot, '@playwright', 'test', 'package.json'))
  ? JSON.parse(fs.readFileSync(path.join(pwRoot, '@playwright', 'test', 'package.json'), 'utf8')).version
  : '?';

const lines = [
  '# testsurfer lab',
  '',
  `${cases.length} cases, each a small page in \`fixtures/\` and a test in \`tests/\` written against \`@playwright/test\`. The same files run on Playwright's WebKit and on testsurfer (\`testsurfer test\` reads \`playwright.config.ts\`). ${new Date().toISOString().slice(0, 10)}, ${process.platform} ${process.arch}, ${vsVersion || 'vs'}, Playwright ${pwVersion}. Reproduce with \`node lab/run.mjs\`.`,
  '',
  '| | testsurfer | Playwright WebKit |',
  '| --- | --- | --- |',
  `| cases passed | ${ts ? `${count(ts)} of ${cases.length}` : '-'} | ${pw ? `${count(pw)} of ${cases.length}` : '-'} |`,
  `| wall time, whole lab | ${ts ? `${(ts.ms / 1000).toFixed(1)} s` : '-'} | ${pw ? `${(pw.ms / 1000).toFixed(1)} s` : '-'} |`,
  `| install | ${mb(tsSize + du(vsBin))} (testsurfer source and the vs binary) | ${mb(pwSize + (webkitDir ? du(path.join(pwBrowsers, webkitDir)) : 0))} (Playwright packages and its WebKit build) |`,
  '',
  'Wall time includes starting the fixture server and, for testsurfer, the vibesurfer daemon if it was not running. The config sets `fullyParallel`: Playwright spreads the tests over its default workers; testsurfer runs one process per file and up to four tests of a file at a time.',
  '',
  '| area | case | testsurfer | Playwright WebKit |',
  '| --- | --- | --- | --- |',
  ...cases.map((c) => `| ${c.area} | ${c.name.replace(/\|/g, '\\|')} | ${mark(ts, c.name)} | ${mark(pw, c.name)} |`),
  '',
];
fs.writeFileSync(path.join(here, 'RESULTS.md'), lines.join('\n'));
console.log(`testsurfer ${ts ? count(ts) : '-'}/${cases.length} in ${ts ? ts.ms : '-'}ms; Playwright ${pw ? count(pw) : '-'}/${cases.length} in ${pw ? pw.ms : '-'}ms`);
for (const [label, r] of [['testsurfer', ts], ['Playwright', pw]]) {
  if (!r) continue;
  const failed = cases.filter((c) => r.rows.get(c.name) !== true);
  if (failed.length === 0) continue;
  console.log(`\n${label} failed: ${failed.map((c) => c.name).join('; ')}`);
  if (r.err) console.log(`${label} stderr (tail):\n${r.err.slice(-3000)}`);
}
