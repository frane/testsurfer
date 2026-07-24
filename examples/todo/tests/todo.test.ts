/**
 * E2E tests for the todo app, written the way a testsurfer user would
 * write them: roles and labels, no CSS selectors, no manual waiting.
 */

import { before, after } from 'node:test';
import { test, expect } from 'testsurfer';
import { startServer } from '../app/server.js';

let app: Awaited<ReturnType<typeof startServer>>;

before(async () => {
  app = await startServer();
});

after(async () => {
  await app.close();
});

test('starts empty', async ({ page }) => {
  await page.goto(app.url);
  await expect(page).toHaveTitle('surf todos');
  await expect(page.getByRole('heading', { name: 'surf todos' })).toBeVisible();
  await expect(page.getByText('All clear. Add your first todo.')).toBeVisible();
  await expect(page.getByRole('listitem')).toHaveCount(0);
});

test('adds todos', async ({ page }) => {
  await page.goto(app.url);
  await page.getByLabel('New todo').fill('Buy milk');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('Buy milk').first()).toBeVisible();
  await expect(page.getByText('1 item left')).toBeVisible();

  await page.getByLabel('New todo').fill('Walk the dog');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByText('2 items left')).toBeVisible();
  await expect(page.getByText('All clear. Add your first todo.')).toBeHidden();
});

test('completes a todo and clears it', async ({ page }) => {
  await page.goto(app.url);
  for (const todo of ['Buy milk', 'Walk the dog']) {
    await page.getByLabel('New todo').fill(todo);
    await page.getByRole('button', { name: 'Add' }).click();
  }
  await expect(page.getByRole('listitem')).toHaveCount(2);

  await page.getByRole('checkbox', { name: 'Mark Buy milk done' }).click();
  await expect(page.getByText('1 item left')).toBeVisible();

  await page.getByRole('button', { name: 'Clear completed' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText('Buy milk')).toBeHidden();
  await expect(page.getByText('Walk the dog').first()).toBeVisible();
});

test('deletes a todo', async ({ page }) => {
  await page.goto(app.url);
  await page.getByLabel('New todo').fill('Buy milk');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);

  await page.getByRole('button', { name: 'Delete Buy milk' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(0);
  await expect(page.getByText('All clear. Add your first todo.')).toBeVisible();
});
