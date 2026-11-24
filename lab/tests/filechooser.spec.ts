import { test, expect } from '@playwright/test';

test('filechooser from a button that clicks the input', async ({ page }) => {
  await page.goto('/page/upload.html');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Choose files' }).click()]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
    { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('b') },
  ]);
  await expect(page.locator('#names')).toHaveText('a.txt,b.txt');
});
