/**
 * HAR files: replaying them (routeFromHAR) and recording them
 * (recordHar, routeFromHAR's update mode). HAR 1.2, as Playwright reads
 * and writes it; `.zip` archives keep bodies as separate entries.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { Request, Response, Route } from './events.ts';

interface HarHeader {
  name: string;
  value: string;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: { method: string; url: string; httpVersion: string; headers: HarHeader[]; queryString: HarHeader[]; cookies: unknown[]; headersSize: number; bodySize: number; postData?: { mimeType: string; text: string } };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarHeader[];
    cookies: unknown[];
    content: { size: number; mimeType: string; text?: string; encoding?: string; _file?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
}

export interface Har {
  log: { version: string; creator: { name: string; version: string }; pages?: unknown[]; entries: HarEntry[] };
}

/** Read a `.har` file, or a `.zip` with `har.har` (or one `.har`) and body files. */
export function readHar(file: string): { har: Har; files: Map<string, Buffer> } {
  const raw = fs.readFileSync(file);
  if (!file.endsWith('.zip')) return { har: JSON.parse(raw.toString('utf8')) as Har, files: new Map() };
  const files = unzip(raw);
  const name = [...files.keys()].find((n) => n.endsWith('.har'));
  if (!name) throw new Error(`${file}: no .har inside`);
  return { har: JSON.parse(files.get(name)!.toString('utf8')) as Har, files };
}

/** A minimal zip reader (stored and deflated entries). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + size);
    out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** A zip of `files` (deflated), for writing `.zip` HARs. */
function zip(files: Map<string, Buffer>): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name, 'utf8');
    const z = zlib.deflateRawSync(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc(data), 14);
    h.writeUInt32LE(z.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    locals.push(h, n, z);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc(data), 16);
    c.writeUInt32LE(z.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    centrals.push(c, n);
    offset += 30 + n.length + z.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

/** The entry that answers `req`: same method and URL, the same body when there are several. */
export function findEntry(har: Har, req: Request): HarEntry | null {
  const url = req.url();
  const method = req.method();
  const same = har.log.entries.filter((e) => e.request.method === method && e.request.url === url);
  if (same.length <= 1) return same[0] ?? null;
  const body = req.postData() ?? '';
  return same.find((e) => (e.request.postData?.text ?? '') === body) ?? same[0]!;
}

/** Answer `route` from `entry`, following its redirect through the HAR. */
export async function fulfillFromEntry(route: Route, entry: HarEntry, files: Map<string, Buffer>): Promise<void> {
  const c = entry.response.content;
  const body = c._file !== undefined ? (files.get(c._file) ?? Buffer.alloc(0)) : c.encoding === 'base64' ? Buffer.from(c.text ?? '', 'base64') : Buffer.from(c.text ?? '', 'utf8');
  const headers: Record<string, string> = {};
  for (const h of entry.response.headers) {
    const k = h.name.toLowerCase();
    if (k === 'content-length' || k === 'content-encoding' || k === 'transfer-encoding') continue;
    headers[k] = headers[k] !== undefined ? `${headers[k]}, ${h.value}` : h.value;
  }
  await route.fulfill({ status: entry.response.status, headers, body });
}

/** Collects request/response pairs and writes them as a HAR. */
export class HarRecorder {
  private readonly entries: HarEntry[] = [];
  private readonly files = new Map<string, Buffer>();
  private readonly file: string;
  private readonly content: 'embed' | 'attach' | 'omit';
  private readonly urlFilter: ((u: string) => boolean) | null;
  private readonly pending: Promise<void>[] = [];

  constructor(file: string, options: { content?: 'embed' | 'attach' | 'omit'; urlFilter?: string | RegExp } = {}) {
    this.file = file;
    this.content = options.content ?? (file.endsWith('.zip') ? 'attach' : 'embed');
    const f = options.urlFilter;
    this.urlFilter = f === undefined ? null : f instanceof RegExp ? (u) => f.test(u) : (u) => globToRegExp(f).test(u);
  }

  /** Record a finished request (its response body is read now). */
  add(req: Request, res: Response | null): void {
    if (this.urlFilter && !this.urlFilter(req.url())) return;
    this.pending.push(
      (async () => {
        const body = res ? await res.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
        this.entries.push(this.entry(req, res, body));
      })(),
    );
  }

  /** Record an exchange made by routeFromHAR's update mode. */
  addExchange(req: Request, status: number, statusText: string, headers: Record<string, string>, body: Buffer): void {
    const res = { status: () => status, statusText: () => statusText, headers: () => headers, url: () => req.url() } as unknown as Response;
    this.entries.push(this.entry(req, res, body));
  }

  private entry(req: Request, res: Response | null, body: Buffer): HarEntry {
    const u = new URL(req.url());
    const hdrs = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));
    const rh = res ? res.headers() : {};
    const mime = rh['content-type'] ?? 'x-unknown';
    const textual = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)|image\/svg)/.test(mime);
    const content: HarEntry['response']['content'] = { size: body.length, mimeType: mime };
    if (this.content === 'embed') {
      if (textual) content.text = body.toString('utf8');
      else {
        content.text = body.toString('base64');
        content.encoding = 'base64';
      }
    } else if (this.content === 'attach' && body.length) {
      const name = `${createHash(body)}.${mime.split('/')[1]?.split(';')[0] ?? 'bin'}`;
      this.files.set(name, body);
      content._file = name;
    }
    const post = req.postData();
    return {
      startedDateTime: new Date().toISOString(),
      time: 0,
      request: {
        method: req.method(),
        url: req.url(),
        httpVersion: 'HTTP/1.1',
        headers: hdrs(req.headers()),
        queryString: [...u.searchParams].map(([name, value]) => ({ name, value })),
        cookies: [],
        headersSize: -1,
        bodySize: post ? Buffer.byteLength(post) : 0,
        ...(post ? { postData: { mimeType: req.headers()['content-type'] ?? 'application/octet-stream', text: post } } : {}),
      },
      response: {
        status: res ? res.status() : 0,
        statusText: res ? res.statusText() : '',
        httpVersion: 'HTTP/1.1',
        headers: hdrs(rh),
        cookies: [],
        content,
        redirectURL: rh['location'] ?? '',
        headersSize: -1,
        bodySize: body.length,
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
    };
  }

  /** Write the HAR (a `.zip` with body files when attaching). */
  async save(): Promise<void> {
    await Promise.all(this.pending.splice(0));
    const har: Har = { log: { version: '1.2', creator: { name: 'testsurfer', version: '0.3' }, entries: this.entries } };
    await fs.promises.mkdir(path.dirname(path.resolve(this.file)), { recursive: true });
    if (this.file.endsWith('.zip')) {
      const files = new Map(this.files);
      files.set('har.har', Buffer.from(JSON.stringify(har, null, 2)));
      await fs.promises.writeFile(this.file, zip(files));
    } else {
      await fs.promises.writeFile(this.file, JSON.stringify(har, null, 2));
    }
  }
}

function createHash(b: Buffer): string {
  return crypto.createHash('sha1').update(b).digest('hex');
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
