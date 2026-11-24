/**
 * The whole-run part of a playwright.config: start each `webServer`
 * (unless one already answers and `reuseExistingServer` allows it),
 * run `globalSetup`, report ready, and when the run ends run the
 * setup's returned teardown and `globalTeardown` and stop the servers.
 *
 * src/cli.ts runs this as its own process (with the same import hooks
 * as the tests), since a globalSetup often starts a server that has to
 * live as long as the run. It talks over the IPC channel: `ready` or
 * `failed` out, `teardown` in.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importPlaywrightConfig, type PlaywrightConfig, type WebServer } from './pwconfig.ts';

const file = process.argv[2];
if (!file || !process.send) {
  process.stderr.write('usage: started by testsurfer test\n');
  process.exit(2);
}

const servers: ChildProcess[] = [];
const teardowns: (() => unknown)[] = [];

function up(ws: WebServer): Promise<boolean> {
  if (ws.url) {
    return fetch(ws.url, { method: 'GET', signal: AbortSignal.timeout(2000) }).then(
      // Playwright counts any status below 400 (and some 4xx) as up; a reply at all is close enough.
      (r) => r.status < 500,
      () => false,
    );
  }
  const port = ws.port ?? 0;
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

async function startServer(ws: WebServer, dir: string): Promise<void> {
  if (await up(ws)) {
    if (ws.reuseExistingServer) return;
    throw new Error(`webServer: ${ws.url ?? `port ${ws.port}`} is already in use; set reuseExistingServer to use it`);
  }
  const child = spawn(ws.command, {
    shell: true,
    cwd: ws.cwd ? path.resolve(dir, ws.cwd) : dir,
    env: { ...process.env, ...ws.env },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
  });
  servers.push(child);
  const budget = ws.timeout ?? 60_000;
  const deadline = Date.now() + budget;
  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? 1));
  while (!(await up(ws))) {
    if (exited !== null) throw new Error(`webServer: "${ws.command}" exited with code ${exited}`);
    if (Date.now() > deadline) throw new Error(`webServer: "${ws.command}" did not answer within ${budget}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function runHook(spec: string, cfg: PlaywrightConfig, dir: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(path.resolve(dir, spec)).href)) as { default?: (c: unknown) => unknown };
  return typeof mod.default === 'function' ? mod.default(cfg) : undefined;
}

function stopServers(): void {
  for (const s of servers) {
    if (s.exitCode !== null || !s.pid) continue;
    try {
      // The whole process group: `npm run dev` leaves its server as a grandchild.
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(s.pid), '/T', '/F']);
      else process.kill(-s.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

async function teardown(cfg: PlaywrightConfig, dir: string): Promise<void> {
  for (const t of teardowns.reverse()) await t();
  for (const spec of [cfg.globalTeardown ?? []].flat()) await runHook(spec, cfg, dir);
  stopServers();
}

const dir = path.dirname(path.resolve(file));
const envBefore = { ...process.env };
const cfg = await importPlaywrightConfig(path.resolve(file));
process.on('message', (m) => {
  if (m !== 'teardown') return;
  void teardown(cfg, dir)
    .catch((e: unknown) => process.stderr.write(`globalTeardown: ${String(e)}\n`))
    .finally(() => process.exit(0));
});
// The runner went away without saying so: still stop the servers.
process.on('disconnect', () => {
  stopServers();
  process.exit(0);
});

try {
  for (const ws of [cfg.webServer ?? []].flat()) await startServer(ws, dir);
  for (const spec of [cfg.globalSetup ?? []].flat()) {
    const r = await runHook(spec, cfg, dir);
    if (typeof r === 'function') teardowns.push(r as () => unknown);
  }
  // Variables the config or globalSetup set reach the tests, as in Playwright.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && envBefore[k] !== v) env[k] = v;
  if (cfg.fullyParallel) env['TESTSURFER_FULLY_PARALLEL'] = '1';
  // The CLI runs each project on its own (testMatch, testIgnore,
  // dependencies); a RegExp travels as its source and flags.
  type Pat = { re: string; flags: string } | { glob: string } | Pat[] | undefined;
  const pat = (v: unknown): Pat =>
    v instanceof RegExp ? { re: v.source, flags: v.flags } : Array.isArray(v) ? v.map(pat) : typeof v === 'string' ? { glob: v } : undefined;
  const projects = (cfg.projects ?? []).map((p) => {
    const q = p as { name?: string; testDir?: string; testMatch?: unknown; testIgnore?: unknown; dependencies?: string[] };
    return {
      name: q.name ?? '',
      ...(q.testDir ? { testDir: path.resolve(path.dirname(file), q.testDir) } : {}),
      ...(q.testMatch !== undefined ? { testMatch: pat(q.testMatch) } : {}),
      ...(q.testIgnore !== undefined ? { testIgnore: pat(q.testIgnore) } : {}),
      dependencies: q.dependencies ?? [],
    };
  });
  const top = cfg as { testMatch?: unknown; testIgnore?: unknown };
  process.send({ ready: true, env, projects, testMatch: pat(top.testMatch), testIgnore: pat(top.testIgnore) });
} catch (e) {
  stopServers();
  process.send({ failed: e instanceof Error ? e.message : String(e) });
}
