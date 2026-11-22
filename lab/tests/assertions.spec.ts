import { test, expect } from '@playwright/test';

test.describe('assertions', () => {
  test('value, enabled, editable, checked, empty', async ({ page }) => {
    await page.goto('/assertions/state.html');
    await expect(page.getByLabel('Value')).toHaveValue('preset');
    await expect(page.getByRole('button', { name: 'Off' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'On' })).toBeEnabled();
    await expect(page.getByLabel('Read only')).not.toBeEditable();
    await expect(page.getByLabel('Box')).toBeChecked();
    await expect(page.locator('#e')).toBeEmpty();
  });

  test('attribute, class, CSS, id, JS property', async ({ page }) => {
    await page.goto('/assertions/state.html');
    const p = page.locator('#cls');
    await expect(p).toHaveAttribute('data-x', '1');
    await expect(p).toHaveClass(/\bb\b/);
    await expect(p).toContainClass('c');
    await expect(p).toHaveCSS('color', 'rgb(255, 0, 0)');
    await expect(p).toHaveId('cls');
    await expect(page.getByLabel('Value')).toHaveJSProperty('value', 'preset');
  });

  test('toHaveText with arrays and normalized whitespace', async ({ page }) => {
    await page.goto('/assertions/text-list.html');
    await expect(page.getByRole('listitem')).toHaveText(['One', 'Two', 'Three']);
    await expect(page.getByRole('listitem')).toContainText(['Tw']);
    await expect(page.locator('#ws')).toHaveText('spaced out text');
  });

  test('page title and URL', async ({ page }) => {
    await page.goto('/assertions/title-url.html');
    await expect(page).toHaveTitle('Lab title');
    await expect(page).toHaveURL(/tab=2$/);
  });

  test('toBeInViewport', async ({ page }) => {
    await page.goto('/assertions/viewport.html');
    await expect(page.locator('#far')).not.toBeInViewport();
    await page.locator('#far').scrollIntoViewIfNeeded();
    await expect(page.locator('#far')).toBeInViewport();
  });

  test('accessible name, description, role', async ({ page }) => {
    await page.goto('/assertions/a11y.html');
    await expect(page.getByRole('button')).toHaveAccessibleName('Pay');
    await expect(page.getByRole('button')).toHaveAccessibleDescription('Charges your card');
    await expect(page.locator('nav')).toHaveRole('navigation');
  });

  test('toMatchAriaSnapshot', async ({ page }) => {
    await page.goto('/assertions/a11y.html');
    await expect(page.locator('body')).toMatchAriaSnapshot(`
      - button "Pay"
      - navigation "Main":
        - link "Home"
    `);
  });

  test('expect.poll and soft assertions', async ({ page }) => {
    await page.goto('/assertions/state.html');
    await expect.poll(() => page.evaluate(() => document.title)).toBe('state');
    expect.soft(1 + 1).toBe(2);
  });

  test('a failed assertion names the locator and the value', async ({ page }) => {
    await page.goto('/assertions/state.html');
    const err = await expect(page.getByLabel('Value')).toHaveValue('other', { timeout: 300 }).catch((e: Error) => e);
    expect(String(err)).toContain('toHaveValue');
    expect(String(err)).toContain('preset');
  });
});

test.describe('dynamic pages', () => {
  test('an element that appears later', async ({ page }) => {
    await page.goto('/dynamic/appears.html');
    await page.getByRole('button', { name: 'Late button' }).click();
    await expect(page.locator('#o')).toHaveText('loaded');
  });

  test('clicks land while the element is re-rendered', async ({ page }) => {
    await page.goto('/dynamic/rerender.html');
    await page.getByRole('button', { name: /Again/ }).click();
    expect(await page.evaluate(() => (window as unknown as { hits: number }).hits)).toBe(1);
  });

  test('a list that grows', async ({ page }) => {
    await page.goto('/dynamic/list-load.html');
    await expect(page.getByRole('listitem')).toHaveCount(5);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(10);
  });

  test('debounced search results', async ({ page }) => {
    await page.goto('/dynamic/debounce.html');
    await page.getByLabel('Search').pressSequentially('lab');
    await expect(page.getByRole('listitem')).toHaveText('result for lab');
  });

  test('client-side routing', async ({ page }) => {
    await page.goto('/dynamic/spa.html');
    await page.getByRole('link', { name: 'About' }).click();
    await expect(page).toHaveURL(/p=about/);
    await expect(page.getByRole('main')).toHaveText('About page');
  });

  test('content from fetch', async ({ page }) => {
    await page.goto('/dynamic/fetch-render.html');
    await page.getByRole('button', { name: 'Fetch' }).click();
    await expect(page.getByRole('listitem')).toHaveText(['alpha', 'bravo', 'charlie']);
  });

  test('waitFor detached', async ({ page }) => {
    await page.goto('/dynamic/detach.html');
    await page.locator('#b').waitFor({ state: 'detached' });
    await expect(page.locator('#b')).toHaveCount(0);
  });
});
