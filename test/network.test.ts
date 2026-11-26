/**
 * page.route(), page.on() and addInitScript() against a local app.
 * Needs vibesurfer 0.2.15+ (vs_init_script).
 */

import { after, before } from 'node:test';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { configure, expect, test } from '../src/index.ts';
import type { ConsoleMessage, Request, Response } from '../src/index.ts';

const APP = `<!doctype html>
<html><head><title>Net</title></head>
<body>
  <p id="fetch-out">-</p>
  <p id="xhr-out">-</p>
  <p id="init-out">-</p>
  <button id="load">Load</button>
  <button id="xhr">Load XHR</button>
  <button id="post">Post</button>
  <button id="boom">Boom</button>
  <script>
    document.getElementById('init-out').textContent = window.__initValue || 'no init';
    const out = (id, v) => { document.getElementById(id).textContent = v; };
    document.getElementById('load').addEventListener('click', async () => {
      try {
        const r = await fetch('/api/items');
        const j = await r.json();
        out('fetch-out', r.status + ' ' + j.items.join(','));
      } catch (e) { out('fetch-out', 'failed'); }
    });
    document.getElementById('xhr').addEventListener('click', () => {
      const x = new XMLHttpRequest();
      x.open('GET', '/api/items');
      x.onload = () => out('xhr-out', x.status + ' ' + JSON.parse(x.responseText).items.join(','));
      x.onerror = () => out('xhr-out', 'xhr failed');
      x.send();
    });
    document.getElementById('post').addEventListener('click', async () => {
      const r = await fetch('/api/echo', { method: 'POST', body: JSON.stringify({ n: 1 }) });
      out('fetch-out', await r.text());
    });
    document.getElementById('boom').addEventListener('click', () => {
      console.warn('about to fail');
      setTimeout(() => { throw new Error('kaboom'); }, 0);
    });
  </script>
</body></html>`;

let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/api/items') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: ['real'] }));
      return;
    }
    if (req.url === '/api/echo') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`echo ${body}`);
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(APP);
  });
  // WebSocket echo of short text frames (RFC 6455): `echo:<text>`.
  server.on('upgrade', (req, sock) => {
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.on('data', (b: Buffer) => {
      if ((b[0]! & 15) !== 1) return sock.end();
      const len = b[1]! & 127;
      const mask = b.subarray(2, 6);
      const out = Buffer.from('echo:' + Buffer.from(b.subarray(6, 6 + len).map((x, i) => x ^ mask[i % 4]!)).toString());
      sock.write(Buffer.concat([Buffer.from([0x81, out.length]), out]));
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  configure({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
});

after(() => server.close());

test.describe('network', () => {
  test('fulfill a fetch and an XHR, registered before goto', async ({ page }) => {
    await page.route('**/api/items', (route) => route.fulfill({ json: { items: ['mocked'] } }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await expect(page.locator('#fetch-out')).toHaveText('200 mocked');
    await page.getByRole('button', { name: 'Load XHR' }).click();
    await expect(page.locator('#xhr-out')).toHaveText('200 mocked');
  });

  test('route added after goto; continue, abort, fetch and modify', async ({ page }) => {
    await page.goto('/');
    await page.route('/api/items', (route) => route.abort());
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await expect(page.locator('#fetch-out')).toHaveText('failed');

    await page.unrouteAll();
    await page.route(/\/api\/items$/, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { items: string[] };
      await route.fulfill({ response: res, json: { items: [...body.items, 'added'] } });
    });
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await expect(page.locator('#fetch-out')).toHaveText('200 real,added');

    await page.unrouteAll();
    await page.route('**/api/echo', (route) => route.continue({ postData: 'changed' }));
    await page.getByRole('button', { name: 'Post' }).click();
    await expect(page.locator('#fetch-out')).toHaveText('echo changed');
  });

  test('fallback chains handlers; times limits a route', async ({ page }) => {
    await page.route('**/api/items', (route) => route.fulfill({ json: { items: ['base'] } }));
    await page.route('**/api/items', (route) => route.fallback(), { times: 1 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    await expect(page.locator('#fetch-out')).toHaveText('200 base');
  });

  test('events: request, response, console, pageerror', async ({ page }) => {
    await page.goto('/');
    const seen: string[] = [];
    page.on('request', (r: Request) => seen.push(`${r.method()} ${new URL(r.url()).pathname}`));
    const console: ConsoleMessage[] = [];
    page.on('console', (m: ConsoleMessage) => console.push(m));
    const errors: Error[] = [];
    page.on('pageerror', (e: Error) => errors.push(e));

    const responseP = page.waitForResponse('**/api/items');
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    const res: Response = await responseP;
    if (res.status() !== 200) throw new Error(`status ${res.status()}`);
    if (!seen.includes('GET /api/items')) throw new Error(`requests: ${seen.join(';')}`);

    const errP = page.waitForEvent<Error>('pageerror');
    await page.getByRole('button', { name: 'Boom' }).click();
    const err = await errP;
    if (!err.message.includes('kaboom')) throw new Error(`pageerror: ${err.message}`);
    if (!console.some((m) => m.type() === 'warning' && m.text() === 'about to fail')) {
      throw new Error(`console: ${console.map((m) => `${m.type()}:${m.text()}`).join(';')}`);
    }
  });

  test('addInitScript runs before the page scripts', async ({ page }) => {
    await page.addInitScript((v: string) => {
      (globalThis as unknown as { __initValue: string }).__initValue = v;
    }, 'from init');
    await page.goto('/');
    await expect(page.locator('#init-out')).toHaveText('from init');
  });

  // A context with its own user agent continues every request with changed
  // headers; a WebSocket handshake must stay an upgrade through that.
  test('a WebSocket connects in a context with a custom user agent', async ({ browser }) => {
    const ctx = await browser.newContext({ userAgent: 'testsurfer-ws-check' });
    const page = await ctx.newPage();
    await page.goto('/');
    const wsP = page.waitForEvent<{ url(): string }>('websocket');
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const got = await page.evaluate(
      (u: string) =>
        new Promise<string>((resolve) => {
          const s = new WebSocket(u);
          s.onopen = () => s.send('hi');
          s.onmessage = (e) => resolve(String(e.data));
          s.onclose = (e) => resolve(`closed ${e.code}`);
        }),
      url,
    );
    if (got !== 'echo:hi') throw new Error(`websocket: ${got}`);
    if (!(await wsP).url().endsWith('/ws')) throw new Error('no websocket event');
    // WebSocket shim events are not page errors.
    const errors = await page.pageErrors();
    if (errors.length) throw new Error(`pageErrors after a WebSocket: ${errors.length}`);
    await ctx.close();
  });
});
