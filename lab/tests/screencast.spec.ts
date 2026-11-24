import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('screencast frames, a video and annotations', async ({ page }) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-cast-')), 'cast.webm');
  let frames = 0;
  await page.goto('/actions/click.html');
  const cast = await page.screencast.start({ path: file, onFrame: () => { frames++; } });
  await page.screencast.showChapter('Clicking', { description: 'one button', duration: 300 });
  const overlay = await page.screencast.showOverlay('<b id="note">note</b>');
  await page.waitForTimeout(600);
  await overlay.dispose();
  await cast.dispose();
  expect(frames).toBeGreaterThan(0);
  expect(fs.statSync(file).size).toBeGreaterThan(1000);
  expect([...fs.readFileSync(file).subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
});
