import { test, expect } from '@playwright/test';

test.describe('clock', () => {
  test('install, fastForward and runFor drive timers and Date', async ({ page }) => {
    await page.clock.install({ time: new Date('2024-02-02T08:00:00Z') });
    await page.goto('/page/timer5.html');
    expect(await page.evaluate(() => new Date().toISOString())).toMatch(/^2024-02-02T08:00:0/);
    await expect(page.locator('#o')).toHaveText('wait');
    await page.clock.runFor(5100);
    await expect(page.locator('#o')).toHaveText('ready');
    await page.clock.fastForward('01:00:00');
    expect(await page.evaluate(() => new Date().toISOString())).toMatch(/^2024-02-02T09:00:/);
  });

  test('pauseAt holds time, resume lets it run', async ({ page }) => {
    await page.goto('/page/timer.html');
    await page.clock.pauseAt(new Date('2030-01-01T00:00:00Z'));
    const a = await page.evaluate(() => Date.now());
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => Date.now())).toBe(a);
    await page.clock.resume();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => Date.now())).toBeGreaterThan(a);
  });

  test('setFixedTime and setSystemTime', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2020-05-05T00:00:00Z'));
    await page.goto('/page/timer.html');
    expect(await page.evaluate(() => new Date().toISOString())).toBe('2020-05-05T00:00:00.000Z');
    await expect(page.locator('#o')).toHaveText('ready');
  });
});
