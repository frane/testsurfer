/**
 * testsurfer.config.ts: a suite in its own directory, with a config
 * file setting baseURL and the test-id attribute, run as a child
 * `node --test` the way a user runs it.
 */

import { test, after, before } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';

const INDEX = pathToFileURL(path.resolve('src/index.ts')).href;
let server: http.Server;
let dir: string;

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Cfg</title><button data-qa="go">Go</button>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testsurfer-config-'));
  fs.writeFileSync(
    path.join(dir, 'testsurfer.config.ts'),
    `import { defineConfig } from ${JSON.stringify(INDEX)};\n` +
      `export default defineConfig({ baseURL: ${JSON.stringify(base)}, testIdAttribute: 'data-qa' });\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'cfg.test.ts'),
    `import { test, expect } from ${JSON.stringify(INDEX)};\n` +
      `test('config applies', async ({ page }) => {\n` +
      `  await page.goto('/');\n` +
      `  await expect(page).toHaveTitle('Cfg');\n` +
      `  await expect(page.getByTestId('go')).toHaveText('Go');\n` +
      `});\n`,
  );
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('testsurfer.config.ts sets baseURL and testIdAttribute', async () => {
  // Async spawn so this process keeps serving the page meanwhile.
  // Without NODE_TEST_CONTEXT, or node treats the child as a nested run and skips it.
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  const child = spawn(process.execPath, ['--test', 'cfg.test.ts'], { cwd: dir, env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  assert.equal(code, 0, out);
  assert.match(out, /pass 1/);
});
