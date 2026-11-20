/**
 * page.route() and page.on(), driven by the page shim (src/shim.ts).
 *
 * A poller on its own daemon connection takes the shim's queue every
 * few milliseconds while the page has routes or listeners. It emits
 * events and runs route handlers, then settles each held request in
 * the page. Its own connection means a long call on the test's
 * connection (a wait) cannot stall a request the page is waiting on.
 */

import { readFile } from 'node:fs/promises';
import type { WireClient } from './client.ts';

export type UrlMatcher = string | RegExp | ((url: URL) => boolean);

/** Playwright-style glob: `**` any characters, `*` any but `/`, `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') {
          // `**/` also matches nothing, so `**/api` matches `/api`.
          out += '/?';
          i++;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '{') {
      inGroup = true;
      out += '(';
    } else if (c === '}' && inGroup) {
      inGroup = false;
      out += ')';
    } else if (c === ',' && inGroup) {
      out += '|';
    } else if ('\\^$.|?+()[]'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`${out}$`);
}

export function urlMatches(matcher: UrlMatcher, url: string, baseURL?: string): boolean {
  if (typeof matcher === 'function') {
    try {
      return matcher(new URL(url));
    } catch {
      return false;
    }
  }
  if (matcher instanceof RegExp) return matcher.test(url);
  let pattern = matcher;
  if (baseURL && !/^[a-z]+:|^\*/i.test(pattern)) {
    try {
      pattern = new URL(pattern, baseURL).href;
    } catch {
      /* keep as given */
    }
  }
  if (!/[*{]/.test(pattern)) return url === pattern;
  return globToRegExp(pattern).test(url);
}

interface RequestInfo {
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  type: 'fetch' | 'xhr';
}

/** A fetch or XHR the page made. */
export class Request {
  private readonly info: RequestInfo;
  /** Set once the response (or failure) arrives. */
  responseValue: Response | null = null;
  failureText: string | null = null;

  constructor(info: RequestInfo) {
    this.info = info;
  }
  /** The shim's id for this request. */
  get id(): number {
    return this.info.id;
  }
  url(): string {
    return this.info.url;
  }
  method(): string {
    return this.info.method;
  }
  headers(): Record<string, string> {
    return { ...this.info.headers };
  }
  postData(): string | null {
    return this.info.body;
  }
  postDataJSON(): unknown {
    return this.info.body === null ? null : JSON.parse(this.info.body);
  }
  /** `fetch` or `xhr`: the only kinds the shim sees. */
  resourceType(): string {
    return this.info.type;
  }
  isNavigationRequest(): boolean {
    return false;
  }
  failure(): { errorText: string } | null {
    return this.failureText === null ? null : { errorText: this.failureText };
  }
  async response(): Promise<Response | null> {
    return this.responseValue;
  }
}

/** Response metadata. Bodies are not captured for page.on('response'). */
export class Response {
  private readonly req: Request;
  private readonly data: { url: string; status: number; statusText: string; headers: Record<string, string> };
  constructor(req: Request, data: { url: string; status: number; statusText: string; headers: Record<string, string> }) {
    this.req = req;
    this.data = data;
  }
  url(): string {
    return this.data.url;
  }
  status(): number {
    return this.data.status;
  }
  statusText(): string {
    return this.data.statusText;
  }
  ok(): boolean {
    return this.data.status >= 200 && this.data.status < 300;
  }
  headers(): Record<string, string> {
    return { ...this.data.headers };
  }
  request(): Request {
    return this.req;
  }
}

/** The real response route.fetch() fetched, with its body. */
interface APIResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
}

export class APIResponse {
  private readonly data: APIResponseData;
  constructor(data: APIResponseData) {
    this.data = data;
  }
  url(): string {
    return this.data.url;
  }
  status(): number {
    return this.data.status;
  }
  statusText(): string {
    return this.data.statusText;
  }
  ok(): boolean {
    return this.data.status >= 200 && this.data.status < 300;
  }
  headers(): Record<string, string> {
    return { ...this.data.headers };
  }
  async body(): Promise<Buffer> {
    return this.data.body;
  }
  async text(): Promise<string> {
    return this.data.body.toString('utf8');
  }
  async json(): Promise<unknown> {
    return JSON.parse(this.data.body.toString('utf8'));
  }
}

export class ConsoleMessage {
  private readonly kind: string;
  private readonly message: string;
  constructor(kind: string, message: string) {
    this.kind = kind;
    this.message = message;
  }
  /** `log`, `info`, `warning`, `error` or `debug`. */
  type(): string {
    return this.kind;
  }
  text(): string {
    return this.message;
  }
}

export interface FulfillOptions {
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
  body?: string | Buffer;
  json?: unknown;
  /** File whose contents are the body. */
  path?: string;
  /** Start from a response route.fetch() returned; the other options override it. */
  response?: APIResponse;
}

export interface ContinueOptions {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: string | Buffer;
}

type Decision = Record<string, unknown> & { kind: string };

/** A request held by page.route(), waiting for the handler's decision. */
export class Route {
  /** Set by the first decision; a second one is an error. */
  handled = false;
  /** fallback() was called: try the next matching handler. */
  fellBack: ContinueOptions | null = null;

  private readonly req: Request;
  private readonly settle: (d: Decision) => Promise<void>;
  private readonly fetchVia: (opts: ContinueOptions) => Promise<APIResponse>;

  constructor(
    req: Request,
    settle: (d: Decision) => Promise<void>,
    fetchVia: (opts: ContinueOptions) => Promise<APIResponse>,
  ) {
    this.req = req;
    this.settle = settle;
    this.fetchVia = fetchVia;
  }

  request(): Request {
    return this.req;
  }

  private claim(what: string): void {
    if (this.handled) throw new Error(`route.${what}: the route is already handled`);
    this.handled = true;
  }

  async fulfill(options: FulfillOptions = {}): Promise<void> {
    this.claim('fulfill');
    const headers: Record<string, string> = {};
    let status = options.status ?? 200;
    let body: Buffer = Buffer.alloc(0);
    if (options.response) {
      Object.assign(headers, options.response.headers());
      status = options.status ?? options.response.status();
      body = await options.response.body();
    }
    Object.assign(headers, options.headers ?? {});
    if (options.json !== undefined) {
      body = Buffer.from(JSON.stringify(options.json));
      headers['content-type'] ??= 'application/json';
    } else if (options.path) {
      body = await readFile(options.path);
    } else if (options.body !== undefined) {
      body = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
    }
    if (options.contentType) headers['content-type'] = options.contentType;
    // The page derives these from the body it is handed.
    delete headers['content-length'];
    delete headers['content-encoding'];
    await this.settle({ kind: 'fulfill', status, headers, body: body.toString('base64') });
  }

  async continue(options: ContinueOptions = {}): Promise<void> {
    this.claim('continue');
    await this.settle({ kind: 'continue', ...overrides(options) });
  }

  async abort(_errorCode?: string): Promise<void> {
    this.claim('abort');
    await this.settle({ kind: 'abort' });
  }

  /** Let the next matching handler decide (or the network, when none does). */
  async fallback(options: ContinueOptions = {}): Promise<void> {
    this.claim('fallback');
    this.fellBack = options;
  }

  /** Perform the request for real and return the response, to modify and fulfill with. */
  async fetch(options: ContinueOptions = {}): Promise<APIResponse> {
    return this.fetchVia(options);
  }
}

function overrides(o: ContinueOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.url) out['url'] = o.url;
  if (o.method) out['method'] = o.method;
  if (o.headers) out['headers'] = o.headers;
  if (o.postData !== undefined) out['body'] = Buffer.isBuffer(o.postData) ? o.postData.toString('utf8') : o.postData;
  return out;
}

export type RouteHandler = (route: Route, request: Request) => Promise<void> | void;

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
  id?: number;
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
}

/** Per-page routing and event state. The Page owns one. */
export class PageEvents {
  private routes: RouteEntry[] = [];
  private listeners = new Map<string, Set<Listener>>();
  private requests = new Map<number, Request>();
  private pendingFetch = new Map<number, (row: ShimRow) => void>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
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
    return this.routes.length > 0 || this.listeners.size > 0;
  }

  get routing(): boolean {
    return this.routes.length > 0;
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
    for (const fn of [...(this.listeners.get(name) ?? [])]) {
      try {
        (fn as (a: unknown) => void)(arg);
      } catch {
        /* a throwing listener must not stop the poller */
      }
    }
  }

  /** Start or stop polling and tell the page whether to hold requests. */
  async sync(): Promise<void> {
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

  private client(): Promise<WireClient> {
    if (this.poller) return Promise.resolve(this.poller);
    this.pollerP ??= this.host.openPoller().then((c) => (this.poller = c));
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

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const got = await this.evalPage<{ q: ShimRow[]; ev: ShimEvent[] } | null>(
        `window.__ts ? window.__ts.take() : null`,
      );
      if (!got) return;
      for (const e of got.ev) this.onEvent(e);
      for (const row of got.q) void this.onHeld(row);
    } catch {
      /* page closing or navigating; try again next tick */
    } finally {
      this.ticking = false;
    }
  }

  private onEvent(e: ShimEvent): void {
    switch (e.t) {
      case 'console':
        this.emit('console', new ConsoleMessage(e.type ?? 'log', e.text ?? ''));
        break;
      case 'pageerror': {
        const err = new Error(e.message ?? '');
        if (e.stack) err.stack = e.stack;
        this.emit('pageerror', err);
        break;
      }
      case 'request': {
        const req = new Request({
          id: e.id ?? 0,
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
        const req = this.requests.get(e.id ?? -1);
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
        const req = this.requests.get(e.id ?? -1);
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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.routes = [];
    this.listeners.clear();
    this.poller?.close();
    this.poller = null;
    this.pollerP = null;
  }
}
