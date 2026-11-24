import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';

test.describe('page events', () => {
  test('download from a link and from a blob', async ({ page }) => {
    await page.goto('/page/download.html');
    const [d1] = await Promise.all([page.waitForEvent('download'), page.getByText('Download the report').click()]);
    expect(d1.suggestedFilename()).toBe('report.txt');
    expect(fs.readFileSync(await d1.path(), 'utf8')).toBe('lab report');
    const [d2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save a blob' }).click()]);
    expect(d2.suggestedFilename()).toBe('made.txt');
    expect(fs.readFileSync(await d2.path(), 'utf8')).toBe('made here');
  });

  test('load, domcontentloaded and framenavigated', async ({ page }) => {
    const seen: string[] = [];
    page.on('domcontentloaded', () => seen.push('dom'));
    page.on('load', () => seen.push('load'));
    page.on('framenavigated', (f) => seen.push('nav ' + new URL(f.url()).pathname));
    await page.goto('/page/nav-a.html');
    await expect.poll(() => seen.includes('load') && seen.includes('dom')).toBe(true);
    expect(seen).toContain('nav /page/nav-a.html');
  });
});
