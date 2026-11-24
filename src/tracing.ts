/**
 * Traces for Playwright's trace viewer (context.tracing). A trace is a
 * zip of `trace.trace` (one JSON event per line: the context, each API
 * call before and after, screencast frames, console messages),
 * `trace.network` (one HAR entry per request) and `resources/` (frames
 * and bodies, by name). Calls are recorded at the public API surface:
 * the methods of Page, Locator, Frame, BrowserContext, Keyboard and
 * Mouse a test calls, not the calls they make in turn.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as zlib from 'node:zlib';

interface Recording {
  title: string | undefined;
  screenshots: boolean;
  events: Record<string, unknown>[];
  network: string[];
  resources: Map<string, Buffer>;
  callSeq: number;
  groups: string[];
}

/** What the tracer needs from its context. */
export interface TracedContext {
  pages(): { screenshot(): Promise<Buffer>; viewportSize(): { width: number; height: number } | null; wireId(): string | null }[];
  on(event: string, fn: (arg: never) => void): unknown;
}

const mono = () => performance.now();
const inCall = new AsyncLocalStorage<boolean>();
const active = new Set<Tracing>();

export class Tracing {
  private readonly ctx: TracedContext;
  private rec: Recording | null = null;
  private hooked = false;

  /** @internal */
  constructor(ctx: TracedContext) {
    this.ctx = ctx;
  }

  /** Start recording: API calls, network and console, and a screenshot after each call with `screenshots`. */
  async start(options: { name?: string; title?: string; screenshots?: boolean; snapshots?: boolean; sources?: boolean } = {}): Promise<void> {
    if (this.rec) throw new Error('Tracing has been already started');
    this.rec = { title: options.title ?? options.name, screenshots: options.screenshots ?? false, events: [], network: [], resources: new Map(), callSeq: 0, groups: [] };
    this.rec.events.push({
      version: 8,
      type: 'context-options',
      origin: 'library',
      browserName: 'webkit',
      playwrightVersion: '1.61.0',
      options: {},
      platform: process.platform,
      wallTime: Date.now(),
      monotonicTime: mono(),
      sdkLanguage: 'javascript',
      title: this.rec.title,
      contextId: `context@${crypto.randomUUID()}`,
    });
    active.add(this);
    if (!this.hooked) {
      this.hooked = true;
      this.ctx.on('requestfinished', ((req: TraceRequest) => void this.network(req)) as (arg: never) => void);
      this.ctx.on('console', ((m: { type(): string; text(): string }) => this.console(m)) as (arg: never) => void);
    }
  }

  /** Begin a new chunk of an ongoing trace (the events so far are dropped once a chunk is saved). */
  async startChunk(options: { name?: string; title?: string } = {}): Promise<void> {
    if (!this.rec) await this.start(options);
  }

  /** Save the chunk so far to `path` and keep recording. */
  async stopChunk(options: { path?: string } = {}): Promise<void> {
    if (!this.rec) throw new Error('Must start tracing before stopping');
    if (options.path) await this.write(options.path);
    const ctxEvent = this.rec.events[0]!;
    this.rec.events = [ctxEvent];
    this.rec.network = [];
    this.rec.resources = new Map();
  }

  /** Stop recording; write the trace to `path` when given. */
  async stop(options: { path?: string } = {}): Promise<void> {
    if (!this.rec) throw new Error('Must start tracing before stopping');
    if (options.path) await this.write(options.path);
    this.rec = null;
    active.delete(this);
  }

  /** Open a named group: the calls until groupEnd() show nested under it. */
  async group(name: string): Promise<void> {
    if (!this.rec) return;
    const callId = `call@${++this.rec.callSeq}`;
    this.rec.events.push({ type: 'before', callId, startTime: mono(), title: name, class: 'Tracing', method: 'tracingGroup', params: {}, ...(this.parent() ? { parentId: this.parent() } : {}) });
    this.rec.groups.push(callId);
  }

  async groupEnd(): Promise<void> {
    const id = this.rec?.groups.pop();
    if (id) this.rec!.events.push({ type: 'after', callId: id, endTime: mono() });
  }

  private parent(): string | undefined {
    return this.rec?.groups[this.rec.groups.length - 1];
  }

  /** @internal Record one API call made on an object of this context. */
  async call<T>(cls: string, method: string, params: Record<string, unknown>, pageId: string | undefined, run: () => Promise<T>): Promise<T> {
    const rec = this.rec;
    if (!rec) return run();
    const callId = `call@${++rec.callSeq}`;
    rec.events.push({ type: 'before', callId, startTime: mono(), class: cls, method, params, ...(pageId ? { pageId } : {}), ...(this.parent() ? { parentId: this.parent() } : {}) });
    let error: unknown = null;
    try {
      return await run();
    } catch (e) {
      error = e;
      throw e;
    } finally {
      if (rec.screenshots) await inCall.run(true, () => this.frame()).catch(() => {});
      rec.events.push({
        type: 'after',
        callId,
        endTime: mono(),
        ...(error ? { error: { message: error instanceof Error ? error.message : String(error), name: error instanceof Error ? error.name : 'Error' } } : {}),
      });
    }
  }

  /** A screenshot of each page, as screencast frames. */
  private async frame(): Promise<void> {
    const rec = this.rec;
    if (!rec) return;
    for (const p of this.ctx.pages()) {
      const id = p.wireId();
      if (!id) continue;
      const shot = await p.screenshot();
      const sha1 = `page@${id}-${Date.now()}.jpeg`;
      rec.resources.set(sha1, shot);
      const vp = p.viewportSize() ?? { width: 1280, height: 720 };
      rec.events.push({ type: 'screencast-frame', pageId: `page@${id}`, sha1, width: vp.width, height: vp.height, timestamp: mono() });
    }
  }

  private console(m: { type(): string; text(): string }): void {
    this.rec?.events.push({ type: 'console', messageType: m.type(), text: m.text(), args: [], location: { url: '', lineNumber: 0, columnNumber: 0 }, time: mono() });
  }

  private async network(req: TraceRequest): Promise<void> {
    const rec = this.rec;
    if (!rec) return;
    const res = req.responseValue ?? null;
    const body = res ? await res.body().catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
    const sha1 = body.length ? `${crypto.createHash('sha1').update(body).digest('hex')}.dat` : undefined;
    if (sha1) rec.resources.set(sha1, body);
    const hdrs = (o: Record<string, string>) => Object.entries(o).map(([name, value]) => ({ name, value }));
    const rh = res ? res.headers() : {};
    rec.network.push(
      JSON.stringify({
        type: 'resource-snapshot',
        snapshot: {
          startedDateTime: new Date().toISOString(),
          time: 0,
          request: { method: req.method(), url: req.url(), httpVersion: 'HTTP/1.1', headers: hdrs(req.headers()), queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
          response: {
            status: res ? res.status() : 0,
            statusText: res ? res.statusText() : '',
            httpVersion: 'HTTP/1.1',
            headers: hdrs(rh),
            cookies: [],
            content: { size: body.length, mimeType: rh['content-type'] ?? 'x-unknown', ...(sha1 ? { _sha1: sha1 } : {}) },
            redirectURL: rh['location'] ?? '',
            headersSize: -1,
            bodySize: body.length,
          },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
          _monotonicTime: mono(),
        },
      }),
    );
  }

  private async write(file: string): Promise<void> {
    const rec = this.rec!;
    const files = new Map<string, Buffer>();
    files.set('trace.trace', Buffer.from(rec.events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
    files.set('trace.network', Buffer.from(rec.network.join('\n') + (rec.network.length ? '\n' : '')));
    for (const [name, data] of rec.resources) files.set(`resources/${name}`, data);
    await fs.promises.mkdir(path.dirname(path.resolve(file)), { recursive: true });
    await fs.promises.writeFile(file, zipFiles(files));
  }
}

interface TraceRequest {
  method(): string;
  url(): string;
  headers(): Record<string, string>;
  responseValue?: { status(): number; statusText(): string; headers(): Record<string, string>; body(): Promise<Buffer> } | null;
}

/**
 * Record the public async methods of `proto` as `cls` calls while a
 * trace of their context runs. `tracerOf` finds the tracer and page id
 * of an instance; calls made inside a recorded call are not recorded.
 */
export function instrument(
  proto: object,
  cls: string,
  tracerOf: (self: unknown) => { tracing: Tracing | null; pageId?: string | undefined; selector?: string | undefined },
  skip: string[] = [],
): void {
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor' || name.startsWith('_') || skip.includes(name)) continue;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || typeof d.value !== 'function' || d.value.constructor.name !== 'AsyncFunction') continue;
    const orig = d.value as (...a: unknown[]) => Promise<unknown>;
    Object.defineProperty(proto, name, {
      ...d,
      value: function (this: unknown, ...args: unknown[]) {
        if (active.size === 0 || inCall.getStore()) return orig.apply(this, args);
        const { tracing, pageId, selector } = tracerOf(this);
        if (!tracing || !active.has(tracing)) return orig.apply(this, args);
        const params: Record<string, unknown> = {};
        const sel = selector ?? (cls === 'Locator' ? (this as { toString?: () => string }).toString?.() : undefined);
        if (sel) params['selector'] = sel;
        if (cls === 'Expect') params['expression'] = name;
        args.forEach((a, i) => {
          if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') params[i === 0 && cls !== 'Locator' ? 'arg' : `arg${i}`] = a;
        });
        // Assertions show as Playwright's: Frame.expect with the matcher as expression.
        const [c, m] = cls === 'Expect' ? ['Frame', 'expect'] : [cls, name];
        return tracing.call(c, m, params, pageId, () => inCall.run(true, () => orig.apply(this, args)));
      },
    });
  }
}

/** A zip of `files` (deflated). */
function zipFiles(files: Map<string, Buffer>): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
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
    parts.push(h, n, z);
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
    central.push(c, n);
    offset += 30 + n.length + z.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
