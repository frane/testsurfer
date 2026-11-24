import { test, expect } from '@playwright/test';
test('starts logged in, with the project settings', async ({ page, context }) => {
  expect((await context.cookies()).map((c) => c.name)).toContain('who');
  const mobile = test.info().project.name === 'mobile';
  await page.setContent('<p>x</p>');
  expect(await page.evaluate(() => navigator.userAgent.includes('iPhone'))).toBe(mobile);
});
