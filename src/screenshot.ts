/**
 * toHaveScreenshot: compare a fresh PNG against a stored baseline.
 *
 * Baselines live next to the test file, in `<file>-snapshots/`, named
 * after the test (or the name given) plus the OS, since text renders
 * differently per platform: `checkout-1-darwin.png`. A missing
 * baseline is written and fails the test once, so the first run
 * records it and a reviewer sees it; TESTSURFER_UPDATE_SNAPSHOTS=1
 * rewrites them all.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TimeoutError } from './errors.ts';
import { decodePng, diffImages, encodePng, type Image } from './png.ts';
import { currentTestInfo } from './testinfo.ts';

export interface ScreenshotOptions {
  timeout?: number;
  /** Per-channel difference (0-1) a pixel may have and still match. Default 0.2. */
  threshold?: number;
  /** Changed pixels allowed. Default 0. */
  maxDiffPixels?: number;
  /** Changed pixels allowed, as a share of all pixels (0-1). Default 0. */
  maxDiffPixelRatio?: number;
  /** Page screenshots only: capture the whole scrollable page. */
  fullPage?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'screenshot';

function baselinePath(name: string | undefined): { file: string; label: string; outputDir: string } {
  const info = currentTestInfo();
  if (!name && !info) throw new Error('toHaveScreenshot needs a name when used outside the testsurfer runner');
  let base = name ?? `${safe(info!.title)}-${++info!.snapshotIndex}`;
  base = base.replace(/\.png$/i, '');
  const testFile = info?.file ?? process.argv[1] ?? 'test';
  const dir = path.join(path.dirname(testFile), `${path.basename(testFile)}-snapshots`);
  return {
    file: path.join(dir, `${safe(base)}-${process.platform}.png`),
    label: base,
    outputDir: info?.outputDir ?? 'test-results',
  };
}

/** Capture until two shots in a row are identical (animations settled) or the budget runs out. */
async function stableShot(capture: () => Promise<Buffer>, deadline: number): Promise<Buffer> {
  let prev = await capture();
  while (Date.now() < deadline) {
    await sleep(100);
    const next = await capture();
    if (next.equals(prev)) return next;
    prev = next;
  }
  return prev;
}

export async function assertScreenshot(
  capture: () => Promise<Buffer>,
  name: string | undefined,
  options: ScreenshotOptions,
  budget: number,
  target: string,
): Promise<void> {
  const { file, label, outputDir } = baselinePath(name);
  const mode = currentTestInfo()?.updateSnapshots ?? 'missing';
  const deadline = Date.now() + budget;
  const exists = fs.existsSync(file);

  if (mode === 'all' || !exists) {
    const shot = await stableShot(capture, deadline);
    if (!exists && mode === 'none') {
      throw new Error(`${target}: no screenshot baseline at ${file} (updateSnapshots is none)`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, shot);
    if (mode === 'all') return;
    throw new Error(`${target}: no screenshot baseline; wrote ${file}. Check it in and run again.`);
  }

  const expected = decodePng(fs.readFileSync(file));
  const threshold = options.threshold ?? 0.2;
  const total = expected.width * expected.height;
  const allowed = Math.max(options.maxDiffPixels ?? 0, Math.floor((options.maxDiffPixelRatio ?? 0) * total));
  let last: { actual: Image; buf: Buffer; diffPixels: number; diff: Image | null } | null = null;
  for (;;) {
    const buf = await capture();
    const actual = decodePng(buf);
    if (actual.width === expected.width && actual.height === expected.height) {
      const d = diffImages(expected, actual, threshold);
      if (d.diffPixels <= allowed) return;
      last = { actual, buf, diffPixels: d.diffPixels, diff: d.diff };
    } else {
      last = { actual, buf, diffPixels: -1, diff: null };
    }
    if (Date.now() >= deadline) break;
    await sleep(100);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const actualFile = path.join(outputDir, `${safe(label)}-actual.png`);
  fs.writeFileSync(actualFile, last.buf);
  let detail: string;
  if (last.diff) {
    const diffFile = path.join(outputDir, `${safe(label)}-diff.png`);
    fs.writeFileSync(diffFile, encodePng(last.diff));
    detail = `${last.diffPixels} of ${total} pixels differ (allowed ${allowed}); diff: ${diffFile}`;
  } else {
    detail = `size ${last.actual.width}x${last.actual.height}, expected ${expected.width}x${expected.height}`;
  }
  throw new TimeoutError(`${target} does not match ${file}: ${detail}; actual: ${actualFile} (waited ${budget}ms)`);
}
