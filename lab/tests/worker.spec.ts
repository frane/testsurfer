import { test, expect } from '@playwright/test';

test('worker events and worker.evaluate', async ({ page }) => {
  await page.goto('/page/nav-a.html');
  const [worker] = await Promise.all([
    page.waitForEvent('worker'),
    page.evaluate(() => { (window as any).w = new Worker('/page/worker.js'); }),
  ]);
  expect(worker.url()).toContain('/page/worker.js');
  await expect.poll(() => worker.evaluate(() => (self as any).counter + 1)).toBe(42);
  expect(page.workers().length).toBe(1);
  const reply = await page.evaluate(() => new Promise((r) => { (window as any).w.onmessage = (e: MessageEvent) => r(e.data); (window as any).w.postMessage('hi'); }));
  expect(reply).toBe('worker got hi');
});
