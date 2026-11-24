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

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYWRIGHT_CONFIGS } from './pwconfig.ts';

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
  for (const name of [...PLAYWRIGHT_CONFIGS, 'testsurfer.config.ts', 'testsurfer.config.js']) {
    if (!fs.existsSync(name)) continue;
    const m = /testDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(fs.readFileSync(name, 'utf8'));
    if (m) return m[1]!;
  }
  return null;
}

const argv = process.argv.slice(2);
if (argv[0] !== 'test') usage(argv[0] === '--help' || argv[0] === '-h' ? 0 : 2);

const paths: string[] = [];
const onlyProjects: string[] = [];
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
  else if (a === '--project') onlyProjects.push(argv[++i] ?? usage(2));
  else if (a.startsWith('--project=')) onlyProjects.push(a.slice('--project='.length));
  else if (a.startsWith('-')) usage(2);
  else paths.push(a);
}

const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const register = new URL(`./register${ext}`, import.meta.url).href;
const nodeArgs = (files: string[]) => [
  '--import',
  register,
  '--test',
  `--test-reporter=${reporter}`,
  `--test-concurrency=${workers}`,
  // A file is done when its tests are, as with Playwright's workers:
  // a timer a test left running must not keep it alive.
  '--test-force-exit',
  ...(grep ? [`--test-name-pattern=${grep}`] : []),
  ...files,
];
// A playwright.config's webServer, globalSetup and globalTeardown run
// around the whole run, in their own process (src/global.ts).
const pwConfig = PLAYWRIGHT_CONFIGS.find((n) => fs.existsSync(n));
let global: ChildProcess | null = null;
type Pat = { re: string; flags: string } | { glob: string } | Pat[] | undefined;
interface ProjectInfo {
  name: string;
  testDir?: string;
  testMatch?: Pat;
  testIgnore?: Pat;
  dependencies: string[];
}
let projects: ProjectInfo[] = [];
let topMatch: Pat;
let topIgnore: Pat;
if (pwConfig) {
  const script = new URL(`./global${ext}`, import.meta.url);
  global = spawn(process.execPath, ['--import', register, fileURLToPath(script), pwConfig], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env,
  });
  const reply = await new Promise<{ ready?: boolean; failed?: string; env?: Record<string, string>; projects?: ProjectInfo[]; testMatch?: Pat; testIgnore?: Pat }>((resolve) => {
    global!.once('message', (m) => resolve(m as { ready?: boolean }));
    global!.once('exit', (code) => resolve({ failed: `global setup exited with code ${code}` }));
  });
  if (reply.failed) {
    process.stderr.write(`testsurfer: ${reply.failed}\n`);
    global.kill();
    process.exit(1);
  }
  Object.assign(env, reply.env ?? {});
  projects = reply.projects ?? [];
  topMatch = reply.testMatch;
  topIgnore = reply.testIgnore;
}

/** Run globalTeardown and stop web servers, then exit. */
function finish(code: number): void {
  if (!global || global.exitCode !== null) process.exit(code);
  global.once('exit', () => process.exit(code));
  global.send('teardown');
  setTimeout(() => process.exit(code), 30_000).unref();
}

if (paths.length === 0) {
  const dir = configuredTestDir() ?? (fs.existsSync('tests') ? 'tests' : '.');
  paths.push(dir);
}
const allFiles: string[] = [];
for (const p of paths) collect(p, allFiles);
if (allFiles.length === 0 && projects.every((p) => !p.testDir)) {
  process.stderr.write('testsurfer: no test files found (*.spec.* or *.test.*)\n');
  process.exit(2);
}


/** Playwright's test-file globs: `**` any depth, `*` within a name. */
function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${re}$`);
}

function matches(p: Pat, file: string): boolean {
  if (!p) return false;
  if (Array.isArray(p)) return p.some((x) => matches(x, file));
  const abs = path.resolve(file);
  return 're' in p ? new RegExp(p.re, p.flags).test(abs) : globRe(p.glob).test(abs);
}

/** The files a project runs: its testDir (or the run's), its testMatch, minus testIgnore. */
function filesFor(p: ProjectInfo | null): string[] {
  const match = p?.testMatch ?? topMatch;
  let list = allFiles;
  // With a testMatch, any script file can be a test file.
  if (match && !p?.testDir) {
    list = [];
    for (const q of paths) {
      if (fs.statSync(q).isDirectory()) collectAll(q, list);
      else list.push(q);
    }
  }
  if (p?.testDir) {
    list = [];
    collectAll(p.testDir, list);
    if (paths.length && !(paths.length === 1 && paths[0] === (configuredTestDir() ?? 'tests'))) {
      const wanted = new Set(allFiles.map((f) => path.resolve(f)));
      list = list.filter((f) => wanted.has(path.resolve(f)));
    }
  }
  const ignore = p?.testIgnore ?? topIgnore;
  return list.filter((f) => (match ? matches(match, f) : TEST_FILE.test(path.basename(f))) && !matches(ignore, f));
}

/** Every file under `dir` (testMatch decides which run). */
function collectAll(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectAll(full, out);
    else if (/\.(c|m)?[jt]sx?$/.test(e.name)) out.push(full);
  }
}

/** Projects to run, dependencies first; `--project` picks some (with what they depend on). */
function order(): ProjectInfo[] {
  const byName = new Map(projects.map((p) => [p.name, p]));
  const out: ProjectInfo[] = [];
  const seen = new Set<string>();
  const visit = (p: ProjectInfo) => {
    if (seen.has(p.name)) return;
    seen.add(p.name);
    for (const d of p.dependencies) {
      const dep = byName.get(d);
      if (dep) visit(dep);
    }
    out.push(p);
  };
  for (const p of onlyProjects.length ? projects.filter((p) => onlyProjects.includes(p.name)) : projects) visit(p);
  return out;
}

function runFiles(files: string[], extra: Record<string, string>): Promise<number> {
  if (files.length === 0) return Promise.resolve(0);
  const child = spawn(process.execPath, nodeArgs(files), { stdio: 'inherit', env: { ...env, ...extra } });
  const stop = () => child.kill('SIGINT');
  process.on('SIGINT', stop);
  return new Promise((resolve) =>
    child.on('exit', (code, signal) => {
      process.off('SIGINT', stop);
      resolve(code ?? (signal ? 1 : 0));
    }),
  );
}

const runs = order();
if (runs.length <= 1) {
  const only = runs[0] ?? null;
  const files = filesFor(only);
  if (files.length === 0) {
    process.stderr.write('testsurfer: no test files found (*.spec.* or *.test.*)\n');
    finish(2);
  } else finish(await runFiles(files, only ? { TESTSURFER_PROJECT: only.name } : {}));
} else {
  const failed = new Set<string>();
  let code = 0;
  for (const p of runs) {
    const blocked = p.dependencies.find((d) => failed.has(d));
    if (blocked) {
      process.stdout.write(`\n[${p.name}] skipped: project ${blocked} failed\n`);
      failed.add(p.name);
      code = code || 1;
      continue;
    }
    process.stdout.write(`\n[${p.name}]\n`);
    const c = await runFiles(filesFor(p), { TESTSURFER_PROJECT: p.name });
    if (c !== 0) {
      failed.add(p.name);
      code = code || c;
    }
  }
  finish(code);
}
