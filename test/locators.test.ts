/**
 * End-to-end coverage for the Playwright locator and matcher surface
 * beyond role/text/label: CSS and attribute locators, chaining,
 * filter, and/or, and the DOM-state matchers.
 */

import { after, before } from 'node:test';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { configure, expect, test } from '../src/index.ts';

const APP = `<!doctype html>
<html>
<head><title>Shop</title></head>
<body>
  <main>
    <h1>Cart</h1>
    <input placeholder="Search products" id="q">
    <input placeholder="Coupon code" readonly value="SAVE10">
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Store logo" width="10" height="10">
    <button title="Close cart">x</button>
    <ul class="items">
      <li class="item" data-testid="row-apple"><span>Apple</span> <button>Remove</button></li>
      <li class="item sale" data-testid="row-pear"><span>Pear</span> <button>Remove</button></li>
      <li class="item" data-testid="row-plum"><span>Plum</span> <button disabled>Remove</button></li>
    </ul>
    <div data-testid="summary"><p>3 items</p></div>
    <fieldset disabled><button>Checkout</button></fieldset>
    <button aria-disabled="true">Gift wrap</button>
    <button id="pay" class="btn primary">Pay</button>
  </main>
  <script>
    document.querySelector('.items').addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') e.target.closest('li').remove();
    });
  </script>
</body>
</html>`;

let server: http.Server;

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(APP);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  configure({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
});

after(() => server.close());

test.describe('locators', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('css, test id, placeholder, alt and title', async ({ page }) => {
    await expect(page.locator('li.item')).toHaveCount(3);
    await expect(page.locator('li.sale')).toContainText('Pear');
    await expect(page.getByTestId('row-plum')).toContainText('Plum');
    await expect(page.getByTestId(/^row-/)).toHaveCount(3);
    // A wrapper the tree does not report resolves to what is inside it.
    await expect(page.getByTestId('summary')).toHaveText('3 items');
    await page.getByPlaceholder('search').fill('kiwi');
    await expect(page.getByPlaceholder('Search products', { exact: true })).toHaveValue('kiwi');
    await expect(page.getByAltText('Store logo')).toBeVisible();
    await expect(page.getByTitle('Close cart')).toBeVisible();
  });

  test('chaining, filter, and/or, last', async ({ page }) => {
    const rows = page.getByRole('listitem');
    await expect(rows.filter({ hasText: 'Pear' })).toHaveCount(1);
    await expect(rows.filter({ hasNotText: 'Pear' })).toHaveCount(2);
    await expect(rows.filter({ has: page.getByRole('button', { name: 'Remove' }) })).toHaveCount(3);
    await expect(page.locator('li').last()).toContainText('Plum');
    await expect(page.locator('ul').getByRole('button')).toHaveCount(3);
    // The tree folds the span's text into its list item, so the span
    // resolves to the item.
    await expect(page.getByTestId('row-pear').locator('span')).toContainText('Pear');
    await expect(page.locator('li').and(page.locator('.sale'))).toHaveCount(1);
    await expect(page.getByTitle('Close cart').or(page.getByRole('button', { name: 'Pay' }))).toHaveCount(2);
    const all = await rows.all();
    if (all.length !== 3) throw new Error(`all() gave ${all.length}`);

    await rows.filter({ hasText: 'Apple' }).getByRole('button', { name: 'Remove' }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Pear');
  });

  test('enabled, editable, focused and attributes', async ({ page }) => {
    await expect(page.getByTestId('row-plum').getByRole('button')).toBeDisabled();
    await expect(page.getByTestId('row-pear').getByRole('button')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Checkout' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Gift wrap' })).toBeDisabled();
    await expect(page.getByPlaceholder('Search products')).toBeEditable();
    await expect(page.getByPlaceholder('Coupon code')).not.toBeEditable();

    const search = page.getByPlaceholder('Search products');
    await search.focus();
    await expect(search).toBeFocused();

    const pay = page.getByRole('button', { name: 'Pay' });
    await expect(pay).toHaveId('pay');
    await expect(pay).toHaveClass('btn primary');
    await expect(pay).toHaveClass(/primary/);
    await expect(pay).toHaveAttribute('class');
    await expect(pay).not.toHaveAttribute('disabled', undefined, { timeout: 300 });
    if ((await pay.getAttribute('id')) !== 'pay') throw new Error('getAttribute');
    await expect(page.locator('li.item')).toBeAttached();
    await expect(page.locator('.missing')).not.toBeAttached({ timeout: 300 });
  });
});
