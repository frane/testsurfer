import { test, expect } from '@playwright/test';

test.describe('context options', () => {
  test.use({ colorScheme: 'dark', locale: 'de-DE', timezoneId: 'Asia/Tokyo', userAgent: 'LabAgent/1.0' });

  test('colorScheme, locale, timezoneId and userAgent from test.use', async ({ page }) => {
    await page.goto('/network/headers.html');
    expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
    expect(await page.evaluate(() => navigator.language)).toBe('de-DE');
    expect(await page.evaluate(() => (1234.5).toLocaleString())).toBe('1.234,5');
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe('Asia/Tokyo');
    expect(await page.evaluate(() => new Date(Date.UTC(2024, 0, 1, 0, 0)).getHours())).toBe(9);
    expect(await page.evaluate(() => new Date(2024, 0, 1, 9, 0).toISOString())).toBe('2024-01-01T00:00:00.000Z');
    expect(await page.evaluate(() => new Date(Date.UTC(2024, 0, 1)).getTimezoneOffset())).toBe(-540);
    expect(await page.evaluate(() => navigator.userAgent)).toBe('LabAgent/1.0');
    const sent = await page.evaluate(async () => (await fetch('/api/echo-headers')).json());
    expect(sent['user-agent']).toBe('LabAgent/1.0');
    expect(sent['accept-language']).toContain('de-DE');
  });
});

test.describe('context methods', () => {
  test('geolocation with a granted permission', async ({ browser }) => {
    const context = await browser.newContext({ geolocation: { latitude: 52.52, longitude: 13.4 }, permissions: ['geolocation'] });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:' + (process.env.LAB_PORT ?? 4173) + '/network/headers.html');
    const pos = await page.evaluate(() => new Promise<number[]>((ok, err) => navigator.geolocation.getCurrentPosition((p) => ok([p.coords.latitude, p.coords.longitude]), err)));
    expect(pos).toEqual([52.52, 13.4]);
    await context.setGeolocation({ latitude: 1, longitude: 2 });
    await page.reload();
    const moved = await page.evaluate(() => new Promise<number>((ok, err) => navigator.geolocation.getCurrentPosition((p) => ok(p.coords.latitude), err)));
    expect(moved).toBe(1);
    await context.close();
  });

  test('setOffline fails requests and flips navigator.onLine', async ({ page, context }) => {
    await page.goto('/network/fetcher.html');
    await context.setOffline(true);
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    const failed = await page.evaluate(() => fetch('/api/items').then(() => 'ok', () => 'failed'));
    expect(failed).toBe('failed');
    await context.setOffline(false);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    expect(await page.evaluate(() => fetch('/api/items').then((r) => r.status))).toBe(200);
  });

  test('httpCredentials answer a basic auth challenge', async ({ browser }) => {
    const context = await browser.newContext({ httpCredentials: { username: 'lab', password: 'secret' } });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:' + (process.env.LAB_PORT ?? 4173) + '/basic-auth');
    await expect(page.locator('#who')).toHaveText('signed in');
    await context.close();
  });

  test('javaScriptEnabled false runs no page script', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:' + (process.env.LAB_PORT ?? 4173) + '/page/timer.html');
    await page.waitForTimeout(900);
    await expect(page.locator('#o')).toHaveText('wait');
    await context.close();
  });

  test('exposeFunction on the context reaches its pages', async ({ page, context }) => {
    await context.exposeFunction('labAdd', (a: number, b: number) => a + b);
    await page.goto('/network/headers.html');
    expect(await page.evaluate(() => (window as unknown as { labAdd: (a: number, b: number) => Promise<number> }).labAdd(2, 3))).toBe(5);
  });

  test('extraHTTPHeaders and hasTouch from newContext', async ({ browser }) => {
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-lab': 'ctx' }, hasTouch: true });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:' + (process.env.LAB_PORT ?? 4173) + '/network/headers.html');
    const sent = await page.evaluate(async () => (await fetch('/api/echo-headers')).json());
    expect(sent['x-lab']).toBe('ctx');
    expect(await page.evaluate(() => 'ontouchstart' in window)).toBe(true);
    await context.close();
  });

  test('browser version and connection', async ({ browser }) => {
    expect(browser.version()).toBeTruthy();
    expect(browser.isConnected()).toBe(true);
  });
});

test.describe('mobile', () => {
  test('isMobile lays a page without a viewport tag out 980 px wide', async ({ browser }) => {
    const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 664 } } as never);
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 664 });
    await page.goto('http://127.0.0.1:' + (process.env.LAB_PORT ?? 4173) + '/actions/click.html');
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(980);
    await page.setContent('<meta name="viewport" content="width=device-width"><button onclick="this.textContent=\'hit\'" style="margin-left:300px">go</button>');
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(390);
    await page.getByRole('button').click();
    await expect(page.getByRole('button')).toHaveText('hit');
    await context.close();
  });
});
