/**
 * End-to-end coverage for the M2 surface: tree snapshots, checked
 * state, <label> lookup, page eval, screenshots, trusted drag, saved
 * auth, and the runner's describe/hooks/baseURL. Needs a vibesurfer
 * daemon that emits level=, checked= and lbl= (0.2.12+).
 */

import { after, before } from 'node:test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { configure, expect, test } from '../src/index.ts';

const APP = `<!doctype html>
<html>
<head><title>Features</title>
<style>
  #list li { height: 40px; width: 200px; border: 1px solid #888; list-style: none; }
</style>
</head>
<body>
  <main>
    <h1>Settings</h1>
    <h2>Profile</h2>
    <label for="email">Work email</label>
    <input id="email" type="email">
    <label><input type="checkbox" id="news"> Send me news</label>
    <p id="saved"></p>
    <button id="save">Save</button>
    <h2>Order</h2>
    <ul id="list">
      <li draggable="true">Alpha</li>
      <li draggable="true">Bravo</li>
      <li draggable="true">Charlie</li>
    </ul>
  </main>
  <script>
    document.getElementById('save').addEventListener('click', () => {
      document.getElementById('saved').textContent =
        'Saved ' + document.getElementById('email').value;
    });
    let dragged = null;
    const list = document.getElementById('list');
    list.addEventListener('dragstart', (e) => { dragged = e.target; });
    list.addEventListener('dragover', (e) => e.preventDefault());
    list.addEventListener('drop', (e) => {
      e.preventDefault();
      const target = e.target.closest('li');
      if (dragged && target && dragged !== target) list.insertBefore(dragged, target.nextSibling);
    });
  </script>
</body>
</html>`;

const ACCOUNT = `<!doctype html>
<html><head><title>Account</title></head>
<body>
  <h1 id="who"></h1>
  <button id="login">Log in</button>
  <script>
    const who = document.getElementById('who');
    const render = () => { who.textContent = localStorage.getItem('user') ? 'Hello ' + localStorage.getItem('user') : 'Signed out'; };
    document.getElementById('login').addEventListener('click', () => { localStorage.setItem('user', 'ada'); render(); });
    render();
  </script>
</body></html>`;

let server: http.Server;
let base: string;
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'testsurfer-shots-'));
const authName = `testsurfer-e2e-${process.pid}`;

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url?.startsWith('/account') ? ACCOUNT : APP);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  configure({ baseURL: base, screenshot: 'only-on-failure', outputDir });
});

after(() => {
  server.close();
  fs.rmSync(outputDir, { recursive: true, force: true });
});

test.describe('settings page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
  });

  test('heading levels and the tree snapshot', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(2);
    await expect(page.getByRole('main')).toMatchAriaSnapshot(`
      - heading "Settings" [level=1]
      - heading "Profile" [level=2]
      - textbox "Work email"
      - checkbox "Send me news"
      - button "Save"
      - list:
        - listitem "Alpha"
        - listitem "Charlie"
    `);
    await expect(page).not.toMatchAriaSnapshot('- button "Delete"', { timeout: 300 });
  });

  test('label lookup, values and checked state', async ({ page }) => {
    const email = page.getByLabel('Work email');
    await email.fill('ada@example.com');
    await expect(email).toHaveValue('ada@example.com');
    const news = page.getByRole('checkbox', { name: 'Send me news' });
    await expect(news).not.toBeChecked();
    await news.check();
    await expect(news).toBeChecked();
    await news.check();
    await expect(news).toBeChecked();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved ada@example.com')).toBeVisible();
  });

  test('evaluate, url and screenshots', async ({ page }) => {
    await expect(page).toHaveURL(`${base}/settings`);
    assert(await page.evaluate<number>('document.querySelectorAll("li").length') === 3);
    assert(await page.evaluate<string>(() => (globalThis as unknown as { document: { title: string } }).document.title) === 'Features');
    const file = path.join(outputDir, 'shot.png');
    const buf = await page.screenshot({ path: file });
    assert(fs.readFileSync(file).equals(buf), 'path and returned bytes differ');
    const head = buf.subarray(0, 4).toString('hex');
    assert(head === '89504e47', `not a PNG: ${head}`);
  });

  test('drag reorders through the HTML5 drag events', async ({ page }) => {
    await page.getByText('Alpha').dragTo(page.getByText('Charlie'));
    await expect(page.getByRole('list')).toMatchAriaSnapshot(`
      - listitem "Bravo"
      - listitem "Charlie"
      - listitem "Alpha"
    `);
  });
});

test('saved auth restores a login', async ({ page }) => {
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible();
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Hello ada' })).toBeVisible();
  await page.saveAuth(authName);
  await page.evaluate('localStorage.clear()');
  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible();
  try {
    await page.loadAuth(authName);
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Hello ada' })).toBeVisible();
  } finally {
    await page.clearAuth(authName);
  }
});

function assert(cond: boolean, msg = 'assertion failed'): void {
  if (!cond) throw new Error(msg);
}
