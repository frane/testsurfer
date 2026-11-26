/**
 * page.route() and page.on(), driven by the page shim (src/shim.ts).
 *
 * A poller on its own daemon connection takes the shim's queue every
 * few milliseconds while the page has routes or listeners. It emits
 * events and runs route handlers, then settles each held request in
 * the page. Its own connection means a long call on the test's
 * connection (a wait) cannot stall a request the page is waiting on.
 */

import type { WireClient } from './client.ts';
import { NetHub, type NetDecider } from './net.ts';
import { ConsoleMessage } from './console.ts';
import { APIResponse, Request, Response } from './http.ts';
import { overrides, Route, type ContinueOptions, type Decision, type RouteHandler } from './route.ts';
import { urlMatches, type UrlMatcher } from './url.ts';

interface RouteEntry {
  matcher: UrlMatcher;
  handler: RouteHandler;
  times: number | null;
}

type Listener = (arg: never) => void;

interface ShimRow {
  id: number;
  kind?: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  type: 'fetch' | 'xhr';
  response?: { status?: number; statusText?: string; headers?: Record<string, string>; body?: string; url?: string; error?: string };
}

interface ShimEvent {
  t: string;
  id?: number | string;
  name?: string;
  args?: unknown[];
  type?: string;
  text?: string;
  message?: string;
  stack?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  status?: number;
  statusText?: string;
  failure?: string;
}

const POLL_MS = 15;

/** What PageEvents needs from its page. */
export interface EventsHost {
  /** A second daemon connection for the poller. */
  openPoller: () => Promise<WireClient>;
  target: () => { pageId: string | null; sessionId: string };
  baseURL: string | undefined;
  /** Make sure the shim is installed for this and later documents. */
  ensureShim: () => Promise<void>;
  /** Add a document-start script for later documents. */
  addInitScript: (source: string) => Promise<void>;
  /** The session routes through vibesurfer's proxy (`--intercept`); see src/net.ts. */
  proxied?: () => boolean;
  /** The page's main frame, for request.frame(). */
  mainFrame?: () => unknown;
  /** The iframe loading `url` (or the newest one), for an iframe's request.frame(). */
  childFrame?: (url: string) => unknown;
  /** setExtraHTTPHeaders() values for this page and its context. */
  extraHeaders?: () => Record<string, string>;
  /** A service worker controlled the page as of the last engine call. */
  swControlled?: () => boolean;
  /** The page's URL as of the last engine call. */
  pageURL?: () => string;
  /** The page is a popup another page opened. */
  isPopup?: () => boolean;
  /** The Page itself, the argument of its load and domcontentloaded events. */
  page?: () => unknown;
  /** The main document is now at `url` (a navigation the page made). */
  noteURL?: (url: string) => void;
  /** The page's Worker with the shim's id, for ConsoleMessage.worker(). */
  workerFor?: (id: number) => unknown;
  /** A WebSocket event from the page (src/websocket.ts). */
  wsEvent?: (e: Record<string, unknown>) => void;
}

/** Per-page routing and event state. The Page owns one. */
export class PageEvents {
  private routes: RouteEntry[] = [];
  private listeners = new Map<string, Set<Listener>>();
  private requests = new Map<number, Request>();
  private pendingFetch = new Map<number, (row: ShimRow) => void>();
  private timer: NodeJS.Timeout | null = null;
  private poller: WireClient | null = null;
  private pollerP: Promise<WireClient> | null = null;
  private routingOn = false;

  private readonly host: EventsHost;
  /** Routing default last given to new documents. */
  private routingDefault = false;

  constructor(host: EventsHost) {
    this.host = host;
  }

  get active(): boolean {
    return this.routes.length > 0 || this.listeners.size > 0 || this.bindings.size > 0;
  }

  /** exposeBinding() callbacks by name; the page calls them through the shim queue. */
  private bindings = new Map<string, (...args: unknown[]) => unknown>();

  /** Register a binding and return the page-side script that defines it. */
  addBinding(name: string, fn: (...args: unknown[]) => unknown): string {
    if (this.bindings.has(name)) throw new Error(`Function "${name}" has been already registered`);
    this.bindings.set(name, fn);
    const n = JSON.stringify(name);
    return (
      `(function(){if(window.top!==window)return;var ts=window.__ts;if(!ts)return;` +
      `window[${n}]=function(){var args=[].slice.call(arguments);return new Promise(function(res,rej){` +
      `var id='b'+(++ts.seq);ts.wait[id]=function(d){if(d.ok)res(d.v);else rej(new Error(d.e));};` +
      `var enc;try{enc=JSON.parse(JSON.stringify(args));}catch(e){enc=[];}` +
      `ts.ev.push({t:'call',id:id,name:${n},args:enc});});};})();`
    );
  }

  private bindingDepth = 0;

  private async runBinding(e: ShimEvent): Promise<void> {
    const fn = this.bindings.get(e.name ?? '');
    let d: { ok: boolean; v?: unknown; e?: string };
    this.bindingDepth++;
    try {
      d = { ok: true, v: fn ? await fn(...(e.args ?? [])) : undefined };
    } catch (err) {
      d = { ok: false, e: err instanceof Error ? err.message : String(err) };
    } finally {
      this.bindingDepth--;
    }
    if (d.v === undefined) delete d.v;
    await this.evalPage(`window.__ts ? window.__ts.settle(${JSON.stringify(e.id)}, ${JSON.stringify(d)}) : 'gone'`).catch(() => {});
  }

  get routing(): boolean {
    return this.routes.length > 0 && !this.proxied;
  }

  addRoute(matcher: UrlMatcher, handler: RouteHandler, times: number | null): void {
    // Later routes take precedence, as in Playwright.
    this.routes.unshift({ matcher, handler, times });
  }

  removeRoutes(matcher?: UrlMatcher, handler?: RouteHandler): void {
    this.routes = this.routes.filter((r) => {
      if (matcher === undefined) return false;
      const same = r.matcher === matcher || String(r.matcher) === String(matcher);
      return !(same && (handler === undefined || r.handler === handler));
    });
  }

  on(name: string, fn: Listener): void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
  }

  off(name: string, fn: Listener): void {
    const set = this.listeners.get(name);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) this.listeners.delete(name);
  }

  private emit(name: string, arg: unknown): void {
    if (name === 'request') this.noteRequest(arg);
    for (const fn of [...(this.listeners.get(name) ?? [])]) {
      try {
        (fn as (a: unknown) => void)(arg);
      } catch {
        /* a throwing listener must not stop the poller */
      }
    }
  }

  /** Start or stop polling and tell the page whether to hold requests. */
  private hub: NetHub | null = null;

  /** Proxy mode: the session's network hub carries requests, responses and routes. */
  private get proxied(): boolean {
    return this.host.proxied?.() ?? false;
  }

  // --- NetPage, for the hub -------------------------------------------

  netEmit(name: string, arg: unknown): void {
    this.emit(name, arg);
  }

  netRoutes(): boolean {
    return this.routes.length > 0 || Object.keys(this.host.extraHeaders?.() ?? {}).length > 0;
  }

  netExtraHeaders(): Record<string, string> {
    return this.host.extraHeaders?.() ?? {};
  }

  netFrame(kind: 'main' | 'sub', url: string): unknown {
    if (kind === 'main') return this.host.mainFrame?.() ?? null;
    return this.host.childFrame?.(url) ?? null;
  }

  /**
   * A request this page's service worker handed on: the page is
   * controlled and the request comes from its document. WebKit sends
   * the same headers either way, so this is as close as the proxy gets.
   */
  netViaServiceWorker(referer: string): boolean {
    if (!this.host.swControlled?.()) return false;
    try {
      return new URL(referer).origin === new URL(this.host.pageURL?.() ?? '').origin;
    } catch {
      return false;
    }
  }

  private navAborted = false;

  /** A route aborted the last main-frame navigation (read once). */
  abortedNavigation(): boolean {
    const v = this.navAborted;
    this.navAborted = false;
    return v;
  }

  netNavAborted(): void {
    this.navAborted = true;
  }

  /** Proxy mode: the main document's response from the hub, redirect chain and all. */
  async proxiedNavResponse(): Promise<Response | null> {
    if (!this.hub) return null;
    // Reset in beforeNavigation(); the poll loop may already have seen it.
    await this.hub.drainNow();
    return this.hub.lastNav;
  }

  /** Proxy mode: make sure the hub is attached before a navigation, so it sees the document. */
  async beforeNavigation(): Promise<void> {
    if (!this.proxied) return;
    this.attachHub();
    this.hub!.lastNav = null;
    // Routes or extra headers set before the first page existed: hold requests now.
    await this.hub!.sync();
  }

  /** Proxy mode: join the session's hub now (a popup, before its first request). */
  attachHub(): void {
    if (this.hub) return;
    const { sessionId } = this.host.target();
    this.hub = NetHub.for(sessionId, () => this.host.openPoller());
    this.hub.attach(this);
  }

  netIsPopup(): boolean {
    return this.host.isPopup?.() ?? false;
  }

  /** Report an event that is not network traffic (popup, close). */
  emitPageEvent(name: string, arg: unknown): void {
    this.emit(name, arg);
  }

  /** The last 200 console messages and page errors, and the last 100 requests (page.consoleMessages() and friends). */
  readonly consoleLog: unknown[] = [];
  readonly errorLog: unknown[] = [];
  readonly requestLog: unknown[] = [];
  /** Where the current document's entries start. */
  navMark = { console: 0, errors: 0 };

  private keep(log: unknown[], v: unknown, cap = 200): void {
    log.push(v);
    if (log.length > cap) {
      const drop = log.length - cap;
      log.splice(0, drop);
      this.navMark = { console: Math.max(0, this.navMark.console - (log === this.consoleLog ? drop : 0)), errors: Math.max(0, this.navMark.errors - (log === this.errorLog ? drop : 0)) };
    }
  }

  /** @internal A request reached the page (any network mode). */
  noteRequest(r: unknown): void {
    this.keep(this.requestLog, r, 100);
  }

  /** Whether anyone listens for `name`. */
  hasListeners(name: string): boolean {
    return (this.listeners.get(name)?.size ?? 0) > 0;
  }

  /**
   * Shim mode: run this page's routes for a main-document navigation
   * to `url`, which the in-page shim cannot see. A fulfilled document
   * is loaded under `url` (vs goto --html); `continue` may change the
   * URL; null means no route decided and the page navigates as usual.
   */
  async routeDocument(
    url: string,
  ): Promise<
    | { kind: 'fulfill'; status: number; headers: Record<string, string>; body: Buffer; req: Request }
    | { kind: 'continue'; url: string }
    | { kind: 'abort' }
    | null
  > {
    if (this.proxied || this.routes.length === 0) return null;
    const req = new Request({ id: 0, url, method: 'GET', headers: {}, body: null, type: 'document', navigation: true });
    req.frameValue = this.host.mainFrame?.() ?? null;
    let out: Awaited<ReturnType<PageEvents['routeDocument']>> = null;
    const decide: NetDecider = {
      fulfill: async (status, headers, body) => {
        out = { kind: 'fulfill', status, headers, body, req };
      },
      continue: async (o) => {
        out = { kind: 'continue', url: o.url ?? url };
      },
      abort: async () => {
        out = { kind: 'abort' };
      },
      fetch: async (o) => {
        const r = await fetch(o.url ?? url, {
          method: o.method ?? 'GET',
          headers: { ...this.netExtraHeaders(), ...(o.headers ?? {}) },
          ...(o.postData !== undefined ? { body: o.postData } : {}),
          redirect: 'follow',
        });
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => (headers[k] = v));
        return new APIResponse({ status: r.status, statusText: r.statusText, headers, body: Buffer.from(await r.arrayBuffer()), url: r.url });
      },
    };
    const handled = await this.netHandle(req, decide, {});
    return handled ? out : null;
  }

  async netHandle(req: Request, decide: NetDecider, fallthrough: ContinueOptions): Promise<boolean> {
    for (const entry of [...this.routes]) {
      // A handler unrouted by an earlier one no longer runs.
      if (!this.routes.includes(entry)) continue;
      // After fallback({ url }), later handlers see the new URL.
      if (!urlMatches(entry.matcher, fallthrough.url ?? req.url(), this.host.baseURL)) continue;
      if (entry.times !== null) {
        entry.times -= 1;
        if (entry.times <= 0) this.routes = this.routes.filter((r) => r !== entry);
      }
      const route = new Route(
        req,
        async (d) => {
          if (d.kind === 'fulfill') {
            await decide.fulfill(d['status'] as number, d['headers'] as Record<string, string>, Buffer.from(String(d['body'] ?? ''), 'base64'));
          } else if (d.kind === 'abort') {
            await decide.abort(String(d['error'] ?? 'failed'));
          } else {
            const o: ContinueOptions = { ...fallthrough };
            if (d['url']) o.url = d['url'] as string;
            if (d['method']) o.method = d['method'] as string;
            if (d['headers']) o.headers = d['headers'] as Record<string, string>;
            if (d['body'] !== undefined) o.postData = d['body'] as string;
            await decide.continue(o);
          }
        },
        (opts) => decide.fetch({ ...fallthrough, ...opts }),
      );
      try {
        await entry.handler(route, req);
      } catch (e) {
        if (!route.handled) await decide.abort('failed');
        throw e;
      }
      if (route.fellBack) {
        Object.assign(fallthrough, route.fellBack);
        continue;
      }
      // A handler that returns without deciding leaves the request
      // waiting, as in Playwright (it may decide later).
      return true;
    }
    return false;
  }

  async sync(): Promise<void> {
    if (this.proxied) {
      const { sessionId } = this.host.target();
      // Always attached when proxied: page.requests() reports the
      // page's requests whether or not anyone listened for them.
      if (!this.hub) {
        this.hub = NetHub.for(sessionId, () => this.host.openPoller());
        this.hub.attach(this);
      }
      await this.hub?.sync();
    }
    if (this.active) await this.host.ensureShim();
    if (this.routing !== this.routingDefault) {
      // New documents read this before Node has seen them.
      this.routingDefault = this.routing;
      await this.host.addInitScript(`window.__tsRoutingDefault = ${this.routing};`);
    }
    const { pageId, sessionId } = this.host.target();
    if (this.active && !this.timer) {
      this.timer = setInterval(() => void this.tick(), POLL_MS);
      this.timer.unref();
    }
    if (!this.active && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (pageId && this.routingOn !== this.routing) {
      const client = await this.client();
      await client.call('vs_inspect', ['eval', pageId, `window.__ts ? window.__ts.setRouting(${this.routing}) : 'none'`], {
        session: sessionId,
      });
      this.routingOn = this.routing;
    }
  }

  /** A new document starts with routing off; the next sync turns it on again. */
  documentChanged(): void {
    this.routingOn = false;
  }

  private closedEvents = false;

  private client(): Promise<WireClient> {
    if (this.poller) return Promise.resolve(this.poller);
    this.pollerP ??= this.host.openPoller().then((c) => {
      // Closed while the connection was opening: do not keep it.
      if (this.closedEvents) {
        c.close();
        throw new Error('page closed');
      }
      return (this.poller = c);
    });
    return this.pollerP;
  }

  private async evalPage<T>(js: string): Promise<T | null> {
    const { pageId, sessionId } = this.host.target();
    if (!pageId) return null;
    const client = await this.client();
    const resp = await client.call('vs_inspect', ['eval', pageId, `JSON.stringify(${js}) ?? "null"`], {
      session: sessionId,
      full: true,
    });
    const line = resp.body.find((l) => l.startsWith('result='));
    return line === undefined ? null : (JSON.parse(line.slice('result='.length)) as T);
  }

  private tickP: Promise<void> | null = null;
  private pendingBindings: Promise<void>[] = [];

  private tick(): Promise<void> {
    this.tickP ??= this.drain().finally(() => {
      this.tickP = null;
    });
    return this.tickP;
  }

  private async drain(): Promise<void> {
    try {
      const got = await this.evalPage<{ q: ShimRow[]; ev: ShimEvent[] } | null>(
        `window.__ts ? window.__ts.take() : null`,
      );
      if (!got) return;
      for (const e of got.ev) this.onEvent(e);
      for (const row of got.q) void this.onHeld(row);
    } catch {
      /* page closing or navigating; try again next tick */
    }
  }

  get hasBindings(): boolean {
    return this.bindings.size > 0;
  }

  /**
   * Take the page's queue now and wait for the exposed functions it
   * called, so a binding fired by an action has run when the action
   * returns, as in Playwright.
   */
  async flush(): Promise<void> {
    await this.tick();
    // A binding that itself calls into the page must not wait for itself.
    if (this.bindingDepth > 0) return;
    const running = this.pendingBindings.splice(0);
    await Promise.all(running);
  }

  private onEvent(e: ShimEvent): void {
    switch (e.t) {
      case 'call':
        this.pendingBindings.push(this.runBinding(e));
        break;
      case 'console': {
        const w = (e as { worker?: number }).worker;
        const m = new ConsoleMessage(e.type ?? 'log', e.text ?? '', (e.args ?? []) as { v?: unknown; u?: number }[], null, w === undefined ? null : (this.host.workerFor?.(w) ?? null));
        this.keep(this.consoleLog, m);
        this.emit('console', m);
        break;
      }
      case 'nav':
        this.navMark = { console: this.consoleLog.length, errors: this.errorLog.length };
        if (e.url) this.host.noteURL?.(e.url);
        this.emitPageEvent('framenavigated', this.host.mainFrame?.() ?? null);
        break;
      case 'domcontentloaded':
      case 'load':
        this.emitPageEvent(e.t, this.host.page?.() ?? null);
        break;
      default:
        if (e.t.startsWith('ws') || e.t.startsWith('worker') || e.t === 'filechooser') this.host.wsEvent?.(e as unknown as Record<string, unknown>);
      case 'pageerror': {
        const err = new Error(e.message ?? '');
        if (e.name) err.name = e.name;
        if (e.stack) err.stack = e.stack;
        this.keep(this.errorLog, err);
        this.emit('pageerror', err);
        break;
      }
      case 'request': {
        // In proxy mode the hub reports every request; the shim's copy would double it.
        if (this.proxied) break;
        const req = new Request({
          id: Number(e.id ?? 0),
          url: e.url ?? '',
          method: e.method ?? 'GET',
          headers: e.headers ?? {},
          body: e.body ?? null,
          type: (e.type as 'fetch' | 'xhr') ?? 'fetch',
        });
        this.requests.set(req.id, req);
        this.emit('request', req);
        break;
      }
      case 'response': {
        if (this.proxied) break;
        const req = this.requests.get(Number(e.id ?? -1));
        if (!req) break;
        const res = new Response(req, {
          url: e.url ?? req.url(),
          status: e.status ?? 0,
          statusText: e.statusText ?? '',
          headers: e.headers ?? {},
        });
        req.responseValue = res;
        this.emit('response', res);
        this.emit('requestfinished', req);
        this.requests.delete(req.id);
        break;
      }
      case 'requestfailed': {
        if (this.proxied) break;
        const req = this.requests.get(Number(e.id ?? -1));
        if (!req) break;
        req.failureText = e.failure ?? 'failed';
        this.emit('requestfailed', req);
        this.requests.delete(req.id);
        break;
      }
    }
  }

  private async settle(id: number, d: Decision): Promise<void> {
    await this.evalPage(`window.__ts ? window.__ts.settle(${id}, ${JSON.stringify(d)}) : 'gone'`);
  }

  private async onHeld(row: ShimRow): Promise<void> {
    if (row.kind === 'fetched') {
      const wait = this.pendingFetch.get(row.id);
      this.pendingFetch.delete(row.id);
      wait?.(row);
      return;
    }
    const req =
      this.requests.get(row.id) ??
      new Request({ id: row.id, url: row.url, method: row.method, headers: row.headers, body: row.body, type: row.type });
    let continueWith: ContinueOptions = {};
    for (const entry of [...this.routes]) {
      if (!urlMatches(entry.matcher, req.url(), this.host.baseURL)) continue;
      if (entry.times !== null) {
        entry.times -= 1;
        if (entry.times <= 0) this.routes = this.routes.filter((r) => r !== entry);
      }
      const route = new Route(
        req,
        (d) => this.settle(row.id, d),
        (opts) => this.fetchFor(row.id, { ...continueWith, ...opts }),
      );
      try {
        await entry.handler(route, req);
      } catch (e) {
        if (!route.handled) await this.settle(row.id, { kind: 'abort' });
        throw e;
      }
      if (route.fellBack) {
        continueWith = { ...continueWith, ...route.fellBack };
        continue;
      }
      if (!route.handled) await this.settle(row.id, { kind: 'continue', ...overrides(continueWith) });
      return;
    }
    await this.settle(row.id, { kind: 'continue', ...overrides(continueWith) });
  }

  private fetchFor(id: number, opts: ContinueOptions): Promise<APIResponse> {
    return new Promise<APIResponse>((resolve, reject) => {
      this.pendingFetch.set(id, (row) => {
        const r = row.response ?? {};
        if (r.error) {
          reject(new Error(`route.fetch failed: ${r.error}`));
          return;
        }
        resolve(
          new APIResponse({
            status: r.status ?? 0,
            statusText: r.statusText ?? '',
            headers: r.headers ?? {},
            body: Buffer.from(r.body ?? '', 'base64'),
            url: r.url ?? '',
          }),
        );
      });
      void this.settle(id, { kind: 'fetch', ...overrides(opts) });
    });
  }

  /** Resolve with the first `name` event `predicate` accepts, or reject on timeout. */
  waitFor<T>(name: string, predicate: (arg: T) => boolean | Promise<boolean>, timeout: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const fn = (arg: T) => {
        void Promise.resolve(predicate(arg)).then((ok) => {
          if (!ok) return;
          clearTimeout(timer);
          this.off(name, fn as Listener);
          void this.sync();
          resolve(arg);
        });
      };
      const timer = setTimeout(() => {
        this.off(name, fn as Listener);
        void this.sync();
        reject(new Error(`waiting for ${name} timed out after ${timeout}ms`));
      }, timeout);
      this.on(name, fn as Listener);
      void this.sync();
    });
  }

  close(): void {
    this.closedEvents = true;
    void this.pollerP?.then((c) => c.close(), () => {});
    this.hub?.detach(this);
    this.hub = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.routes = [];
    this.listeners.clear();
    this.poller?.close();
    this.poller = null;
    this.pollerP = null;
  }
}
