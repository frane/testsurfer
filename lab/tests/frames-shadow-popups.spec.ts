import { test, expect } from '@playwright/test';

test.describe('frames', () => {
  test('frameLocator into a same-origin iframe', async ({ page }) => {
    await page.goto('/frames/same-origin.html');
    const f = page.frameLocator('iframe[title="Inner"]');
    await f.getByLabel('Frame input').fill('lab');
    await f.getByRole('button', { name: 'Greet' }).click();
    await expect(f.locator('#o')).toHaveText('hi lab');
  });

  test('nested iframes', async ({ page }) => {
    await page.goto('/frames/nested.html');
    const deep = page.frameLocator('iframe[title="Middle"]').frameLocator('iframe[title="Deepest"]');
    await deep.getByRole('button', { name: 'Greet' }).click();
    await expect(deep.locator('#o')).toHaveText('hi ');
  });

  test('srcdoc iframe', async ({ page }) => {
    await page.goto('/frames/srcdoc.html');
    const f = page.frameLocator('iframe[title="Srcdoc"]');
    await f.getByRole('button').click();
    await expect(f.getByRole('button')).toHaveText('pressed');
  });

  test('frames() and frame.evaluate', async ({ page }) => {
    await page.goto('/frames/same-origin.html');
    await page.waitForLoadState();
    const frame = page.frames().find((f) => f.url().endsWith('/frames/inner.html'));
    expect(frame).toBeTruthy();
    expect(await frame!.evaluate(() => document.title)).toBe('inner');
  });

  test('a cross-origin iframe', async ({ page }) => {
    await page.goto('/frames/cross-origin.html');
    const f = page.frameLocator('iframe[title="Other origin"]');
    await f.getByLabel('Frame input').fill('x');
    await f.getByRole('button', { name: 'Greet' }).click();
    await expect(f.locator('#o')).toHaveText('hi x');
  });
});

test.describe('shadow DOM', () => {
  test('slotted content and shadow buttons', async ({ page }) => {
    await page.goto('/shadow/slots.html');
    await expect(page.getByRole('heading', { name: 'Slotted title' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Card action' })).toBeVisible();
  });

  test('a form inside a custom element', async ({ page }) => {
    await page.goto('/shadow/form.html');
    await page.getByLabel('User').fill('ada');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('hi ada')).toBeVisible();
  });
});

test.describe('popups', () => {
  test('window.open gives a popup with an opener', async ({ page }) => {
    await page.goto('/popups/opener.html');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Open window' }).click()]);
    await popup.waitForLoadState();
    await expect(popup.getByRole('heading')).toHaveText('Child window');
    await expect(popup.locator('#o')).toHaveText('has opener');
    expect(await popup.opener()).toBe(page);
  });

  test('target=_blank opens a new page in the context', async ({ page, context }) => {
    await page.goto('/popups/opener.html');
    const [child] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'New tab link' }).click()]);
    await child.waitForLoadState();
    await expect(child).toHaveURL(/child\.html$/);
    await expect(page).toHaveURL(/opener\.html$/);
  });

  test('a popup that closes itself', async ({ page }) => {
    await page.goto('/popups/opener.html');
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Open window' }).click()]);
    await popup.waitForLoadState();
    await Promise.all([popup.waitForEvent('close'), popup.getByRole('button', { name: 'Close me' }).click()]);
    expect(popup.isClosed()).toBe(true);
  });
});
