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
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { WireClient } from './client.ts';
import { NetHub, type NetDecider } from './net.ts';

export type UrlMatcher = string | RegExp | ((url: URL) => boolean);

/** Playwright-style glob: `**` any characters, `*` any but `/`, `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '\\' && i + 1 < glob.length) {
      // A backslash makes the next character literal (`index\\?hello`).
      const next = glob[++i]!;
      out += '\\^$.|?+()[]{}*'.includes(next) ? `\\${next}` : next;
    } else if (c === '*') {
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
  /** fetch, xhr, document, script, stylesheet, image, font, media, websocket, manifest or other. */
  type: string;
  /** The main-frame or iframe navigation (proxy mode). */
  navigation?: boolean;
  frame?: 'main' | 'sub';
  /** Headers in their original case and order, as sent (proxy mode). */
  raw?: { name: string; value: string }[];
  /** The request body's bytes (proxy mode). */
  bodyBytes?: Buffer | null;
}

/** A fetch or XHR the page made. */
export class Request {
  private readonly info: RequestInfo;
  /** Set once the response (or failure) arrives. */
  responseValue: Response | null = null;
  /** The frame that made the request. */
  frameValue: unknown = null;
  /** Redirect chain, when the proxy saw a 3xx before this request. */
  redirectedFromValue: Request | null = null;
  redirectedToValue: Request | null = null;
  /** The route aborted it. */
  abortedByRoute = false;
  /** Proxy mode: the page's service worker handed it on; its response is fromServiceWorker(). */
  viaServiceWorker = false;

  frame(): any {
    // Resolved on first use: an iframe's frame may not be listed yet when its request starts.
    if (typeof this.frameValue === 'function') {
      const f = (this.frameValue as () => unknown)();
      if (f) this.frameValue = f;
      return f;
    }
    return this.frameValue;
  }
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
  /** @internal setExtraHTTPHeaders() values join the request's headers. */
  addHeader(name: string, value: string): void {
    this.info.headers[name.toLowerCase()] = value;
  }
  postData(): string | null {
    return this.info.body;
  }
  postDataJSON(): unknown {
    if (this.info.body === null) return null;
    const type = this.info.headers['content-type'] ?? '';
    // A form body parses as name/value pairs, as in Playwright.
    if (type.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(this.info.body));
    }
    return JSON.parse(this.info.body);
  }
  /** `fetch`, `xhr`, or `document` for the main-frame navigation goto() returns. */
  resourceType(): string {
    return this.info.type;
  }
  isNavigationRequest(): boolean {
    return this.info.navigation ?? this.info.type === 'document';
  }
  /** `main` or `sub` (an iframe), as far as the proxy can tell. */
  frameKind(): 'main' | 'sub' {
    return this.info.frame ?? 'main';
  }
  headersArray(): { name: string; value: string }[] {
    if (this.info.raw) return this.info.raw.map((h) => ({ ...h }));
    return Object.entries(this.info.headers).map(([name, value]) => ({ name, value }));
  }
  redirectedFrom(): Request | null {
    return this.redirectedFromValue;
  }
  redirectedTo(): Request | null {
    return this.redirectedToValue;
  }
  timing(): Record<string, number> {
    return { startTime: 0, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, secureConnectionStart: -1, connectEnd: -1, requestStart: -1, responseStart: -1, responseEnd: -1 };
  }
  async allHeaders(): Promise<Record<string, string>> {
    return this.headers();
  }
  async headerValue(name: string): Promise<string | null> {
    return this.info.headers[name.toLowerCase()] ?? null;
  }
  /** The response, when it has arrived (no waiting). */
  existingResponse(): Response | null {
    return this.responseValue;
  }
  async sizes(): Promise<{ requestBodySize: number; requestHeadersSize: number; responseBodySize: number; responseHeadersSize: number }> {
    return { requestBodySize: this.postDataBuffer()?.length ?? 0, requestHeadersSize: -1, responseBodySize: -1, responseHeadersSize: -1 };
  }
  serviceWorker(): null {
    return null;
  }
  postDataBuffer(): Buffer | null {
    if (this.info.bodyBytes !== undefined) return this.info.bodyBytes;
    return this.info.body === null ? null : Buffer.from(this.info.body);
  }
  failure(): { errorText: string } | null {
    return this.failureText === null ? null : { errorText: this.failureText };
  }
  /** Proxy mode: response() waits for the response or the failure. */
  awaitsResponse = false;
  private settled = false;
  private waiters: (() => void)[] = [];

  /** @internal The response arrived, or the request failed or finished. */
  markSettled(): void {
    this.settled = true;
    for (const w of this.waiters.splice(0)) w();
  }

  async response(): Promise<Response | null> {
    if (this.responseValue || this.settled || !this.awaitsResponse) return this.responseValue;
    await new Promise<void>((res) => this.waiters.push(res));
    return this.responseValue;
  }
}

/**
 * Response metadata. The body is read on demand by fetching the URL
 * again from the page (GET only), since it is not captured in flight.
 */
export class Response {
  private readonly req: Request;
  private readonly data: { url: string; status: number; statusText: string; headers: Record<string, string> };
  /** Reads the body; set by whoever built the response. */
  bodyLoader: (() => Promise<Buffer>) | null = null;
  /** Headers in their original case and order (proxy mode). */
  rawHeaders: { name: string; value: string }[] | null = null;
  constructor(req: Request, data: { url: string; status: number; statusText: string; headers: Record<string, string> }) {
    this.req = req;
    this.data = data;
  }
  headersArray(): { name: string; value: string }[] {
    if (this.rawHeaders) return this.rawHeaders.map((h) => ({ ...h }));
    return Object.entries(this.data.headers).map(([name, value]) => ({ name, value }));
  }
  async headersArrayAsync(): Promise<{ name: string; value: string }[]> {
    return this.headersArray();
  }
  async headerValues(name: string): Promise<string[]> {
    const n = name.toLowerCase();
    return this.headersArray()
      .filter((h) => h.name.toLowerCase() === n)
      .map((h) => h.value);
  }
  /** Proxy mode: the page's service worker handed the request on (see PageEvents.netViaServiceWorker). */
  viaServiceWorker = false;

  fromServiceWorker(): boolean {
    return this.viaServiceWorker;
  }
  httpVersion(): string {
    return 'HTTP/1.1';
  }
  async serverAddr(): Promise<null> {
    return null;
  }
  async securityDetails(): Promise<null> {
    return null;
  }
  async allHeaders(): Promise<Record<string, string>> {
    return this.headers();
  }
  async headerValue(name: string): Promise<string | null> {
    return this.data.headers[name.toLowerCase()] ?? null;
  }
  async body(): Promise<Buffer> {
    if (this.data.status >= 300 && this.data.status < 400 && this.data.headers['location']) {
      throw new Error('response.body: Response body is unavailable for redirect responses');
    }
    if (!this.bodyLoader) {
      throw new Error('response.body: the body of this response was not captured');
    }
    const raw = await this.bodyLoader();
    // The proxy keeps bodies as they came over the wire; the page saw them decoded.
    const enc = (this.data.headers['content-encoding'] ?? '').toLowerCase().trim();
    try {
      if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(raw);
      if (enc === 'deflate') return inflateSync(raw);
      if (enc === 'br') return brotliDecompressSync(raw);
    } catch {
      /* not actually encoded; hand back what came */
    }
    return raw;
  }
  async text(): Promise<string> {
    return (await this.body()).toString('utf8');
  }
  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
  async finished(): Promise<null> {
    return null;
  }
  frame(): unknown {
    return null;
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
    // Playwright counts status 0 (file: and data: URLs) as ok.
    return this.data.status === 0 || (this.data.status >= 200 && this.data.status < 300);
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

/**
 * An `alert`, `confirm` or `prompt` the page is blocked on (proxy
 * mode). A `dialog` listener must accept or dismiss it; with no
 * listener it is dismissed, as in Playwright.
 */
export class Dialog {
  private handled = false;
  private readonly kind: string;
  private readonly text: string;
  private readonly defaultText: string;
  private readonly pageValue: unknown;
  private readonly answer: (accept: boolean, text?: string) => Promise<void>;

  constructor(kind: string, text: string, defaultText: string, page: unknown, answer: (accept: boolean, text?: string) => Promise<void>) {
    this.kind = kind;
    this.text = text;
    this.defaultText = defaultText;
    this.pageValue = page;
    this.answer = answer;
  }

  /** @internal Whether accept() or dismiss() ran. */
  isHandled(): boolean {
    return this.handled;
  }

  type(): string {
    return this.kind;
  }
  message(): string {
    return this.text;
  }
  defaultValue(): string {
    return this.defaultText;
  }
  page(): any {
    return this.pageValue;
  }

  async accept(promptText?: string): Promise<void> {
    if (this.handled) throw new Error('dialog.accept: Cannot accept dialog which is already handled!');
    this.handled = true;
    await this.answer(true, promptText);
  }

  async dismiss(): Promise<void> {
    if (this.handled) throw new Error('dialog.dismiss: Cannot dismiss dialog which is already handled!');
    this.handled = true;
    await this.answer(false);
  }
}

/** A console argument, as a value already copied out of the page. */
export class ConsoleArg {
  private readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
  async jsonValue(): Promise<unknown> {
    return this.value;
  }
  async dispose(): Promise<void> {}
  toString(): string {
    return this.value === undefined ? 'undefined' : typeof this.value === 'object' && this.value !== null ? 'JSHandle@object' : String(this.value);
  }
}

export class ConsoleMessage {
  private readonly kind: string;
  private readonly message: string;
  private readonly values: { v?: unknown; u?: number }[];
  private readonly owner: unknown;
  constructor(kind: string, message: string, values: { v?: unknown; u?: number }[] = [], owner: unknown = null) {
    this.kind = kind;
    this.message = message;
    this.values = values;
    this.owner = owner;
  }
  /** The arguments passed to console.*, as handles whose jsonValue() is the value. */
  args(): ConsoleArg[] {
    return this.values.map((a) => new ConsoleArg(a.u ? undefined : a.v));
  }
  page(): unknown {
    return this.owner;
  }
  location(): { url: string; lineNumber: number; columnNumber: number } {
    return { url: '', lineNumber: 0, columnNumber: 0 };
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
    if (this.handled) throw new Error(`route.${what}: Route is already handled!`);
    this.handled = true;
  }

  async fulfill(options: FulfillOptions = {}): Promise<void> {
    const st = options.status ?? options.response?.status() ?? 200;
    // WebKit cannot fulfill with a redirect; Playwright refuses it there too.
    if (st >= 300 && st < 400) throw new Error(`route.fulfill: Cannot fulfill with redirect status: ${st}`);
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

  async abort(errorCode = 'failed'): Promise<void> {
    this.claim('abort');
    await this.settle({ kind: 'abort', error: errorCode });
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
      if (this.active && !this.hub) {
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
      case 'console':
        this.emit('console', new ConsoleMessage(e.type ?? 'log', e.text ?? '', (e.args ?? []) as { v?: unknown; u?: number }[]));
        break;
      case 'nav':
        if (e.url) this.host.noteURL?.(e.url);
        this.emitPageEvent('framenavigated', this.host.mainFrame?.() ?? null);
        break;
      case 'domcontentloaded':
      case 'load':
        this.emitPageEvent(e.t, this.host.page?.() ?? null);
        break;
      default:
        if (e.t.startsWith('ws')) this.host.wsEvent?.(e as unknown as Record<string, unknown>);
      case 'pageerror': {
        const err = new Error(e.message ?? '');
        if (e.stack) err.stack = e.stack;
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
