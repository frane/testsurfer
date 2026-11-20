#!/usr/bin/env node
/**
 * `testsurfer test [paths...]`: run a test suite on node:test with
 * Playwright imports pointed at testsurfer, so a Playwright suite runs
 * without edits.
 *
 *   --grep <pattern>       only tests whose name matches
 *   --workers <n>          test files at once (default: half the CPUs)
 *   --update-snapshots     rewrite toHaveScreenshot baselines
 *   --reporter <name>      node:test reporter (default: spec)
 *
 * With no paths it runs the `testDir` named in playwright.config.* or
 * testsurfer.config.* when it can read one, else ./tests, else the
 * current directory.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;

function usage(code: number): never {
  process.stdout.write(
    'usage: testsurfer test [paths...] [--grep <pattern>] [--workers <n>] [--update-snapshots] [--reporter <name>]\n',
  );
  process.exit(code);
}

function collect(p: string, out: string[]): void {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) {
    process.stderr.write(`testsurfer: no such file or directory: ${p}\n`);
    process.exit(2);
  }
  if (st.isFile()) {
    out.push(p);
    return;
  }
  for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(p, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (TEST_FILE.test(e.name)) out.push(full);
  }
}

/** testDir from a config file, read as text: configs import modules we do not want to run here. */
function configuredTestDir(): string | null {
  for (const name of ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs', 'testsurfer.config.ts', 'testsurfer.config.js']) {
    if (!fs.existsSync(name)) continue;
    const m = /testDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(fs.readFileSync(name, 'utf8'));
    if (m) return m[1]!;
  }
  return null;
}

const argv = process.argv.slice(2);
if (argv[0] !== 'test') usage(argv[0] === '--help' || argv[0] === '-h' ? 0 : 2);

const paths: string[] = [];
let grep: string | null = null;
let workers = Math.max(1, Math.floor(os.availableParallelism() / 2));
let reporter = 'spec';
const env = { ...process.env };
// Started from inside another node:test run, the child would refuse to run files.
delete env['NODE_TEST_CONTEXT'];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--grep' || a === '-g') grep = argv[++i] ?? usage(2);
  else if (a === '--workers' || a === '-j') workers = Number(argv[++i] ?? usage(2));
  else if (a === '--reporter') reporter = argv[++i] ?? usage(2);
  else if (a === '--update-snapshots' || a === '-u') env['TESTSURFER_UPDATE_SNAPSHOTS'] = 'all';
  else if (a.startsWith('-')) usage(2);
  else paths.push(a);
}

if (paths.length === 0) {
  const dir = configuredTestDir() ?? (fs.existsSync('tests') ? 'tests' : '.');
  paths.push(dir);
}
const files: string[] = [];
for (const p of paths) collect(p, files);
if (files.length === 0) {
  process.stderr.write('testsurfer: no test files found (*.spec.* or *.test.*)\n');
  process.exit(2);
}

const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const register = new URL(`./register${ext}`, import.meta.url).href;
const args = [
  '--import',
  register,
  '--test',
  `--test-reporter=${reporter}`,
  `--test-concurrency=${workers}`,
  ...(grep ? [`--test-name-pattern=${grep}`] : []),
  ...files,
];
const child = spawn(process.execPath, args, { stdio: 'inherit', env });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
