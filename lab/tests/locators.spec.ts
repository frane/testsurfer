import { test, expect } from '@playwright/test';

test.describe('locators', () => {
  test('getByRole with name, exact and substring', async ({ page }) => {
    await page.goto('/locators/role-name.html');
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveText('Save');
    await expect(page.getByRole('link', { name: 'Save link' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  });

  test('getByLabel: for, wrapping, aria-labelledby', async ({ page }) => {
    await page.goto('/locators/label-for.html');
    await expect(page.getByLabel('Email')).toHaveAttribute('id', 'e');
    await expect(page.getByLabel('Name')).toHaveAttribute('id', 'n');
    await expect(page.getByLabel('Phone')).toHaveAttribute('id', 'p');
  });

  test('aria-label names', async ({ page }) => {
    await page.goto('/locators/aria-label.html');
    await expect(page.getByRole('button', { name: 'Close dialog' })).toHaveText('×');
    await expect(page.getByLabel('Search the site')).toBeVisible();
  });

  test('getByPlaceholder', async ({ page }) => {
    await page.goto('/locators/placeholder.html');
    await page.getByPlaceholder('Your email').fill('a@b.co');
    await expect(page.getByPlaceholder('Your email')).toHaveValue('a@b.co');
    await expect(page.getByPlaceholder('Comment')).toBeEditable();
  });

  test('getByAltText and getByTitle', async ({ page }) => {
    await page.goto('/locators/alt-title.html');
    await expect(page.getByAltText('Company logo')).toBeAttached();
    await expect(page.getByTitle('Due date')).toHaveText('Fri');
  });

  test('getByTestId scopes a chain', async ({ page }) => {
    await page.goto('/locators/test-id.html');
    await expect(page.getByTestId('cart').getByRole('button', { name: 'Remove' })).toHaveCount(1);
  });

  test('getByText: substring, exact, RegExp', async ({ page }) => {
    await page.goto('/locators/text.html');
    await expect(page.getByText('hello world')).toHaveCount(2);
    await expect(page.getByText('Hello World', { exact: true })).toHaveCount(1);
    await expect(page.getByText(/total: \d+ items/i)).toBeVisible();
  });

  test('CSS pierces open shadow roots', async ({ page }) => {
    await page.goto('/locators/css-shadow.html');
    await expect(page.locator('button.inner')).toHaveText('Inside shadow');
    await expect(page.locator('.deep')).toHaveText('Deep text');
    await expect(page.getByRole('button', { name: 'Inside shadow' })).toBeVisible();
  });

  test('XPath', async ({ page }) => {
    await page.goto('/locators/xpath.html');
    await expect(page.locator('xpath=//li[@class="pick"]')).toHaveText('two');
    await expect(page.locator('//li')).toHaveCount(3);
  });

  test('first, last, nth', async ({ page }) => {
    await page.goto('/locators/nth.html');
    const items = page.getByRole('listitem');
    await expect(items.first()).toHaveText('a');
    await expect(items.last()).toHaveText('d');
    await expect(items.nth(2)).toHaveText('c');
  });

  test('filter by text, by child, visible', async ({ page }) => {
    await page.goto('/locators/filter.html');
    const rows = page.getByRole('listitem');
    await expect(rows.filter({ hasText: 'Banana' }).getByRole('button')).toHaveText('Buy');
    await expect(rows.filter({ has: page.getByRole('button', { name: 'Sold out' }) })).toContainText('Cherry');
    await expect(rows.filter({ hasNotText: 'Apple' })).toHaveCount(2);
  });

  test('and / or', async ({ page }) => {
    await page.goto('/locators/and-or.html');
    await expect(page.getByRole('button').and(page.locator('.primary'))).toHaveText('Go');
    await expect(page.getByRole('button', { name: 'Go too' }).or(page.getByRole('link'))).toHaveCount(2);
  });

  test('strict mode reports every match', async ({ page }) => {
    await page.goto('/locators/strict.html');
    const err = await page.getByRole('button', { name: 'Delete' }).click({ timeout: 1000 }).catch((e: Error) => e);
    expect(String(err)).toContain('strict mode violation');
  });

  test('hidden elements are skipped by role, counted by CSS', async ({ page }) => {
    await page.goto('/locators/hidden.html');
    await expect(page.getByRole('button')).toHaveCount(1);
    await expect(page.locator('button')).toHaveCount(3);
    await expect(page.locator('button:visible')).toHaveText('Visible');
  });
});
