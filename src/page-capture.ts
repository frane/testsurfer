/**
 * Screenshot pixels: vibesurfer captures the viewport at the screen's
 * scale; these crop to an element box and scale to the page's device
 * scale factor, as Playwright delivers screenshots.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { BoundingBox } from './locator-options.ts';
import { decodePng, downscale, encodePng } from './png.ts';

/** The crop of a viewport capture around `box` (CSS px), at device scale `dpr`. */
export function cropToBox(capture: Buffer, cssWidth: number, box: BoundingBox, dpr: number): Buffer {
  const img = decodePng(capture);
  const scale = img.width / (cssWidth || img.width);
  const x0 = Math.max(0, Math.floor(box.x * scale));
  const y0 = Math.max(0, Math.floor(box.y * scale));
  const x1 = Math.min(img.width, Math.ceil((box.x + box.width) * scale));
  const y1 = Math.min(img.height, Math.ceil((box.y + box.height) * scale));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  const factor = Math.round(scale / dpr);
  return encodePng(factor > 1 ? downscale({ width: w, height: h, data }, factor) : { width: w, height: h, data });
}

/** A capture scaled down to device scale `dpr` when the screen's scale is a multiple of it. */
export function atDeviceScale(capture: Buffer, cssWidth: number, dpr: number): Buffer {
  const img = decodePng(capture);
  const factor = Math.round(img.width / (cssWidth || img.width) / dpr);
  return factor > 1 ? encodePng(downscale(img, factor)) : capture;
}

/** Write `data` to `path`, creating its folder. */
export async function writeOut(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}
