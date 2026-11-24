import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('recordHar writes the exchanges; routeFromHAR answers from them', async ({ browser }, testInfo) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-har-')), 'items.har');
  const base = `http://127.0.0.1:${process.env.LAB_PORT ?? 4173}`;
  const rec = await browser.newContext({ recordHar: { path: file, urlFilter: '**/api/**' } });
  const p1 = await rec.newPage();
  await p1.goto(base + '/network/fetcher.html');
  await p1.getByRole('button', { name: 'Load' }).click();
  await expect(p1.getByRole('listitem')).toHaveCount(3);
  await rec.close();
  const har = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = har.log.entries.find((e: { request: { url: string } }) => e.request.url.endsWith('/api/items'));
  expect(entry).toBeTruthy();
  expect(entry.response.content.text).toContain('alpha');
  entry.response.content.text = JSON.stringify({ items: ['from', 'the', 'har', 'file'] });
  fs.writeFileSync(file, JSON.stringify(har));

  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await p2.routeFromHAR(file, { url: '**/api/**' });
  await p2.goto(base + '/network/fetcher.html');
  await p2.getByRole('button', { name: 'Load' }).click();
  await expect(p2.getByRole('listitem')).toHaveCount(4);
  await ctx.close();
  void testInfo;
});
