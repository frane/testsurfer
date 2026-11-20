/**
 * toHaveScreenshot end to end, as child `node --test` runs of a small
 * suite: the first run writes baselines and fails, the second passes,
 * a changed page fails with a diff image.
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
let color = 'rgb(20, 120, 220)';

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><title>Shot</title><style>body{margin:0;background:#fff}` +
        `#box{width:120px;height:60px;background:${color}}</style><div id="box" role="img" aria-label="box"></div>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'testsurfer-shot-'));
  fs.writeFileSync(
    path.join(dir, 'shot.test.ts'),
    `import { test, expect, configure } from ${JSON.stringify(INDEX)};\n` +
      `configure({ baseURL: ${JSON.stringify(base)}, outputDir: 'results' });\n` +
      `test('box', async ({ page }) => {\n` +
      `  await page.goto('/');\n` +
      `  await expect(page.locator('#box')).toHaveScreenshot({ timeout: 2000 });\n` +
      `  await expect(page).toHaveScreenshot('whole', { timeout: 2000 });\n` +
      `});\n`,
  );
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(): Promise<{ code: number | null; out: string }> {
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  delete env['TESTSURFER_UPDATE_SNAPSHOTS'];
  const child = spawn(process.execPath, ['--test', 'shot.test.ts'], { cwd: dir, env });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  return { code, out };
}

test('baselines are written, matched, and diffed', async () => {
  const snaps = path.join(dir, 'shot.test.ts-snapshots');

  const first = await run();
  assert.notEqual(first.code, 0, 'a missing baseline must fail the first run');
  assert.match(first.out, /no screenshot baseline; wrote/);
  assert.ok(fs.existsSync(path.join(snaps, `box-1-${process.platform}.png`)), first.out);

  // The element baseline exists now; the page one is written on this run.
  const second = await run();
  const third = second.code === 0 ? second : await run();
  assert.equal(third.code, 0, third.out);
  assert.ok(fs.existsSync(path.join(snaps, `whole-${process.platform}.png`)));

  color = 'rgb(220, 40, 40)';
  const changed = await run();
  assert.notEqual(changed.code, 0, 'a changed page must fail');
  assert.match(changed.out, /pixels differ/);
  assert.ok(fs.existsSync(path.join(dir, 'results', 'box-1-diff.png')), changed.out);
});
