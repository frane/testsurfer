import { test, expect, request } from '@playwright/test';

test('consoleMessages, pageErrors and requests', async ({ page }) => {
  await page.goto('/page/nav-a.html');
  await page.evaluate(() => { console.log('one'); console.warn('two'); setTimeout(() => { throw new Error('boom'); }, 0); });
  await expect.poll(async () => (await page.pageErrors()).map((e) => e.message)).toContain('boom');
  const msgs = await page.consoleMessages();
  expect(msgs.map((m) => m.text())).toEqual(expect.arrayContaining(['one', 'two']));
  expect(msgs.find((m) => m.text() === 'two')!.type()).toBe('warning');
  await page.evaluate(() => fetch('/api/items'));
  await expect.poll(async () => (await page.requests()).some((r) => r.url().endsWith('/api/items'))).toBe(true);
});

test('page.localStorage and sessionStorage', async ({ page }) => {
  await page.goto('/page/storage.html');
  await page.localStorage.setItem('k', 'v');
  expect(await page.localStorage.getItem('k')).toBe('v');
  expect(await page.evaluate(() => localStorage.getItem('k'))).toBe('v');
  await page.sessionStorage.setItem('s', '1');
  expect((await page.sessionStorage.items()).find((i) => i.name === 's')?.value).toBe('1');
  await page.localStorage.clear();
  expect(await page.localStorage.items()).toEqual([]);
});

test('request.newContext keeps its own cookies', async () => {
  const base = `http://127.0.0.1:${process.env.LAB_PORT ?? 4173}`;
  const api = await request.newContext({ baseURL: base });
  await api.get('/set-cookie');
  const echoed = await (await api.get('/cookies')).json();
  expect(echoed.cookie).toContain('lab=1');
  const state = await api.storageState();
  expect(state.cookies.map((c) => c.name)).toContain('lab');
  await api.dispose();
});

test('locator.normalize and locator.drop', async ({ page }) => {
  await page.goto('/page/dropzone.html');
  const n = await page.locator('#zone').normalize();
  await expect(n).toHaveText('Drop here');
  await page.locator('#zone').drop({ files: { name: 'n.txt', mimeType: 'text/plain', buffer: Buffer.from('hey') }, data: { 'text/plain': 'plain' } });
  await expect(page.locator('#out')).toHaveText('n.txt:hey|plain');
});
