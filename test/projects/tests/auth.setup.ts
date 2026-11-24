import { test as setup } from '@playwright/test';
setup('log in', async ({ page }) => {
  await page.setContent('<p>x</p>');
  await page.context().addCookies([{ name: 'who', value: 'ada', url: 'https://example.test/' }]);
  await page.context().storageState({ path: 'state.json' });
});
