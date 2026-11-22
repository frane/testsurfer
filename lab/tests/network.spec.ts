import { test, expect } from '@playwright/test';

test.describe('network', () => {
  test('route.fulfill with JSON', async ({ page }) => {
    await page.route('**/api/items', (route) => route.fulfill({ json: { items: ['mocked'] } }));
    await page.goto('/network/fetcher.html');
    await page.getByRole('button', { name: 'Load' }).click();
    await expect(page.getByRole('listitem')).toHaveText(['mocked']);
  });

  test('route.fetch and modify the response', async ({ page }) => {
    await page.route('**/api/items', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({ response: res, json: { items: [...body.items, 'extra'] } });
    });
    await page.goto('/network/fetcher.html');
    await page.getByRole('button', { name: 'Load' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(4);
  });

  test('route.abort', async ({ page }) => {
    await page.route('**/api/items', (route) => route.abort());
    await page.goto('/network/fetcher.html');
    await page.getByRole('button', { name: 'Load' }).click();
    await expect(page.locator('#err')).toHaveText('failed');
  });

  test('route.continue with an added header', async ({ page }) => {
    await page.route('**/api/echo-headers', (route) => route.continue({ headers: { ...route.request().headers(), 'x-lab': 'yes' } }));
    await page.goto('/network/headers.html');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('#o')).toHaveText('yes');
  });

  test('setExtraHTTPHeaders', async ({ page }) => {
    await page.setExtraHTTPHeaders({ 'x-lab': 'extra' });
    await page.goto('/network/headers.html');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('#o')).toHaveText('extra');
  });

  test('waitForResponse and request events', async ({ page }) => {
    await page.goto('/network/fetcher.html');
    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.url()));
    const [res] = await Promise.all([page.waitForResponse('**/api/items'), page.getByRole('button', { name: 'Load' }).click()]);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ items: ['alpha', 'bravo', 'charlie'] });
    expect(seen.some((u) => u.endsWith('/api/items'))).toBe(true);
  });

  test('a routed document', async ({ page }) => {
    await page.route('**/network/virtual.html', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>Made up</h1>' }));
    await page.goto('/network/virtual.html');
    await expect(page.getByRole('heading')).toHaveText('Made up');
  });

  test('an aborted image', async ({ page }) => {
    await page.route('**/*.png', (route) => route.abort());
    await page.goto('/network/image.html');
    await expect(page.locator('#o')).toHaveText('error');
  });

  test('goto follows redirects and returns the final response', async ({ page }) => {
    const res = await page.goto('/redirect');
    expect(res!.url()).toMatch(/\/network\/landed\.html$/);
    expect(res!.request().redirectedFrom()?.url()).toMatch(/\/redirect-2$/);
    await expect(page.getByRole('heading')).toHaveText('Landed');
  });

  test('cookies set by the server, and context.addCookies', async ({ page, context }) => {
    await context.addCookies([{ name: 'pre', value: 'set', url: `http://lab.localhost:${process.env.LAB_PORT ?? 4173}/` }]);
    await page.goto('/network/cookie.html');
    await page.getByRole('button', { name: 'Cookie' }).click();
    await expect(page.locator('#o')).toContainText('lab=1');
    await expect(page.locator('#o')).toContainText('pre=set');
  });
});
