import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test.describe('actions', () => {
  test('click is a trusted event', async ({ page }) => {
    await page.goto('/actions/click.html');
    await page.locator('#b').click();
    await page.locator('#b').click();
    await expect(page.locator('#b')).toHaveText('2');
    await expect(page.locator('#trust')).toHaveText('trusted');
  });

  test('dblclick', async ({ page }) => {
    await page.goto('/actions/dblclick.html');
    await page.locator('#d').dblclick();
    await expect(page.locator('#d')).toHaveText('double');
  });

  test('right click opens a context menu handler', async ({ page }) => {
    await page.goto('/actions/right-click.html');
    await page.locator('#t').click({ button: 'right' });
    await expect(page.locator('#t')).toHaveText('menu 2');
  });

  test('click with modifiers', async ({ page }) => {
    await page.goto('/actions/modifiers.html');
    await page.locator('#a').click({ modifiers: ['Shift', 'Alt'] });
    await expect(page.locator('#o')).toHaveText('shift+alt');
  });

  test('hover reveals a CSS :hover menu', async ({ page }) => {
    await page.goto('/actions/hover-menu.html');
    await expect(page.getByRole('link', { name: 'Sign out' })).toBeHidden();
    await page.getByText('Account').hover();
    await expect(page.getByRole('link', { name: 'Sign out' })).toBeVisible();
  });

  test('fill fires input events', async ({ page }) => {
    await page.goto('/actions/fill.html');
    await page.locator('#i').fill('hello');
    await page.locator('#t').fill('line one\nline two');
    await expect(page.locator('#out')).toHaveText('input:hello');
    await expect(page.locator('#t')).toHaveValue('line one\nline two');
  });

  test('fill and type into contenteditable', async ({ page }) => {
    await page.goto('/actions/contenteditable.html');
    await page.getByLabel('Editor').fill('Rich ');
    await page.getByLabel('Editor').pressSequentially('text');
    await expect(page.getByLabel('Editor')).toHaveText('Rich text');
  });

  test('Enter submits a form', async ({ page }) => {
    await page.goto('/actions/press-enter.html');
    await page.getByLabel('Query').fill('lab');
    await page.getByLabel('Query').press('Enter');
    await expect(page.locator('#o')).toHaveText('submitted lab');
  });

  test('check, uncheck, radio, switch', async ({ page }) => {
    await page.goto('/actions/check.html');
    await page.getByLabel('Agree').check();
    await expect(page.getByLabel('Agree')).toBeChecked();
    await page.getByLabel('Agree').uncheck();
    await expect(page.getByLabel('Agree')).not.toBeChecked();
    await page.getByRole('radio', { name: 'Large' }).check();
    await expect(page.getByRole('radio', { name: 'Small' })).not.toBeChecked();
    await page.getByRole('switch', { name: 'Dark mode' }).setChecked(true);
    await expect(page.getByRole('switch')).toBeChecked();
  });

  test('selectOption by label, value, several', async ({ page }) => {
    await page.goto('/actions/select.html');
    await page.getByLabel('Color').selectOption('Blue');
    await expect(page.getByLabel('Color')).toHaveValue('Blue');
    await page.getByLabel('Color').selectOption({ value: 'g' });
    await expect(page.getByLabel('Color')).toHaveValue('g');
    await page.getByLabel('Tags').selectOption(['a', 'c']);
    await expect(page.getByLabel('Tags')).toHaveValues(['a', 'c']);
  });

  test('setInputFiles from disk and from a buffer', async ({ page }) => {
    await page.goto('/actions/upload.html');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-')), 'note.txt');
    fs.writeFileSync(file, 'hello');
    await page.getByLabel('Files').setInputFiles(file);
    await expect(page.locator('#o')).toHaveText('note.txt:5');
    await page.getByLabel('Files').setInputFiles([
      { name: 'a.json', mimeType: 'application/json', buffer: Buffer.from('{"a":1}') },
      { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') },
    ]);
    await expect(page.locator('#o')).toHaveText('a.json:7,b.txt:2');
  });

  test('dragTo fires the HTML5 drag events', async ({ page }) => {
    await page.goto('/actions/drag.html');
    await page.getByText('second').dragTo(page.locator('#drop'));
    await expect(page.locator('#drop')).toHaveText('dropped y');
  });

  test('click waits until an overlay is gone', async ({ page }) => {
    await page.goto('/actions/covered.html');
    await page.getByRole('button', { name: 'Under' }).click();
    await expect(page.getByRole('button')).toHaveText('clicked');
  });

  test('click scrolls inside a scroll container', async ({ page }) => {
    await page.goto('/actions/scroll-container.html');
    await page.getByRole('button', { name: 'Far away' }).click();
    await expect(page.getByRole('button')).toHaveText('reached');
  });

  test('focus and blur', async ({ page }) => {
    await page.goto('/actions/focus-blur.html');
    await page.getByLabel('A').focus();
    await expect(page.locator('#o')).toHaveText('a focused');
    await expect(page.getByLabel('A')).toBeFocused();
    await page.getByLabel('A').blur();
    await expect(page.locator('#o')).toHaveText('a blurred');
  });

  test('click waits for a disabled button to enable', async ({ page }) => {
    await page.goto('/actions/disabled-waits.html');
    await page.getByRole('button', { name: 'Go' }).click();
    await expect(page.getByRole('button')).toHaveText('ran');
  });
});
