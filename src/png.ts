/**
 * Minimal PNG decode/encode for screenshot comparison. Handles the
 * non-interlaced 8-bit gray, gray+alpha, RGB, RGBA and palette images
 * that WebKit snapshots and common editors produce. Pixels come out as
 * RGBA.
 */

import { deflateSync, inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (depth !== 8 || interlace !== 0) {
    throw new Error(`unsupported PNG (bit depth ${depth}, interlace ${interlace}); 8-bit non-interlaced only`);
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      const v = line[x]!;
      out[x] =
        filter === 0 ? v
        : filter === 1 ? v + a
        : filter === 2 ? v + b
        : filter === 3 ? v + ((a + b) >> 1)
        : v + paeth(a, b, c);
    }
    prev = out;
  }
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 6) {
      data.set(rows.subarray(s, s + 4), d);
    } else if (colorType === 2) {
      data[d] = rows[s]!;
      data[d + 1] = rows[s + 1]!;
      data[d + 2] = rows[s + 2]!;
      data[d + 3] = 255;
    } else if (colorType === 0 || colorType === 4) {
      data[d] = data[d + 1] = data[d + 2] = rows[s]!;
      data[d + 3] = colorType === 4 ? rows[s + 1]! : 255;
    } else {
      const idx = rows[s]!;
      data[d] = palette?.[idx * 3] ?? 0;
      data[d + 1] = palette?.[idx * 3 + 1] ?? 0;
      data[d + 2] = palette?.[idx * 3 + 2] ?? 0;
      data[d + 3] = trns?.[idx] ?? 255;
    }
  }
  return { width, height, data };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(img: Image): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface DiffResult {
  /** Pixels whose largest channel difference exceeds the threshold. */
  diffPixels: number;
  total: number;
  /** Red where pixels differ, faded actual elsewhere. */
  diff: Image;
}

/**
 * Compare two same-size images. `threshold` (0-1) is the per-channel
 * difference a pixel may have before it counts as changed.
 */
export function diffImages(a: Image, b: Image, threshold: number): DiffResult {
  const total = a.width * a.height;
  const diff: Image = { width: a.width, height: a.height, data: new Uint8Array(total * 4) };
  const limit = threshold * 255;
  let diffPixels = 0;
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    let max = 0;
    for (let c = 0; c < 4; c++) max = Math.max(max, Math.abs(a.data[p + c]! - b.data[p + c]!));
    if (max > limit) {
      diffPixels++;
      diff.data.set([255, 0, 0, 255], p);
    } else {
      const gray = (a.data[p]! + a.data[p + 1]! + a.data[p + 2]!) / 3;
      const faded = 255 - (255 - gray) * 0.3;
      diff.data.set([faded, faded, faded, 255], p);
    }
  }
  return { diffPixels, total, diff };
}
