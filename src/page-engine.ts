/**
 * Running code in the page: plain evaluation through vs_inspect, and
 * calls into the page-side engine (src/injected/), which is installed
 * on first use in each document. The Page owns one and delegates
 * evaluate(), evaluateHandle(), waitForFunction() and the engine calls
 * locators make.
 */

import type { WireClient } from './client.ts';
import { ElementHandle } from './element-handle.ts';
import type { PageEvents } from './events.ts';
import { JSHandle } from './handle.ts';
import { ENGINE_SOURCE } from './injected.gen.ts';
import type { Page } from './page.ts';
import { FRAMES_CALL } from './page-frames.ts';
import type { PageSession } from './page-session.ts';
import { sleep } from './retry.ts';
import { deserializeValue, serializeValue, SERIALIZE_JS } from './serialize.ts';

/** The engine install expression: defines window.__tse and yields it. */
const ENGINE_JS = `(${ENGINE_SOURCE})(${SERIALIZE_JS})`;

/** What an engine call returns (E.exec / E.take in src/injected/ops.ts). */
interface EngineReply {
  v?: unknown;
  /** location.href when the call returned. */
  u?: string;
  /** A service worker controls the page. */
  sw?: boolean;
  /** The page's iframe count. */
  fc?: number;
  e?: { name?: string; message: string; stack?: string };
  /** Still pending: poll E.take(p). */
  p?: number;
  gone?: boolean;
  noengine?: boolean;
}

/** Backoff between polls for a pending engine result: fast first, then easing off. */
const takeDelay = (attempt: number) => (attempt < 5 ? 2 : attempt < 20 ? 10 : 25);
/** waitForFunction's default polling interval, one animation frame. */
const DEFAULT_POLL_MS = 16;

/** What PageEngine needs from its page. */
export interface EngineHost {
  readonly page: Page;
  readonly client: WireClient;
  readonly sessionId: string;
  readonly session: PageSession;
  readonly events: PageEvents;
  ensureOpen(): Promise<void>;
  actionTimeout(): number;
  /** An engine call in the main frame saw this URL and service-worker state. */
  noteLocation(href: string | undefined, sw: boolean | undefined): void;
  /** An engine call in the main frame counted this many iframes. */
  noteFrameCount(count: number): Promise<void>;
}

export class PageEngine {
  private readonly host: EngineHost;

  constructor(host: EngineHost) {
    this.host = host;
  }

  /**
   * Evaluate a JavaScript expression or function in the page and
   * return its JSON-serializable result. A function is called with no
   * arguments. Runs through vs_inspect eval, which reads the page
   * without mutating the daemon's state token.
   */
  async evaluate<T = unknown, A = unknown>(fn: string | ((arg: A) => unknown), arg?: A): Promise<T> {
    const a = JSON.stringify(serializeValue(arg));
    // A function, or a string holding one, is called with `arg`; any
    // other string is an expression. Promises are awaited.
    const src = typeof fn === 'function' ? fn.toString() : fn;
    const body = `(function(){var v=(${src});return typeof v==='function'?v(E.des(${a})):v;})()`;
    return (await this.engineCall(body)) as T;
  }

  /** Raw evaluate through vs_inspect: JSON in, JSON out, no promise handling. */
  async rawEval<T>(src: string, frame: string | null = null): Promise<T> {
    await this.host.ensureOpen();
    const flags: Record<string, string | true> = { session: this.host.sessionId, full: true };
    // A subframe by URL, cross-origin ones included (vibesurfer 0.2.16+).
    if (frame !== null) flags['frame'] = frame;
    const resp = await this.host.client.call('vs_inspect', ['eval', this.host.session.id, `JSON.stringify(${src}) ?? "null"`], flags);
    const line = resp.body.find((l) => l.startsWith('result='));
    if (line === undefined) {
      throw new Error(`evaluate failed: ${resp.body.join(' ').slice(0, 300)}`);
    }
    return JSON.parse(line.slice('result='.length)) as T;
  }

  /**
   * Run `body` (an expression that may use the engine as `E`) in the
   * page, or in the subframe with URL `frame`. Installs the engine on
   * first use in each document, waits out promises, and turns page
   * exceptions into thrown Errors.
   */
  async engineCall(body: string, frame: string | null = null): Promise<unknown> {
    const call = (install: boolean) =>
      `(function(){var E=${install ? ENGINE_JS : 'window.__tse'};if(!E)return {noengine:1};return E.exec(function(){return ${body};});})()`;
    let r = await this.rawEval<EngineReply | null>(call(false), frame);
    if (r && r.noengine) r = await this.rawEval<EngineReply | null>(call(true), frame);
    for (let i = 0; r && r.p !== undefined; i++) {
      await sleep(takeDelay(i));
      r = await this.rawEval<EngineReply | null>(`(function(){var E=window.__tse;return E?E.take(${r.p}):{gone:1};})()`, frame);
    }
    if (!r || r.gone || r.noengine) {
      throw new Error('Execution context was destroyed, most likely because of a navigation');
    }
    if (frame === null) {
      this.host.noteLocation(typeof r.u === 'string' ? r.u : undefined, typeof r.sw === 'boolean' ? r.sw : undefined);
      // Keep frames() current: re-read the frame tree when the page's iframe count changed.
      if (typeof r.fc === 'number' && body !== FRAMES_CALL) await this.host.noteFrameCount(r.fc);
    }
    // Bindings, console messages and page errors a call caused are
    // delivered before it returns, as Playwright's protocol events are.
    if ((this.host.events.hasBindings || this.host.events.hasListeners('console') || this.host.events.hasListeners('pageerror')) && !body.startsWith('E.doc')) {
      await this.host.events.flush();
    }
    if (r.e) {
      // As Playwright prints a page exception: "TypeError: Load failed".
      const name = r.e.name && r.e.name !== 'Error' ? r.e.name : null;
      const err = new Error(name ? `${name}: ${r.e.message}` : r.e.message);
      err.name = r.e.name ?? 'Error';
      throw err;
    }
    return deserializeValue(r.v);
  }

  /** One locator-engine request (see src/injected/). `fn` is a function source passed alongside. */
  async engineRun<T>(req: Record<string, unknown>, fn?: string): Promise<T> {
    return (await this.engineRunIn(null, req, fn, 0, 0)) as T;
  }

  /**
   * engineRun in `frame`. A chain that crosses into a cross-origin
   * frame stops there (XOFrame); the rest runs inside that frame, and
   * a point it returns moves by where the frame sits in the page.
   */
  private async engineRunIn(frame: string | null, req: Record<string, unknown>, fn: string | undefined, dx: number, dy: number): Promise<unknown> {
    let r: unknown;
    try {
      r = await this.engineCall(`E.run(${JSON.stringify(req)}${fn ? `,(${fn})` : ''})`, frame);
    } catch (e) {
      if ((e as Error).name !== 'XOFrame') throw e;
      const xo = JSON.parse((e as Error).message.replace(/^XOFrame: /, '')) as { url: string; rest: number; x: number; y: number };
      const steps = (req['steps'] as unknown[]).slice(xo.rest);
      return this.engineRunIn(xo.url, { ...req, steps }, fn, dx + xo.x, dy + xo.y);
    }
    const v = (r as { v?: { x?: unknown; y?: unknown } } | null)?.v;
    if (frame !== null && v && typeof v.x === 'number' && typeof v.y === 'number') {
      (r as { v: { x: number; y: number } }).v = { ...v, x: v.x + dx, y: v.y + dy } as { x: number; y: number };
    }
    return r;
  }

  /** @internal page.evaluate() inside a cross-origin subframe, addressed by URL. */
  async evaluateInFrame<T = unknown, A = unknown>(frame: string, fn: string | ((arg: A) => unknown), arg?: A): Promise<T> {
    const a = JSON.stringify(serializeValue(arg));
    const src = typeof fn === 'function' ? fn.toString() : fn;
    const body = `(function(){var v=(${src});return typeof v==='function'?v(E.des(${a})):v;})()`;
    return (await this.engineCall(body, frame)) as T;
  }

  /** Poll `fn(arg)` in the page until it returns a truthy value, and return that value. */
  async waitForFunction<T = unknown, A = unknown>(
    fn: string | ((arg: A) => unknown),
    arg?: A,
    options: { timeout?: number; polling?: number | 'raf' } = {},
  ): Promise<JSHandle & { jsonValue(): Promise<T> }> {
    const budget = options.timeout ?? this.host.actionTimeout();
    const deadline = Date.now() + budget;
    const every = typeof options.polling === 'number' ? options.polling : DEFAULT_POLL_MS;
    const a = JSON.stringify(serializeValue(arg));
    const src = typeof fn === 'function' ? fn.toString() : fn;
    // A truthy value is adopted in the same call and handed back as a JSHandle, as in Playwright.
    const body =
      `(function(){var f=(${src});var v=typeof f==='function'?f(E.des(${a})):f;` +
      `var fin=function(x){return x?E.adoptValue(x):null;};return v&&typeof v.then==='function'?v.then(fin):fin(v);})()`;
    for (;;) {
      const r = (await this.engineCall(body)) as { id: number; el: boolean; p?: string } | null;
      if (r) {
        const h = r.el ? new ElementHandle(this.host.page, r.id) : new JSHandle(this.host.page, r.id);
        h.previewText = r.p ?? '';
        return h as JSHandle & { jsonValue(): Promise<T> };
      }
      if (budget > 0 && Date.now() >= deadline) {
        throw new Error(`page.waitForFunction: Timeout ${budget}ms exceeded.`);
      }
      await sleep(every);
    }
  }

  /** Like evaluate(), but keeps the result in the page and returns a handle to it. */
  async evaluateHandle<A = unknown>(fn: string | ((arg: A) => unknown), arg?: A): Promise<JSHandle> {
    const a = JSON.stringify(serializeValue(arg));
    const src = typeof fn === 'function' ? fn.toString() : fn;
    return this.adoptResult(`(function(){var v=(${src});return typeof v==='function'?v(E.des(${a})):v;})()`);
  }

  /** @internal Evaluate `expr` (may be a promise) and hand back a handle to its value. */
  async adoptResult(expr: string): Promise<JSHandle> {
    const r = (await this.engineCall(`E.adoptValue(${expr})`)) as { id: number; el: boolean; p?: string };
    const h = r.el ? new ElementHandle(this.host.page, r.id) : new JSHandle(this.host.page, r.id);
    h.previewText = r.p ?? '';
    return h;
  }
}
