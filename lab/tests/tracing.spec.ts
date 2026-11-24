import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/** The entries of a zip file (stored or deflated). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), n = buf.readUInt16LE(p + 28), x = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + n).toString();
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    p += 46 + n + x + c;
  }
  return out;
}

test('tracing writes a trace with actions, screenshots and network', async ({ page, context }) => {
  const file = process.env['KEEP_TRACE'] ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-trace-')), 'trace.zip');
  await context.tracing.start({ screenshots: true, snapshots: true });
  await page.goto('/network/fetcher.html');
  await page.getByRole('button', { name: 'Load' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(3);
  await context.tracing.stop({ path: file });
  const files = unzip(fs.readFileSync(file));
  const traceName = [...files.keys()].find((n) => n.endsWith('.trace'))!;
  const events = files.get(traceName)!.toString().trim().split('\n').map((l) => JSON.parse(l));
  expect(events[0].type).toBe('context-options');
  expect(events.some((e) => e.type === 'before' && e.method === 'click')).toBe(true);
  expect(events.some((e) => e.type === 'screencast-frame')).toBe(true);
  const netName = [...files.keys()].find((n) => n.endsWith('.network'))!;
  expect(files.get(netName)!.toString()).toContain('/api/items');
});
