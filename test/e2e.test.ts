/**
 * The M0 green test: a real page served locally, driven end-to-end
 * through the vibesurfer daemon. Requires a reachable daemon (any
 * `vs` on PATH, TESTSURFER_VS, or an npx-fetched pinned binary).
 */

import { after, before } from 'node:test';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '../src/index.ts';

const PAGE = `<!doctype html>
<html>
<head><title>testsurfer fixture</title></head>
<body>
  <main id="login">
    <h1>Sign in to continue</h1>
    <form id="form">
      <input type="email" aria-label="Email" placeholder="you@example.com">
      <input type="password" aria-label="Password">
      <button type="submit">Sign in</button>
    </form>
  </main>
  <main id="app" hidden>
    <h1>Dashboard</h1>
    <p id="who"></p>
  </main>
  <script>
    document.getElementById('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = document.querySelector('input[type=email]').value;
      document.getElementById('login').hidden = true;
      const app = document.getElementById('app');
      app.hidden = false;
      document.getElementById('who').textContent = 'Signed in as ' + email;
    });
  </script>
</body>
</html>`;

let server: http.Server;
let url: string;

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

after(() => {
  server.close();
});

test('signs in through the fixture page', async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Email' }).fill('frane@example.com');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeHidden();
  await expect(page.getByText('Signed in as frane@example.com')).toBeVisible();
});
