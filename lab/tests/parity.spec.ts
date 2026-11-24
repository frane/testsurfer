import { test, expect } from '@playwright/test';

const port = Number(process.env.LAB_PORT ?? 4173);

test.describe('parity', () => {
  test('route an image on a loopback host', async ({ page }) => {
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    await page.route('**/parity/missing.png', (route) => route.fulfill({ contentType: 'image/gif', body: pixel }));
    const seen = page.waitForRequest('**/parity/missing.png');
    await page.goto('/parity/image.html');
    await seen;
    await expect(page.locator('#state')).toHaveText('loaded 1');
  });

  test('mouse.wheel is a trusted wheel that scrolls the box', async ({ page }) => {
    await page.goto('/parity/wheel.html');
    await page.mouse.move(150, 100);
    await page.mouse.wheel(0, 300);
    await expect(page.locator('#log')).toHaveText('trusted down');
    await expect.poll(() => page.locator('#box').evaluate((b) => b.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('page.request shares the context cookies, both ways', async ({ page, context }) => {
    await page.goto('/network/cookie.html');
    await context.addCookies([{ name: 'from_test', value: '1', url: new URL('/', page.url()).href }]);
    const echoed = await (await page.request.get('/cookies')).json();
    expect(echoed.cookie).toContain('from_test=1');
    await page.request.get('/set-cookie');
    expect((await context.cookies()).map((c) => c.name)).toContain('lab');
    expect(await page.evaluate(() => document.cookie)).toContain('lab=1');
  });

  test('cookies, clearCookies and an HttpOnly cookie', async ({ page, context }) => {
    await page.goto('/network/cookie.html');
    await context.addCookies([
      { name: 'ho', value: 'x', url: page.url(), httpOnly: true },
      { name: 'js', value: 'y', url: page.url() },
    ]);
    const jar = await context.cookies(page.url());
    expect(jar.find((c) => c.name === 'ho')?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain('ho=');
    await context.clearCookies({ name: 'js' });
    expect((await context.cookies()).map((c) => c.name)).toEqual(['ho']);
    await context.clearCookies();
    expect(await context.cookies()).toEqual([]);
  });

  test('storageState carries cookies and localStorage to a new context', async ({ page, context, browser }) => {
    await page.goto('/page/storage.html');
    await page.evaluate(() => localStorage.setItem('kept', 'yes'));
    await context.addCookies([{ name: 'kept', value: 'yes', url: page.url() }]);
    const state = await context.storageState();
    const next = await browser.newContext({ storageState: state });
    const p2 = await next.newPage();
    await p2.goto(page.url());
    expect(await p2.evaluate(() => localStorage.getItem('kept'))).toBe('yes');
    expect(await p2.evaluate(() => document.cookie)).toContain('kept=yes');
    await next.close();
  });

  test('emulateMedia reaches a cross-origin stylesheet', async ({ page }) => {
    await page.goto('/parity/media.html');
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(bg).toBe('rgb(255, 255, 255)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(bg).toBe('rgb(0, 0, 0)');
  });

  test('emulateMedia contrast', async ({ page }) => {
    await page.goto('/parity/media.html');
    await page.emulateMedia({ contrast: 'more' });
    expect(await page.evaluate(() => matchMedia('(prefers-contrast: more)').matches)).toBe(true);
    await page.emulateMedia({ contrast: 'no-preference' });
    expect(await page.evaluate(() => matchMedia('(prefers-contrast: more)').matches)).toBe(false);
  });

  test('a response the service worker builds is reported', async ({ page }) => {
    // A non-loopback name: WebKit on macOS gives loopback pages no service workers under interception.
    await page.goto(`http://sw.localhost:${port}/parity/sw.html`);
    await expect(page.locator('#state')).toHaveText('ready');
    const res = page.waitForResponse('**/parity/built');
    expect(await page.evaluate(() => (window as unknown as { ask: () => Promise<string> }).ask())).toBe('from the worker');
    const r = await res;
    expect(r.fromServiceWorker()).toBe(true);
    expect(await r.text()).toBe('from the worker');
  });
});

const withWorker = test.extend<object, { runId: number }>({
  runId: [async ({}, use) => use(Math.random()), { scope: 'worker' }],
});

let firstRun = 0;
withWorker.describe.serial('worker fixtures', () => {
  withWorker('first test sees the worker value', async ({ runId }) => {
    firstRun = runId;
    expect(runId).toBeGreaterThan(0);
  });
  withWorker('second test sees the same value', async ({ runId }) => {
    expect(runId).toBe(firstRun);
  });
});
