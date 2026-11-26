/**
 * A Page wraps one vibesurfer page: navigation, fresh views, token
 * management, and locator factories. Authors never see state tokens;
 * the page caches the latest one and every mutation uses it.
 */

import type { WireClient } from './client.ts';
import type { BrowserContext } from './context.ts';
import type { WireResponse } from './wire.ts';

import { WireError } from './errors.ts';
import { applyDelta, isDeltaBody, parseFullTree, type Snapshot } from './tree.ts';
import { FrameLocator } from './frame-locator.ts';
import { JSHandle } from './handle.ts';
import { ElementHandle } from './element-handle.ts';
import { Locator } from './locator.ts';
import type { BoundingBox, ClickOptions, InputFile, SelectOptionValue } from './locator-options.ts';
import { byAttr, selectorSteps, type ByRoleOptions, type ByTextOptions, type LocatorOptions } from './query.ts';
import { installEngine } from './injected.ts';
import { APIRequestContext } from './request.ts';
import type { Download } from './download.ts';
import { DownloadWatcher } from './page-downloads.ts';
import { MobileZoom } from './page-zoom.ts';
import { Clock } from './clock.ts';
import { WS_SHIM, type WebSocketRoute } from './websocket.ts';
import { WORKER_SHIM, type Worker } from './worker.ts';
import { HarRecorder, findEntry, fulfillFromEntry, readHar } from './har.ts';
import { Video } from './video.ts';
import { FILECHOOSER_SHIM } from './filechooser.ts';
import { Screencast } from './screencast.ts';
import { selectorSettings } from './selectors.ts';
import { Frame } from './frame.ts';
import type { MediaOptions } from './media.ts';
import { MediaEmulation } from './page-media.ts';
import { deserializeValue, serializeValue, SERIALIZE_JS } from './serialize.ts';
import { decodePng, downscale, encodePng } from './png.ts';
import { renderSnapshot } from './aria.ts';
import { PAGE_SHIM } from './shim.ts';
import { ConsoleMessage } from './console.ts';
import type { Dialog } from './dialog.ts';
import { PageEvents } from './events.ts';
import { PageHooks } from './page-hooks.ts';
import { FRAMES_CALL, FrameTree, type FrameMatch } from './page-frames.ts';
import { LocatorHandlers } from './locator-handlers.ts';
import { Keyboard, Mouse, Touchscreen, type InputHost } from './input.ts';
import { Request, Response } from './http.ts';
import type { RouteHandler } from './route.ts';
import { urlMatches, type UrlMatcher } from './url.ts';
import { parseLayoutLines, type LayoutRect } from './layout.ts';
import type { ClickVia, InputMode, ProtocolOptions, Timeouts } from './page-options.ts';
import { sleep } from './retry.ts';

/** The engine install expression: defines window.__tse and yields it. */
const ENGINE_JS = `(${installEngine.toString()})(${SERIALIZE_JS})`;

interface EngineReply {
  v?: unknown;
  /** location.href when the call returned. */
  u?: string;
  e?: { name?: string; message: string; stack?: string };
  p?: number;
  gone?: boolean;
  noengine?: boolean;
}


/** Frame rate for page.video() and screencast recordings, as Playwright records. */
const RECORD_FPS = '25';
/** Poll interval while waiting for the URL to change (waitForURL, back/forward). */
const URL_POLL_MS = 50;
/** Poll interval for waitForNavigation's document check. */
const NAV_POLL_MS = 20;
/** Poll interval while a popup's first document loads. */
const POPUP_LOAD_POLL_MS = 30;
/** How long goBack/goForward wait for the URL to change before treating the move as a no-op. */
const HISTORY_SETTLE_MS = 2_000;
/** How long a failed call waits for a popup's own window.close() to land. */
const SELF_CLOSE_GRACE_MS = 1_000;

/** Backoff between polls for a pending engine result: fast first, then easing off. */
const takeDelay = (attempt: number) => (attempt < 5 ? 2 : attempt < 20 ? 10 : 25);


/** What every page gets at document start: the event shim and the WebSocket hook. */
export const EAGER_SHIM = `${PAGE_SHIM}\n${WS_SHIM}\n${WORKER_SHIM}\n${FILECHOOSER_SHIM}`;

export class Page {
  private pageId: string | null = null;
  private token: string | null = null;
  /** Last known tree, kept in sync via full views and deltas. */
  private snapshot: Snapshot | null = null;
  /**
   * True while `snapshot` equals the daemon's delta baseline (our last
   * applied view, with no act in between). The daemon advances its
   * baseline on every act and discards that delta, so after an act the
   * next view must be requested `--full`; between plain views, deltas
   * are sound. Cursor ops (click-at) do not touch the baseline, so
   * they leave this flag alone.
   */
  private synced = false;
  /**
   * True while `snapshot` also reflects current page reality, so an
   * action can resolve against it without a read. Any mutation clears
   * it. Distinct from `synced`: a click-at leaves the baseline (and
   * the daemon's last token) untouched, so the token check would not
   * catch acting on the pre-click tree; this flag forces the re-read.
   */
  private fresh = false;

  private readonly client: WireClient;
  private readonly sessionId: string;
  readonly timeouts: Timeouts;
  readonly inputMode: InputMode;
  readonly clickVia: ClickVia;
  readonly actDeltas: boolean;
  readonly navInPlace: boolean;
  private readonly nativeWheel: boolean;
  /** @internal click-at takes button, count and modifiers (vibesurfer 0.2.19+). */
  readonly nativeClickOptions: boolean;
  private readonly webm: boolean;
  private readonly dropNative: boolean;
  readonly baseURL: string | undefined;
  /** HTTP requests from the test process (not the browser). */
  private readonly ownRequest: APIRequestContext;
  /** HTTP calls from the test process that share the context's cookie jar (Playwright's page.request). */
  get request(): APIRequestContext {
    return this.ctx?.request ?? this.ownRequest;
  }
  private testIdOption: string | null = null;

  /** Attribute getByTestId matches: the `testIdAttribute` launch option, else selectors.setTestIdAttribute(), else `data-testid`. */
  get testIdAttribute(): string {
    return this.testIdOption ?? selectorSettings.testIdAttribute ?? 'data-testid';
  }
  set testIdAttribute(name: string) {
    this.testIdOption = name;
  }
  /** Document-start scripts, replayed into the web view when it is created, in order; the event shim and the WebSocket hook are always the first. */
  private initScripts: string[] = [EAGER_SHIM];
  /** PAGE_SHIM is in initScripts from the start (EAGER_SHIM). */
  private shimInstalled = true;
  private readonly events: PageEvents;
  /** WebSockets, workers and file choosers the shim reports. */
  private readonly hooks: PageHooks;
  private ctx: BrowserContext | null = null;

  constructor(
    client: WireClient,
    sessionId: string,
    timeouts: Timeouts,
    inputMode: InputMode = 'robotic',
    clickVia: ClickVia = 'click-at',
    protocol: ProtocolOptions = {},
    baseURL?: string,
  ) {
    this.baseURL = baseURL;
    this.ownRequest = new APIRequestContext(baseURL);
    this.client = client;
    this.sessionId = sessionId;
    this.timeouts = { ...timeouts };
    this.inputMode = inputMode;
    this.clickVia = clickVia;
    this.actDeltas = protocol.actDeltas ?? false;
    this.navInPlace = protocol.navInPlace ?? false;
    this.nativeWheel = protocol.nativeWheel ?? false;
    this.nativeClickOptions = protocol.clickOptions ?? false;
    this.webm = protocol.webm ?? false;
    this.dropNative = protocol.drop ?? false;
    this.events = new PageEvents({
      openPoller: () => this.client.sibling(),
      target: () => ({ pageId: this.pageId, sessionId: this.sessionId }),
      baseURL,
      ensureShim: () => this.ensureShim(),
      addInitScript: (src) => this.addInitSource(src),
      proxied: () => this.ctx?.intercept ?? false,
      mainFrame: () => this.mainFrame(),
      childFrame: (url: string) => {
        // The frame list may predate the iframe; the newest child stands in.
        const kids = this.frames().slice(1);
        return kids.find((f) => f.frameUrl === url) ?? kids[kids.length - 1] ?? null;
      },
      extraHeaders: () => ({ ...(this.ctx?.extraHeaders ?? {}), ...this.extraHeaders }),
      isPopup: () => this.openerPage !== undefined,
      page: () => this,
      noteURL: (url: string) => {
        this.lastHref = url;
      },
      wsEvent: (e) => void this.hooks.onEvent(e).catch(() => {}),
      workerFor: (id) => this.hooks.worker(id),
      swControlled: () => this.swControlled,
      pageURL: () => this.lastHref,
    });
    this.hooks = new PageHooks({
      page: this,
      events: this.events,
      baseURL: () => this.baseURL,
      hasDocument: () => this.pageId !== null,
      ensureShim: () => this.ensureShim(),
      addInitSource: (src) => this.addInitSource(src),
      evaluate: (fn, arg) => this.evaluate(fn, arg),
      evaluateHandle: (fn) => this.evaluateHandle(fn),
    });
  }

  /** The page that opened this one; undefined when not a popup. */
  private openerPage: Page | null | undefined = undefined;
  private closedFlag = false;
  /** The URL a popup was opened with, until waitForLoadState() sees it loaded. */
  private popupURL = '';

  /**
   * @internal Take over a page vibesurfer opened as a popup of `opener`
   * (`--popups`). Joins the network hub at once, so the popup's first
   * request is reported to it.
   */
  adoptPopup(pageId: string, url: string, opener: Page | null): PageEvents {
    this.pageId = pageId;
    this.openerPage = opener;
    this.popupURL = url || 'about:blank';
    this.lastHref = url || 'about:blank';
    this.events.documentChanged();
    this.events.attachHub();
    return this.events;
  }

  /**
   * @internal Drop files and strings at (x, y) as native input from
   * another application. Resolves whether the page accepted it, or null
   * where the daemon can't (before 0.2.19, or a pure Wayland session).
   */
  async nativeDrop(x: number, y: number, files: string[], data: Record<string, string>): Promise<boolean | null> {
    if (!this.dropNative) return null;
    await this.ensureOpen();
    const payload = Buffer.from(JSON.stringify({ files, data: Object.entries(data) })).toString('base64');
    try {
      const r = await this.client.call('vs_drop', [this.id, String(x), String(y), payload], { session: this.sessionId });
      return r.body[0] === 'accepted';
    } catch (e) {
      if (/unsupported/i.test(String(e))) return null;
      throw e;
    }
  }

  /** @internal The vibesurfer page id, once the page has one. */
  wireId(): string | null {
    return this.pageId;
  }

  /** The page that opened this one (window.open, target=_blank), or null. */
  async opener(): Promise<Page | null> {
    return this.openerPage ?? null;
  }

  isClosed(): boolean {
    return this.closedFlag;
  }

  /** @internal The page closed itself (window.close()); vibesurfer already released it. */
  closedByPage(): void {
    if (this.closedFlag) return;
    this.pageId = null;
    this.markClosed();
  }

  private markClosed(): void {
    this.closedFlag = true;
    this.events.emitPageEvent('close', this);
    this.events.close();
    this.ctx?.forgetPage(this);
  }

  /** @internal Report a popup this page opened. */
  emitPopup(popup: Page): void {
    this.events.emitPageEvent('popup', popup);
  }

  /**
   * @internal A dialog this page opened. Listeners on the page (or its
   * context) decide; with none it is dismissed, as in Playwright.
   */
  handleDialog(d: Dialog, contextListens: boolean): void {
    if (!this.events.hasListeners('dialog') && !contextListens) {
      void d.dismiss().catch(() => {});
      return;
    }
    this.events.emitPageEvent('dialog', d);
  }

  /** @internal Set by the context that created this page. */
  bindContext(ctx: BrowserContext): void {
    this.ctx = ctx;
  }

  /** The context this page belongs to. */
  context(): BrowserContext {
    if (!this.ctx) throw new Error('page has no context');
    return this.ctx;
  }

  private async addInitSource(source: string): Promise<void> {
    this.initScripts.push(source);
    if (this.pageId) await this.client.call('vs_init_script', [this.pageId, source], { session: this.sessionId });
  }

  private async ensureShim(): Promise<void> {
    if (this.shimInstalled) return;
    this.shimInstalled = true;
    await this.addInitSource(PAGE_SHIM);
    if (this.pageId) await this.evaluate(PAGE_SHIM.replace(/;\s*$/, ''));
  }

  /**
   * Run a script at document start in every later document of this
   * page, before the page's own scripts (Playwright's addInitScript).
   * A function is called with `arg`. The current document is not
   * touched.
   */
  async addInitScript(
    script: string | ((arg: never) => unknown) | { path?: string; content?: string },
    arg?: unknown,
  ): Promise<void> {
    let source: string;
    if (typeof script === 'function') source = `(${script.toString()})(${JSON.stringify(arg ?? null)});`;
    else if (typeof script === 'string') source = script;
    else if (script.content !== undefined) source = script.content;
    else if (script.path) source = await (await import('node:fs/promises')).readFile(script.path, 'utf8');
    else throw new Error('addInitScript: pass a function, a string, or { path } / { content }');
    await this.addInitSource(source);
  }

  /**
   * Emulate media features: matchMedia and the page's @media rules
   * follow (see src/media.ts). null resets a feature. Applies to this
   * document and later ones.
   */
  async emulateMedia(options: MediaOptions = {}): Promise<void> {
    await this.mediaEmulation.emulate(options);
  }

  private readonly mediaEmulation = new MediaEmulation({
    hasDocument: () => this.pageId !== null,
    addInitSource: (src) => this.addInitSource(src),
    rawEval: (expr) => this.rawEval(expr),
    evaluate: (fn, arg) => this.evaluate(fn, arg),
    request: () => this.request,
    onStylesheet: (listener) => {
      this.on('response', (res: Response) => {
        if (res.request().resourceType() === 'stylesheet') listener();
      });
    },
  });

  /**
   * Add a <script> (from `url`, a file at `path`, or `content`) and
   * wait for it to load. Returns its element.
   */
  async addScriptTag(options: { url?: string; path?: string; content?: string; type?: string }): Promise<ElementHandle> {
    let content = options.content;
    if (options.path !== undefined) {
      content = `${await (await import('node:fs/promises')).readFile(options.path, 'utf8')}\n//# sourceURL=${options.path.replace(/\n/g, '')}`;
    }
    const fn = `(o) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      if (o.type) s.type = o.type;
      if (o.url !== undefined) {
        s.src = o.url;
        s.onload = () => resolve(s);
        s.onerror = () => reject(new Error('Failed to load script at ' + o.url));
        document.head.appendChild(s);
        return;
      }
      let err = null;
      const onErr = (e) => { err = e.error || new Error(e.message); };
      window.addEventListener('error', onErr);
      s.text = o.content;
      document.head.appendChild(s);
      window.removeEventListener('error', onErr);
      if (err) reject(err); else resolve(s);
    })`;
    const args = { url: options.url, content, type: options.type };
    return (await this.evaluateHandle(fn, args)) as ElementHandle;
  }

  /** Add a <link rel=stylesheet> (from `url`) or a <style> (from `path` or `content`) and wait for it. */
  async addStyleTag(options: { url?: string; path?: string; content?: string }): Promise<ElementHandle> {
    let content = options.content;
    if (options.path !== undefined) content = await (await import('node:fs/promises')).readFile(options.path, 'utf8');
    const fn = `(o) => new Promise((resolve, reject) => {
      let el;
      if (o.url !== undefined) {
        el = document.createElement('link');
        el.rel = 'stylesheet';
        el.href = o.url;
      } else {
        el = document.createElement('style');
        el.textContent = o.content;
      }
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Error while loading style'));
      document.head.appendChild(el);
      if (o.url === undefined) resolve(el);
    })`;
    return (await this.evaluateHandle(fn, { url: options.url, content })) as ElementHandle;
  }

  /**
   * Intercept fetch and XHR requests whose URL matches. The handler
   * gets a Route to fulfill, continue, abort, fall back or fetch.
   * Navigations, images, scripts and stylesheets are not intercepted.
   */
  async route(url: UrlMatcher, handler: RouteHandler, options: { times?: number } = {}): Promise<void> {
    this.events.addRoute(url, handler, options.times ?? null);
    await this.events.sync();
  }

  /**
   * Answer requests matching `options.url` (all by default) from a HAR
   * file. With `update`, requests go to the network instead and the
   * file is (re)written from what came back when the context closes.
   */
  async routeFromHAR(
    file: string,
    options: { url?: UrlMatcher; notFound?: 'abort' | 'fallback'; update?: boolean; updateContent?: 'embed' | 'attach'; updateMode?: 'full' | 'minimal' } = {},
  ): Promise<void> {
    const match = options.url ?? '**/*';
    if (options.update) {
      const rec = new HarRecorder(file, { content: options.updateContent ?? (file.endsWith('.zip') ? 'attach' : 'embed') });
      this.harWriters.push(rec);
      await this.route(match, async (route) => {
        const res = await route.fetch();
        const body = await res.body();
        rec.addExchange(route.request(), res.status(), res.statusText(), res.headers(), body);
        await route.fulfill({ response: res, body });
      });
      return;
    }
    const { har, files } = readHar(file);
    await this.route(match, async (route) => {
      const e = findEntry(har, route.request());
      if (e) return fulfillFromEntry(route, e, files);
      if (options.notFound === 'fallback') return route.fallback();
      return route.abort();
    });
  }

  /** Frames, recordings and on-page annotations (Playwright's page.screencast). */
  readonly screencast = new Screencast({
    evaluate: (fn, arg) => this.evaluate(fn, arg),
    screenshot: () => this.screenshot(),
    viewportSize: () => this.viewportSize(),
    recordTo: async (width) => {
      await this.ensureOpen();
      await this.client.call('vs_record', ['start', this.id], this.recordFlags(width));
      return async () => {
        const r = await this.client.call('vs_record', ['stop', this.id], { session: this.sessionId }).catch(() => null);
        const line = r?.body.find((l) => l.startsWith('path\t'));
        return line ? line.slice(5) : null;
      };
    },
  });

  private videoValue: Video | null = null;
  private videoSize: { width: number } | null = null;

  /** The page's video, when its context records them (recordVideo); null otherwise. */
  video(): Video | null {
    return this.videoValue;
  }

  /** @internal Record this page from now on into `dir` (recordVideo). */
  async recordVideo(dir: string, size?: { width: number; height: number }): Promise<void> {
    if (this.videoValue) return;
    this.videoValue = new Video(dir);
    this.videoSize = size ? { width: size.width } : null;
    await this.ensureOpen();
    await this.client.call('vs_record', ['start', this.id], this.recordFlags(this.videoSize?.width));
  }

  /**
   * vs_record start flags: WebM where the daemon has it. (Not async:
   * the tracer wraps the page's async methods as actions.)
   */
  private recordFlags(width: number | undefined): Record<string, string> {
    const flags: Record<string, string> = { session: this.sessionId, fps: RECORD_FPS };
    if (this.webm) flags['format'] = 'webm';
    if (width) flags['width'] = String(width);
    return flags;
  }

  /** @internal HARs being written (routeFromHAR update, recordHar), saved on close. */
  readonly harWriters: HarRecorder[] = [];

  /** Remove routes for `url` (only `handler`'s, when given). */
  async unroute(url: UrlMatcher, handler?: RouteHandler): Promise<void> {
    this.events.removeRoutes(url, handler);
    await this.events.sync();
  }

  async unrouteAll(): Promise<void> {
    this.events.removeRoutes();
    await this.events.sync();
  }

  /**
   * Listen for `console`, `pageerror`, `request`, `response`,
   * `requestfinished` or `requestfailed`. Requests and responses are
   * fetch and XHR only.
   */
  on(event: 'console', listener: (msg: ConsoleMessage) => void): this;
  on(event: 'pageerror', listener: (error: Error) => void): this;
  on(event: 'request' | 'requestfinished' | 'requestfailed', listener: (request: Request) => void): this;
  on(event: 'response', listener: (response: Response) => void): this;
  on(event: 'load' | 'domcontentloaded' | 'close' | 'crash', listener: (page: Page) => void): this;
  on(event: 'framenavigated', listener: (frame: Frame) => void): this;
  on(event: 'download', listener: (download: Download) => void): this;
  on(event: string, listener: (arg: never) => void): this;
  on(event: string, listener: (arg: never) => void): this {
    if (event === 'download') this.downloads.start();
    if (event === 'websocket' || event === 'worker') void this.hooks.ensureWsShim().catch(() => {});
    if (event === 'filechooser') void this.hooks.interceptFileChooser().catch(() => {});
    this.events.on(event, listener);
    void this.events.sync().catch(() => {});
    return this;
  }

  once(event: string, listener: (arg: never) => void): this {
    const wrapped = (arg: never) => {
      this.off(event, wrapped);
      listener(arg);
    };
    return this.on(event as 'console', wrapped as never);
  }

  off(event: string, listener: (arg: never) => void): this {
    this.events.off(event, listener);
    void this.events.sync().catch(() => {});
    return this;
  }

  removeListener(event: string, listener: (arg: never) => void): this {
    return this.off(event, listener);
  }

  /** The next `event` that `predicate` accepts. */
  async waitForEvent<T = unknown>(
    event: string,
    optionsOrPredicate?: ((arg: T) => boolean | Promise<boolean>) | { predicate?: (arg: T) => boolean | Promise<boolean>; timeout?: number },
  ): Promise<T> {
    const opts = typeof optionsOrPredicate === 'function' ? { predicate: optionsOrPredicate } : (optionsOrPredicate ?? {});
    if (event === 'download') this.downloads.start();
    if (event === 'websocket' || event === 'worker') await this.hooks.ensureWsShim();
    if (event === 'filechooser') await this.hooks.interceptFileChooser();
    return this.events.waitFor<T>(event, opts.predicate ?? (() => true), opts.timeout ?? this.timeouts.action);
  }

  /** The next fetch/XHR request matching a URL pattern or predicate. */
  async waitForRequest(
    match: UrlMatcher | ((request: Request) => boolean | Promise<boolean>),
    options: { timeout?: number } = {},
  ): Promise<Request> {
    const test =
      typeof match === 'function' && match.length === 1 && !(match instanceof RegExp)
        ? (r: Request) => (match as (r: Request) => boolean | Promise<boolean>)(r)
        : (r: Request) => urlMatches(match as UrlMatcher, r.url(), this.baseURL);
    return this.events.waitFor<Request>('request', test, options.timeout ?? this.timeouts.action);
  }

  /** The next fetch/XHR response matching a URL pattern or predicate. */
  async waitForResponse(
    match: UrlMatcher | ((response: Response) => boolean | Promise<boolean>),
    options: { timeout?: number } = {},
  ): Promise<Response> {
    const test =
      typeof match === 'function' && !(match instanceof RegExp)
        ? (r: Response) => (match as (r: Response) => boolean | Promise<boolean>)(r)
        : (r: Response) => urlMatches(match as UrlMatcher, r.url(), this.baseURL);
    return this.events.waitFor<Response>('response', test, options.timeout ?? this.timeouts.action);
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  /** Poll until the URL matches. */
  async waitForURL(url: UrlMatcher, options: { timeout?: number } = {}): Promise<void> {
    const budget = options.timeout ?? this.timeouts.navigation;
    const deadline = Date.now() + budget;
    for (;;) {
      const now = await this.currentURL().catch(() => '');
      if (now && urlMatches(url, now, this.baseURL)) return;
      if (Date.now() >= deadline) throw new Error(`waitForURL(${String(url)}) timed out after ${budget}ms; URL is ${now}`);
      await sleep(URL_POLL_MS);
    }
  }

  /**
   * Resolve when the page has loaded a new document (and, with `url`,
   * one whose URL matches). Start it before the action that navigates:
   * `await Promise.all([page.waitForNavigation(), link.click()])`.
   */
  async waitForNavigation(options: { url?: UrlMatcher; timeout?: number; waitUntil?: string } = {}): Promise<null> {
    const budget = options.timeout ?? this.timeouts.navigation;
    const deadline = Date.now() + budget;
    // Mark the current document; a new one will not carry the mark.
    const mark = `nav${Date.now()}${Math.random().toString(36).slice(2)}`;
    await this.rawEval(`(window.__tsNavMark = ${JSON.stringify(mark)}, 0)`).catch(() => {});
    for (;;) {
      const state = await this.rawEval<{ m: string | null; r: string; u: string } | null>(
        `({ m: window.__tsNavMark || null, r: document.readyState, u: location.href })`,
      ).catch(() => null);
      if (state && state.m !== mark && state.r !== 'loading') {
        if (!options.url || urlMatches(options.url, state.u, this.baseURL)) {
          this.snapshot = null;
          this.synced = false;
          this.fresh = false;
          this.events.documentChanged();
          return null;
        }
      }
      if (Date.now() >= deadline) throw new Error(`page.waitForNavigation: Timeout ${budget}ms exceeded.`);
      await sleep(NAV_POLL_MS);
    }
  }

  /**
   * goto() already waits for the load. A popup loads on its own, so
   * for one this waits until its document is there and loaded.
   */
  async waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', options: { timeout?: number } = {}): Promise<void> {
    if (this.popupURL) {
      const want = this.popupURL;
      const budget = options.timeout ?? this.timeouts.navigation;
      const deadline = Date.now() + budget;
      for (;;) {
        const r = await this.rawEval<string>(`location.href + ' ' + document.readyState`).catch(() => '');
        const cut = r.lastIndexOf(' ');
        const href = r.slice(0, cut);
        const ready = r.slice(cut + 1);
        const loaded = state === 'domcontentloaded' ? ready === 'interactive' || ready === 'complete' : ready === 'complete';
        if (loaded && (href !== 'about:blank' || want === 'about:blank')) {
          this.lastHref = href;
          break;
        }
        if (Date.now() >= deadline) throw new Error(`page.waitForLoadState: Timeout ${budget}ms exceeded.`);
        await sleep(POPUP_LOAD_POLL_MS);
      }
      this.popupURL = '';
    }
    await this.refreshFrames();
  }

  /**
   * Replace the document with `html`; its scripts run. On an http(s)
   * page the document is rewritten in place, so it keeps that origin
   * and relative URLs resolve against it. Otherwise the page loads the
   * HTML as a data: URL (an opaque origin, no storage): WebKit drops
   * native clicks on a rewritten about:blank.
   */
  async setContent(html: string): Promise<void> {
    const here = this.pageId ? await this.currentURL().catch(() => '') : '';
    if (!/^https?:/.test(here)) {
      const shown = here.startsWith('data:') ? here : 'about:blank';
      const data = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      await this.navigate(data);
      await this.rememberNav(shown, data);
      await this.refreshFrames();
      await this.mobileZoom.update().catch(() => {});
      return;
    }
    await this.evaluate(`(document.open(), document.write(${JSON.stringify(html)}), document.close(), 'ok')`);
    // Like Playwright, return once the new document (stylesheets, images) has loaded.
    await this.waitForFunction("document.readyState === 'complete'", undefined, { timeout: this.timeouts.navigation }).catch(() => {});
    await this.mobileZoom.update().catch(() => {});
    await this.refreshFrames();
    this.snapshot = null;
    this.synced = false;
    this.fresh = false;
  }

  /** The document's HTML, without the ref markers vibesurfer adds. */
  async content(): Promise<string> {
    return this.evaluate<string>(
      `(function(){var c=document.documentElement.cloneNode(true);c.removeAttribute('data-vs-ref');` +
        `c.querySelectorAll('[data-vs-ref]').forEach(function(e){e.removeAttribute('data-vs-ref');});` +
        `return '<!DOCTYPE html>'+c.outerHTML;})()`,
    );
  }

  /** Load the current URL again. */
  async reload(): Promise<Response | null> {
    return this.goto(await this.currentURL());
  }

  /** History back; resolves once the URL changed (or immediately when there is no history). */
  async goBack(): Promise<void> {
    await this.historyMove(-1);
  }

  async goForward(): Promise<void> {
    await this.historyMove(1);
  }

  private async historyMove(delta: number): Promise<void> {
    const before = await this.currentURL();
    await this.evaluate(`(history.go(${delta}), 'ok')`);
    // No history entry means no change; give up on the URL after a while.
    const deadline = Date.now() + HISTORY_SETTLE_MS;
    while (Date.now() < deadline) {
      await sleep(URL_POLL_MS);
      const now = await this.currentURL().catch(() => before);
      if (now !== before) break;
    }
    this.snapshot = null;
    this.synced = false;
    this.fresh = false;
    this.events.documentChanged();
  }

  /**
   * Fold a 0.2 mutation response body (the ViewForm the daemon emitted
   * while advancing its baseline) into the snapshot. Empty body means
   * NoChange; a full tree replaces; a delta applies when we hold the
   * pre-mutation baseline, otherwise the snapshot is unusable until
   * the next full view.
   */
  private applyMutationBody(resp: WireResponse): void {
    const first = resp.body[0];
    if (first === undefined) return;
    if (!isDeltaBody(first)) {
      this.snapshot = parseFullTree(resp.body);
      this.synced = true;
      this.fresh = true;
      return;
    }
    if (this.synced && this.snapshot) {
      applyDelta(this.snapshot, resp.body);
      this.fresh = true;
    } else {
      this.synced = false;
      this.fresh = false;
    }
  }

  private get id(): string {
    if (!this.pageId) throw new Error('page has no URL yet; call page.goto(url) first');
    return this.pageId;
  }

  /** setDefaultNavigationTimeout() was called, so setDefaultTimeout() leaves navigations alone. */
  private navTimeoutSet = false;

  /** @internal The shim and the WebSocket hook are in this page's documents already (a spare opened with them). */
  markShimmed(): void {
    this.shimInstalled = true;
  }

  /** Answer the page's WebSockets matching `url` with `handler` instead of the server (see WebSocketRoute). */
  async routeWebSocket(url: UrlMatcher, handler: (ws: WebSocketRoute) => unknown): Promise<void> {
    await this.hooks.routeWebSocket(url, handler);
  }

  /** @internal Run one window.__ts WebSocket call in the page. */
  async wsCall(fn: string, ...args: unknown[]): Promise<void> {
    await this.hooks.wsCall(fn, ...args);
  }

  /** @internal The web content process died: Playwright's `crash` event. */
  crashed(): void {
    this.events.emitPageEvent('crash', this);
  }

  /** Up to 200 recent console messages; `since-navigation` keeps the current document's. */
  async consoleMessages(options: { filter?: 'all' | 'since-navigation' } = {}): Promise<ConsoleMessage[]> {
    await this.events.flush().catch(() => {});
    const log = this.events.consoleLog as ConsoleMessage[];
    return options.filter === 'since-navigation' ? log.slice(this.events.navMark.console) : [...log];
  }

  /** Up to 200 recent uncaught errors; `since-navigation` keeps the current document's. */
  async pageErrors(options: { filter?: 'all' | 'since-navigation' } = {}): Promise<Error[]> {
    await this.events.flush().catch(() => {});
    const log = this.events.errorLog as Error[];
    return options.filter === 'since-navigation' ? log.slice(this.events.navMark.errors) : [...log];
  }

  async clearConsoleMessages(): Promise<void> {
    this.events.consoleLog.length = 0;
    this.events.navMark.console = 0;
  }

  async clearPageErrors(): Promise<void> {
    this.events.errorLog.length = 0;
    this.events.navMark.errors = 0;
  }

  /** Up to 100 recent requests of this page. */
  async requests(): Promise<Request[]> {
    return [...(this.events.requestLog as Request[])];
  }

  /** The page's localStorage, for the current origin. */
  readonly localStorage = this.webStorage('localStorage');
  /** The page's sessionStorage, for the current origin. */
  readonly sessionStorage = this.webStorage('sessionStorage');

  private webStorage(kind: 'localStorage' | 'sessionStorage') {
    const run = <T>(body: string, arg?: unknown) => this.evaluate<T>(`(a) => { const s = window.${kind}; ${body} }`, arg);
    return {
      clear: () => run<void>('s.clear();'),
      getItem: (name: string) => run<string | null>('return s.getItem(a);', name),
      setItem: (name: string, value: string) => run<void>('s.setItem(a[0], a[1]);', [name, value]),
      removeItem: (name: string) => run<void>('s.removeItem(a);', name),
      items: () => run<{ name: string; value: string }[]>('const out = []; for (let i = 0; i < s.length; i++) { const k = s.key(i); out.push({ name: k, value: s.getItem(k) }); } return out;'),
    };
  }

  /**
   * Run the page's garbage collector: allocation pressure, which makes
   * JavaScriptCore (and V8) collect, twice, with a task turn between so
   * WeakRefs and FinalizationRegistry callbacks settle.
   */
  async requestGC(): Promise<void> {
    for (let k = 0; k < 2; k++) {
      await this.evaluate(
        '() => new Promise((r) => { let a = []; for (let i = 0; i < 40; i++) a.push(new Array(500000).fill(i)); a = null; setTimeout(r, 0); })',
      );
    }
  }

  /** Chromium only, as in Playwright on WebKit. */
  async pdf(): Promise<never> {
    throw new Error('page.pdf: PDF generation is only supported for Headless Chromium');
  }

  /** JS and CSS coverage: Chromium only, as in Playwright on WebKit. */
  readonly coverage = {
    startJSCoverage: async (): Promise<never> => {
      throw new Error('coverage.startJSCoverage: Coverage is only supported in Chromium');
    },
    stopJSCoverage: async (): Promise<never> => {
      throw new Error('coverage.stopJSCoverage: Coverage is only supported in Chromium');
    },
    startCSSCoverage: async (): Promise<never> => {
      throw new Error('coverage.startCSSCoverage: Coverage is only supported in Chromium');
    },
    stopCSSCoverage: async (): Promise<never> => {
      throw new Error('coverage.stopCSSCoverage: Coverage is only supported in Chromium');
    },
  };

  /** Every page has its own window here; nothing is in front of another. */
  async bringToFront(): Promise<void> {}

  /** The page's dedicated workers. */
  workers(): Worker[] {
    return this.hooks.workers();
  }

  private readonly mobileZoom = new MobileZoom({
    hasDocument: () => this.pageId !== null,
    screenWidth: () => this.viewport?.width,
    evaluate: (fn, arg) => this.evaluate(fn, arg),
    setZoom: async (zoom) => {
      await this.client.call('vs_viewport', [this.id, 'keep'], { session: this.sessionId, zoom: String(zoom) });
    },
    onDomContentLoaded: (listener) => {
      this.on('domcontentloaded', listener);
    },
  });

  /** @internal Honor the viewport meta tag, as a mobile browser does (Playwright's isMobile). */
  enableMobile(): void {
    this.mobileZoom.enable();
  }

  /** Fake time for this page (Playwright's page.clock). */
  readonly clock = new Clock({
    evaluate: (script) => this.evaluate(`() => { ${script} }`),
    addInitScript: (script) => this.addInitScript(script),
  });

  /** Timeout for actions and, unless setDefaultNavigationTimeout() set one, navigations. */
  setDefaultTimeout(ms: number): void {
    this.timeouts.action = ms;
    if (!this.navTimeoutSet) this.timeouts.navigation = ms;
  }

  /** Timeout for goto, reload, waitForURL and the other navigations. */
  setDefaultNavigationTimeout(ms: number): void {
    this.navTimeoutSet = true;
    this.timeouts.navigation = ms;
  }

  /** Drag the element at `source` onto the one at `target`. */
  async dragAndDrop(source: string, target: string, options: { timeout?: number } = {}): Promise<void> {
    await this.locator(source).dragTo(this.locator(target), options);
  }

  /** Touch input (Playwright's touchscreen). */
  readonly touchscreen = new Touchscreen(this.inputHost());

  /** Reports each file the page saves as a `download` event. */
  private readonly downloads = new DownloadWatcher({
    page: this,
    list: async () => {
      if (!this.pageId) return null;
      const r = await this.client.call('vs_download', [this.pageId], { session: this.sessionId, list: true });
      return r.body;
    },
    save: async (id, dest) => {
      const got = await this.client.call('vs_download', [this.id], { session: this.sessionId, id: String(id), dest });
      const line = got.body.find((l) => l.startsWith('path\t'));
      return line ? line.slice(5) : dest;
    },
    emit: (download) => this.events.emitPageEvent('download', download),
  });

  /** @internal The page's wire id, opening its web view first if it has none yet. */
  async openedId(): Promise<string> {
    await this.ensureOpen();
    return this.id;
  }

  /**
   * A new page starts at about:blank, as in Playwright: the first call
   * that needs a document opens one (with the init scripts installed).
   */
  private async ensureOpen(): Promise<void> {
    if (this.pageId) return;
    if (this.closedFlag) throw new Error('Target page, context or browser has been closed');
    const resp = await this.client.call('vs_open', ['about:blank'], { session: this.sessionId });
    const id = resp.body[0];
    if (!id) throw new Error('vs_open returned no page id for about:blank');
    this.pageId = id;
    await this.applyViewport();
    this.token = resp.token;
    this.shimInstalled = true;
    for (const src of this.initScripts) {
      await this.client.call('vs_init_script', [id, src], { session: this.sessionId });
    }
    this.events.documentChanged();
  }

  /**
   * Navigate to a URL, relative to the baseURL launch option when set.
   * Navigates in place on protocol-v1 daemons; older ones close the
   * page and open a new one.
   */
  async goto(target: string, _options: { waitUntil?: string; timeout?: number; referer?: string } = {}): Promise<Response | null> {
    try {
      await this.events.beforeNavigation();
      // Shim mode: the in-page shim cannot see a document request, so
      // the page's routes decide it here.
      const url = this.baseURL ? new URL(target, this.baseURL).href : target;
      const routed = /^https?:/.test(url) ? await this.events.routeDocument(url) : null;
      if (routed?.kind === 'abort') this.events.netNavAborted();
      if (routed?.kind === 'abort') throw new Error('aborted by route');
      if (routed?.kind === 'fulfill') {
        await this.navigate(url, routed.body);
        const res = new Response(routed.req, { url, status: routed.status, statusText: '', headers: routed.headers });
        res.bodyLoader = async () => routed.body;
        routed.req.responseValue = res;
        return res;
      }
      await this.navigate(routed?.kind === 'continue' ? routed.url : target);
    } catch (e) {
      // A route that aborted the document fails the navigation the way WebKit reports it.
      if (this.events.abortedNavigation()) throw new Error(`page.goto: Blocked by Web Inspector`);
      throw e;
    }
    const viaProxy = await this.events.proxiedNavResponse();
    const res = viaProxy ?? (await this.mainResponse());
    if (res || !target.startsWith('file:')) return res;
    // A file: page has a response too, with status 0, as in WebKit under Playwright.
    const req = new Request({ id: 0, url: target, method: 'GET', headers: {}, body: null, type: 'document', navigation: true });
    req.frameValue = this.mainFrame();
    const fileRes = new Response(req, { url: target, status: 0, statusText: '', headers: {} });
    req.responseValue = fileRes;
    return fileRes;
  }

  /**
   * The main document's response after a navigation (vibesurfer 0.2.16+
   * `vs_inspect response`), or null for data:, about: and file: URLs or
   * on older daemons.
   */
  private async mainResponse(): Promise<Response | null> {
    if (!this.pageId) return null;
    let body: string[];
    try {
      body = (await this.client.call('vs_inspect', ['response', this.pageId], { session: this.sessionId })).body;
    } catch {
      return null;
    }
    if (body.length === 0 || body[0] === 'none') return null;
    let url = '';
    let status = 0;
    let statusText = '';
    const headers: Record<string, string> = {};
    for (const line of body) {
      if (line.startsWith('url=')) url = line.slice(4);
      else if (line.startsWith('status=')) status = Number(line.slice(7));
      else if (line.startsWith('status_text=')) statusText = line.slice(12);
      else if (line.startsWith('h ')) {
        const i = line.indexOf(': ');
        if (i > 2) {
          const k = line.slice(2, i);
          const v = line.slice(i + 2);
          headers[k] = headers[k] === undefined ? v : `${headers[k]}, ${v}`;
        }
      }
    }
    // Responses do not carry the fragment.
    url = url.replace(/#.*$/, '');
    const req = new Request({ id: 0, url, method: 'GET', headers: {}, body: null, type: 'document' });
    req.frameValue = this.mainFrame();
    const res = new Response(req, { url, status, statusText, headers });
    req.responseValue = res;
    res.bodyLoader = async () => {
      const b64 = await this.evaluate<string>(
        `fetch(${JSON.stringify(url)}, { credentials: 'include' }).then((r) => r.arrayBuffer()).then((b) => { let s = ''; const a = new Uint8Array(b); for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode.apply(null, a.subarray(i, i + 32768)); return btoa(s); })`,
      );
      return Buffer.from(b64, 'base64');
    };
    return res;
  }

  /** `html`: load that document under the URL instead of fetching it (a routed document). */
  private async navigate(target: string, html?: Buffer): Promise<void> {
    const url = this.baseURL ? new URL(target, this.baseURL).href : target;
    const gotoFlags: Record<string, string> = { session: this.sessionId };
    if (html) gotoFlags['html'] = html.toString('base64');
    if (this.pageId && this.navInPlace) {
      try {
        const resp = await this.client.call('vs_goto', [this.pageId, url], gotoFlags);
        this.token = resp.token;
        this.snapshot = null;
        this.synced = false;
        this.fresh = false;
        this.events.documentChanged();
        await this.rememberNav(url, url);
        await this.refreshFrames();
        return;
      } catch {
        // Old daemon or dead page; fall through to close+open.
      }
    }
    if (this.pageId) {
      await this.client
        .call('vs_close', [this.pageId], { session: this.sessionId })
        .catch(() => {});
      this.pageId = null;
    }
    this.token = null;
    this.snapshot = null;
    this.synced = false;
    this.fresh = false;
    // Init scripts have to be in place before the first document, so
    // a page that has them opens blank, installs them, then loads.
    const first = this.initScripts.length > 0 || html ? 'about:blank' : url;
    const resp = await this.client.call('vs_open', [first], { session: this.sessionId });
    const id = resp.body[0];
    if (!id) throw new Error(`vs_open returned no page id for ${url}`);
    this.pageId = id;
    await this.applyViewport();
    this.token = resp.token;
    if (first !== url) {
      for (const src of this.initScripts) {
        await this.client.call('vs_init_script', [id, src], { session: this.sessionId });
      }
      const nav = await this.client.call('vs_goto', [id, url], gotoFlags);
      this.token = nav.token;
    }
    this.events.documentChanged();
    await this.rememberNav(url, url);
    await this.refreshFrames();
    // No settle wait here: locators auto-wait and assertions poll, so
    // a still-loading tree just resolves a poll tick later.
  }

  /**
   * Refresh the snapshot from the daemon and return it. Sends a plain
   * (delta) view when our snapshot matches the daemon's baseline and a
   * `--full` view otherwise; the body shape decides how it is applied,
   * so a surprise full tree (navigation, daemon restart) is handled
   * either way.
   */
  async view(): Promise<Snapshot> {
    await this.ensureOpen();
    const canDelta = this.synced && this.snapshot !== null;
    const flags: Record<string, string | true> = { session: this.sessionId };
    if (!canDelta) flags['full'] = true;
    const resp = await this.client.call('vs_view', [this.id], flags);
    return this.applyViewResponse(resp, canDelta);
  }

  /**
   * One round trip for view + layout via the `--layout=` composite:
   * the daemon appends rect lines for the requested refs as an extra
   * body section. Refs no longer in the tree come back as inline
   * NOT_FOUND lines and are simply absent from the map.
   */
  async viewWithLayout(refs: number[]): Promise<{ snap: Snapshot; rects: Map<number, LayoutRect> }> {
    if (refs.length === 0) {
      return { snap: await this.view(), rects: new Map() };
    }
    const canDelta = this.synced && this.snapshot !== null;
    const flags: Record<string, string | true> = {
      session: this.sessionId,
      layout: refs.join(','),
    };
    if (!canDelta) flags['full'] = true;
    const resp = await this.client.call('vs_view', [this.id], flags, { extraSections: 1 });
    const snap = this.applyViewResponse(resp, canDelta);
    return { snap, rects: parseLayoutLines(resp.sections[0] ?? []) };
  }

  private applyViewResponse(resp: WireResponse, canDelta: boolean): Snapshot {
    this.token = resp.token;
    const first = resp.body[0];
    if (first === undefined) {
      // No change since our baseline (or a genuinely empty page).
      this.snapshot ??= { nodes: new Map(), roots: [] };
    } else if (canDelta && this.snapshot && isDeltaBody(first)) {
      applyDelta(this.snapshot, resp.body);
    } else {
      this.snapshot = parseFullTree(resp.body);
    }
    this.synced = true;
    this.fresh = true;
    return this.snapshot;
  }

  /**
   * Snapshot for resolving an action target: the cached tree when it
   * is still baseline-synced, otherwise a fresh view. Acting on a
   * cached tree is safe because every mutation carries our token; if
   * the page moved on, the daemon answers STALE_TOKEN and the action
   * loop re-resolves against a fresh view.
   */
  async actionSnapshot(): Promise<Snapshot> {
    if (this.fresh && this.snapshot) return this.snapshot;
    return this.view();
  }

  /**
   * Run one act primitive against a ref with the cached token. On
   * STALE_TOKEN the cached token is refreshed before rethrowing, so
   * the caller can re-resolve and retry.
   */
  async act(ref: number, op: string, value?: string, extraFlags?: Record<string, string>): Promise<void> {
    if (this.token === null) await this.view();
    const args = value === undefined ? [this.id, String(ref), op] : [this.id, String(ref), op, value];
    try {
      const resp = await this.client.call('vs_act', args, {
        ...extraFlags,
        session: this.sessionId,
        token: this.token ?? '',
      });
      this.token = resp.token;
      if (this.actDeltas) {
        this.applyMutationBody(resp);
      } else {
        // 0.1.x: the act advanced the daemon's delta baseline without
        // showing us the delta; the cached tree cannot be patched.
        this.synced = false;
        this.fresh = false;
      }
    } catch (e) {
      if (await this.closedByItself(e)) return;
      if (e instanceof WireError && e.code === 'STALE_TOKEN' && e.args[0]) {
        this.token = e.args[0];
      }
      this.synced = false;
      this.fresh = false;
      throw e;
    }
  }

  /**
   * The action made the page close itself (a popup's "Close" button):
   * vibesurfer released the page under the action, which then finds
   * nothing. The action did its work; the close event follows on the
   * event stream.
   */
  private async closedByItself(e: unknown): Promise<boolean> {
    if (!(e instanceof WireError) || e.code !== 'NOT_FOUND' || !String(e.args[0] ?? '').startsWith('page=')) return false;
    if (this.openerPage === undefined) return false;
    const deadline = Date.now() + SELF_CLOSE_GRACE_MS;
    while (!this.closedFlag && Date.now() < deadline) await sleep(NAV_POLL_MS);
    return this.closedFlag;
  }

  /**
   * Trusted native click at viewport coordinates via vs_click_at. The
   * cursor op leaves the daemon's delta baseline and last token
   * untouched, so `synced` survives (the next delta view picks up the
   * click's effects) but `fresh` does not.
   */
  async clickAt(
    x: number,
    y: number,
    mode?: InputMode,
    opts: { count?: number | undefined; button?: 'left' | 'right' | 'middle' | undefined; modifiers?: string[] | undefined } = {},
  ): Promise<void> {
    await this.ensureOpen();
    const z = await this.mobileZoom.ready();
    x *= z;
    y *= z;
    const flags: Record<string, string> = { session: this.sessionId, token: this.token ?? '0', mode: mode ?? this.inputMode };
    if (opts.button && opts.button !== 'left') flags['button'] = opts.button;
    if (opts.count && opts.count > 1) flags['count'] = String(Math.min(3, opts.count));
    const mods = (opts.modifiers ?? []).map((m) => (m === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'meta' : 'ctrl') : m === 'Control' ? 'ctrl' : m.toLowerCase()));
    if (mods.length) flags['modifiers'] = mods.join(',');
    try {
      const resp = await this.client.call(
        'vs_click_at',
        [this.id, String(Math.round(x * 100) / 100), String(Math.round(y * 100) / 100)],
        flags,
      );
      this.token = resp.token;
      if (this.actDeltas) {
        this.applyMutationBody(resp);
      } else {
        // 0.1.x cursor ops leave the baseline (and token) untouched;
        // the snapshot just needs a re-read before the next action.
        this.fresh = false;
      }
    } catch (e) {
      if (await this.closedByItself(e)) return;
      if (e instanceof WireError && e.code === 'STALE_TOKEN' && e.args[0]) {
        this.token = e.args[0];
      }
      this.synced = false;
      this.fresh = false;
      throw e;
    }
  }

  /**
   * Text of one ref and its subtree via vs_read. The body renders each
   * node as `[ref] role: label`, indented; the labels are the text.
   */
  async readRef(ref: number): Promise<string> {
    const resp = await this.client.call('vs_read', [this.id, String(ref)], {
      session: this.sessionId,
    });
    this.token = resp.token;
    return resp.body
      .map((l) => l.replace(/^\s*\[\d+\] [^:]*: ?/, ''))
      .filter((l) => l.trim() !== '')
      .join(' ');
  }

  /** Trusted per-character typing into the focused element. */
  async typeTrusted(text: string, options?: { secret?: boolean; mode?: InputMode }): Promise<void> {
    await this.ensureOpen();
    const flags: Record<string, string | true> = {
      session: this.sessionId,
      token: this.token ?? '',
      mode: options?.mode ?? this.inputMode,
    };
    if (options?.secret) flags['secret'] = true;
    try {
      const resp = await this.client.call('vs_type', [this.id, text], flags);
      this.token = resp.token;
      // vs_type advances neither baseline nor token on any released
      // engine; the snapshot stays delta-patchable but not fresh.
      this.fresh = false;
    } catch (e) {
      this.synced = false;
      this.fresh = false;
      throw e;
    }
  }

  /**
   * Block until a daemon-side wait condition holds. The returned wait
   * token is deliberately not cached: vs_wait computes it from a raw
   * engine snapshot without advancing the page's last-emitted token,
   * so it is not valid as an act pre-image.
   */
  async waitFor(
    cond: 'stable' | 'net-idle' | 'token-change' | 'text' | 'ref' | 'gone',
    value?: string,
    timeoutMs?: number,
  ): Promise<void> {
    const args = value === undefined ? [this.id, cond] : [this.id, cond, value];
    const budget = timeoutMs ?? this.timeouts.navigation;
    const resp = await this.client.call(
      'vs_wait',
      args,
      { session: this.sessionId, timeout: String(budget) },
      { timeoutMs: budget + 10_000 },
    );
    if (this.actDeltas) {
      // 0.2 wait advances the baseline without emitting the tree; the
      // token is a valid pre-image but the snapshot must be re-read.
      this.token = resp.token;
      this.synced = false;
      this.fresh = false;
    }
  }

  /**
   * Bounding rects for refs via vs_layout. Body lines look like
   * `<ref> x=0 y=0 w=0 h=0 visible=false z=0`.
   */
  async layout(refs: number[]): Promise<Map<number, LayoutRect>> {
    if (refs.length === 0) return new Map();
    const resp = await this.client.call('vs_layout', [this.id, ...refs.map(String)], {
      session: this.sessionId,
    });
    this.token = resp.token;
    return parseLayoutLines(resp.body);
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
  private async rawEval<T>(src: string, frame: string | null = null): Promise<T> {
    await this.ensureOpen();
    const flags: Record<string, string | true> = { session: this.sessionId, full: true };
    // A subframe by URL, cross-origin ones included (vibesurfer 0.2.16+).
    if (frame !== null) flags['frame'] = frame;
    const resp = await this.client.call('vs_inspect', ['eval', this.id, `JSON.stringify(${src}) ?? "null"`], flags);
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
      if (typeof (r as { u?: unknown }).u === 'string') this.lastHref = (r as { u: string }).u;
      if (typeof (r as { sw?: unknown }).sw === 'boolean') this.swControlled = (r as { sw: boolean }).sw;
      // Keep frames() current: re-read the frame tree when the page's iframe count changed.
      const fc = (r as { fc?: number } | null)?.fc;
      if (typeof fc === 'number' && body !== FRAMES_CALL) await this.frameTree.noteCount(fc);
    }
    // Bindings, console messages and page errors a call caused are
    // delivered before it returns, as Playwright's protocol events are.
    if ((this.events.hasBindings || this.events.hasListeners('console') || this.events.hasListeners('pageerror')) && !body.startsWith('E.doc')) {
      await this.events.flush();
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

  /** One locator-engine request (see src/injected.ts). `fn` is a function source passed alongside. */
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

  private readonly locatorHandlers = new LocatorHandlers();

  /** Log lines from the last locator-handler run that blocked a wait. */
  get handlerLog(): string[] {
    return this.locatorHandlers.log;
  }

  /**
   * Run `handler` whenever `locator` becomes visible while an action or
   * assertion is waiting (a cookie banner, a newsletter dialog). By
   * default the wait resumes once the locator is hidden again.
   */
  async addLocatorHandler(
    locator: Locator,
    handler: (locator: Locator) => unknown,
    options: { times?: number; noWaitAfter?: boolean } = {},
  ): Promise<void> {
    this.locatorHandlers.add(locator, handler, options);
  }

  async removeLocatorHandler(locator: Locator): Promise<void> {
    this.locatorHandlers.remove(locator);
  }

  /**
   * @internal Run the handlers whose locator is visible now. Called on
   * each action and assertion retry. Returns false while a handled
   * locator has not gone away yet.
   */
  async runLocatorHandlers(deadline = Date.now() + this.timeouts.action): Promise<boolean> {
    return this.locatorHandlers.run(deadline);
  }

  /** Poll `fn(arg)` in the page until it returns a truthy value, and return that value. */
  async waitForFunction<T = unknown, A = unknown>(
    fn: string | ((arg: A) => unknown),
    arg?: A,
    options: { timeout?: number; polling?: number | 'raf' } = {},
  ): Promise<JSHandle & { jsonValue(): Promise<T> }> {
    const budget = options.timeout ?? this.timeouts.action;
    const deadline = Date.now() + budget;
    const every = typeof options.polling === 'number' ? options.polling : 16;
    const a = JSON.stringify(serializeValue(arg));
    const src = typeof fn === 'function' ? fn.toString() : fn;
    // A truthy value is adopted in the same call and handed back as a JSHandle, as in Playwright.
    const body =
      `(function(){var f=(${src});var v=typeof f==='function'?f(E.des(${a})):f;` +
      `var fin=function(x){return x?E.adoptValue(x):null;};return v&&typeof v.then==='function'?v.then(fin):fin(v);})()`;
    for (;;) {
      const r = (await this.engineCall(body)) as { id: number; el: boolean; p?: string } | null;
      if (r) {
        const h = r.el ? new ElementHandle(this, r.id) : new JSHandle(this, r.id);
        h.previewText = r.p ?? '';
        return h as JSHandle & { jsonValue(): Promise<T> };
      }
      if (budget > 0 && Date.now() >= deadline) {
        throw new Error(`page.waitForFunction: Timeout ${budget}ms exceeded.`);
      }
      await sleep(every);
    }
  }

  /** `fn(element, arg)` on the first element matching `selector`; throws when there is none. */
  async $eval<R, A = unknown>(selector: string, fn: string | ((el: any, arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    const r = await this.engineRun<{ v?: R; none?: boolean }>(
      { steps: this.locator(selector).wire(), op: 'eval', args: { arg: serializeValue(arg) }, first: true },
      fn.toString(),
    );
    if (r.none) throw new Error(`page.$eval: Error: failed to find element matching selector "${selector}"`);
    return r.v as R;
  }

  /** `fn(elements, arg)` with every element matching `selector`. */
  async $$eval<R, A = unknown>(selector: string, fn: string | ((els: any[], arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    return this.locator(selector).evaluateAll(fn, arg);
  }

  /** The first element matching `selector`, or null. */
  async $(selector: string): Promise<ElementHandle | null> {
    return this.locator(selector).firstHandle();
  }

  /** Every element matching `selector`. */
  async $$(selector: string): Promise<ElementHandle[]> {
    return this.locator(selector).elementHandles();
  }

  private readonly frameTree = new FrameTree({
    page: this,
    baseURL: () => this.baseURL,
    engineCall: (body) => this.engineCall(body),
  });

  /** The page's top frame. */
  mainFrame(): Frame {
    return this.frameTree.mainFrame();
  }

  /**
   * The main frame, then every iframe, depth first, as of the last
   * navigation or refreshFrames() call (Playwright's frames() is
   * synchronous; testsurfer reads the frame tree after each load).
   */
  frames(): Frame[] {
    return this.frameTree.all();
  }

  /** Re-read the frame tree, for iframes added after the page loaded. */
  async refreshFrames(): Promise<Frame[]> {
    return this.frameTree.refresh();
  }

  /** A frame by name, or by URL (string, RegExp or predicate). */
  frame(match: FrameMatch): Frame | null {
    return this.frameTree.find(match);
  }

  /**
   * Make `fn` callable from the page as `window[name](...args)`; the
   * call returns a promise of fn's result. Arguments and results cross
   * as JSON. Covers this document and every later one.
   */
  async exposeFunction(name: string, fn: (...args: any[]) => unknown): Promise<void> {
    await this.exposeBinding(name, (_source: unknown, ...args: unknown[]) => fn(...args));
  }

  /** Like exposeFunction, with `{ page, context, frame }` as the first argument. */
  async exposeBinding(name: string, fn: (source: { page: Page; context: BrowserContext | null; frame: Frame }, ...args: any[]) => unknown): Promise<void> {
    const script = this.events.addBinding(name, (...args: unknown[]) =>
      fn({ page: this, context: this.ctx, frame: this.mainFrame() }, ...args),
    );
    await this.ensureShim();
    await this.addInitSource(script);
    await this.events.sync();
    if (this.pageId) await this.rawEval(`(${script.replace(/;\s*$/, '')}, 0)`).catch(() => {});
  }

  private extraHeaders: Record<string, string> = {};

  /** @internal Re-apply routing after the context's network settings changed. */
  async refreshNetwork(): Promise<void> {
    await this.events.sync();
  }

  /**
   * Headers added to every request this page makes. In proxy mode they
   * reach every http request; otherwise fetch and XHR only.
   */
  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    this.extraHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    await this.events.sync();
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
    const h = r.el ? new ElementHandle(this, r.id) : new JSHandle(this, r.id);
    h.previewText = r.p ?? '';
    return h;
  }

  /** Wait for `selector` to reach a state (visible by default); returns the element as a locator. */
  async waitForSelector(
    selector: string,
    options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {},
  ): Promise<ElementHandle | null> {
    const l = this.locator(selector);
    await l.first().waitFor(options);
    return options.state === 'detached' || options.state === 'hidden' ? null : l.firstHandle();
  }

  // Selector shorthands (Playwright's page.click(selector) family).
  // Not strict unless asked (`strict: true`): the first match acts, as in Playwright.
  private pick(selector: string, options?: object): Locator {
    const l = this.locator(selector);
    return (options as { strict?: boolean } | undefined)?.strict ? l : l.first();
  }
  click(selector: string, options?: ClickOptions): Promise<void> {
    return this.pick(selector, options).click(options);
  }
  dblclick(selector: string, options?: ClickOptions): Promise<void> {
    return this.pick(selector, options).dblclick(options);
  }
  tap(selector: string, options?: ClickOptions): Promise<void> {
    return this.pick(selector, options).tap(options);
  }
  hover(selector: string, options?: { timeout?: number; force?: boolean }): Promise<void> {
    return this.pick(selector, options).hover(options);
  }
  focus(selector: string, options?: { timeout?: number }): Promise<void> {
    return this.pick(selector, options).focus(options);
  }
  fill(selector: string, value: string, options?: { timeout?: number; force?: boolean }): Promise<void> {
    return this.pick(selector, options).fill(value, options);
  }
  type(selector: string, text: string, options?: { timeout?: number }): Promise<void> {
    return this.pick(selector, options).type(text, options);
  }
  press(selector: string, key: string, options?: { timeout?: number }): Promise<void> {
    return this.pick(selector, options).press(key, options);
  }
  check(selector: string, options?: ClickOptions): Promise<void> {
    return this.pick(selector, options).check(options);
  }
  uncheck(selector: string, options?: ClickOptions): Promise<void> {
    return this.pick(selector, options).uncheck(options);
  }
  setChecked(selector: string, checked: boolean, options?: ClickOptions): Promise<void> {
    return this.pick(selector, options).setChecked(checked, options);
  }
  selectOption(selector: string, values: SelectOptionValue | SelectOptionValue[] | null, options?: { timeout?: number }): Promise<string[]> {
    return this.pick(selector, options).selectOption(values, options);
  }
  setInputFiles(selector: string, files: InputFile | InputFile[], options?: { timeout?: number }): Promise<void> {
    return this.pick(selector, options).setInputFiles(files, options);
  }
  dispatchEvent(selector: string, type: string, eventInit?: Record<string, unknown>, options?: { timeout?: number }): Promise<void> {
    return this.pick(selector, options).dispatchEvent(type, eventInit, options);
  }
  textContent(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.pick(selector, options).textContent(options);
  }
  innerText(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.pick(selector, options).innerText(options);
  }
  innerHTML(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.pick(selector, options).innerHTML(options);
  }
  getAttribute(selector: string, name: string, options?: { timeout?: number }): Promise<string | null> {
    return this.pick(selector, options).getAttribute(name, options);
  }
  inputValue(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.pick(selector, options).inputValue(options);
  }
  isVisible(selector: string): Promise<boolean> {
    return this.pick(selector).isVisible();
  }
  isHidden(selector: string): Promise<boolean> {
    return this.pick(selector).isHidden();
  }
  isChecked(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.pick(selector, options).isChecked(options);
  }
  isDisabled(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.pick(selector, options).isDisabled(options);
  }
  isEnabled(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.pick(selector, options).isEnabled(options);
  }
  isEditable(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.pick(selector, options).isEditable(options);
  }

  /** Keyboard input to the focused element. */
  readonly keyboard = new Keyboard(this.inputHost());

  private viewport: { width: number; height: number } | null = null;
  private dpr = 1;

  /** @internal Size every new web view of this page gets. */
  initialViewport(size: { width: number; height: number } | null, dpr: number): void {
    this.viewport = size;
    this.dpr = dpr;
  }

  /**
   * @internal Take over a blank page the browser opened ahead of time
   * (see Browser.newContext), already sized to `sized`. The first goto
   * then navigates it in place instead of opening a web view.
   */
  async adoptBlank(pageId: string, token: string, sized: { width: number; height: number; dpr: number } | null): Promise<void> {
    this.pageId = pageId;
    this.token = token;
    const same = sized && this.viewport && sized.width === this.viewport.width && sized.height === this.viewport.height && sized.dpr === this.dpr;
    if (!same) await this.applyViewport();
    this.events.documentChanged();
  }

  private async applyViewport(): Promise<void> {
    if (!this.viewport || !this.pageId) return;
    await this.client.call('vs_viewport', [this.pageId, `${this.viewport.width}x${this.viewport.height}`], {
      session: this.sessionId,
      dpr: String(this.dpr),
    });
    this.snapshot = null;
    this.synced = false;
    this.fresh = false;
  }

  /** Resize the page (CSS px). */
  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    this.viewport = { width: size.width, height: size.height };
    await this.applyViewport();
  }

  viewportSize(): { width: number; height: number } | null {
    return this.viewport ? { ...this.viewport } : null;
  }

  /** Viewport crop of the page around `box` (CSS px), as PNG bytes; written to `path` when given. */
  async screenshotClip(box: BoundingBox, path?: string): Promise<Buffer> {
    const file = await this.capture(null);
    const fs = await import('node:fs/promises');
    const img = decodePng(await fs.readFile(file));
    const cssWidth = await this.evaluate<number>('window.innerWidth');
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
    // The engine captures at the screen's scale; deliver the configured device scale factor.
    const factor = Math.round(scale / this.dpr);
    const out = encodePng(factor > 1 ? downscale({ width: w, height: h, data }, factor) : { width: w, height: h, data });
    if (path) {
      const nodePath = await import('node:path');
      await fs.mkdir(nodePath.dirname(path), { recursive: true });
      await fs.writeFile(path, out);
    }
    return out;
  }

  /** The page's current URL. */
  /** The location every engine call reports; Playwright's page.url() is synchronous. */
  private lastHref = 'about:blank';
  /** A service worker controlled the page as of the last engine call. */
  private swControlled = false;

  /** The page's URL as of the last call into the page (actions, reads and navigations all refresh it). */
  url(): string {
    return this.shownURL(this.lastHref);
  }

  /** Read location.href now. */
  private async currentURL(): Promise<string> {
    this.lastHref = await this.evaluate<string>('location.href');
    return this.url();
  }

  private shownURL(href: string): string {
    const nav = this.navURL;
    if (!nav || href !== nav.actual) {
      // WebKit percent-encodes data: URLs; show them as written.
      if (href.startsWith('data:')) {
        try {
          return decodeURI(href);
        } catch {
          return href;
        }
      }
      return href;
    }
    // The engine percent-encodes a data: URL; report it as given, and a
    // setContent() page as the about:blank Playwright would show.
    return nav.shown;
  }

  /** What goto() was asked for, and what the engine then reports. */
  private navURL: { shown: string; actual: string } | null = null;

  private async rememberNav(shown: string, requested: string): Promise<void> {
    if (!requested.startsWith('data:')) {
      this.navURL = null;
      return;
    }
    const actual = await this.evaluate<string>('location.href').catch(() => '');
    this.navURL = actual ? { shown, actual } : null;
  }

  /**
   * Save a PNG of the viewport (or the whole page with `fullPage`).
   * Returns the file path; with `path`, the file is copied there.
   */
  async screenshot(options: { path?: string; fullPage?: boolean; clip?: BoundingBox } = {}): Promise<Buffer> {
    if (options.clip) return this.screenshotClip(options.clip, options.path);
    const file = await this.capture(null, options.fullPage ? { fullPage: true } : {});
    const fs = await import('node:fs/promises');
    let buf: Buffer = await fs.readFile(file);
    const img = decodePng(buf);
    const cssWidth = await this.evaluate<number>('window.innerWidth');
    const factor = Math.round(img.width / (cssWidth || img.width) / this.dpr);
    if (factor > 1) buf = encodePng(downscale(img, factor));
    if (options.path) {
      const nodePath = await import('node:path');
      await fs.mkdir(nodePath.dirname(options.path), { recursive: true });
      await fs.writeFile(options.path, buf);
    }
    return buf;
  }

  /** PNG of the page, or of one element when `ref` is given. Returns the file path. */
  async capture(ref: number | null, options: { path?: string; fullPage?: boolean } = {}): Promise<string> {
    await this.ensureOpen();
    const flags: Record<string, string | true> = { session: this.sessionId };
    if (options.fullPage) flags['full-page'] = true;
    const args = ref === null ? [this.id] : [this.id, String(ref)];
    const resp = await this.client.call('vs_capture', args, flags);
    const saved = (resp.body[0] ?? '').trim();
    if (!saved) throw new Error('vs_capture returned no path');
    if (!options.path) return saved;
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    await fs.mkdir(nodePath.dirname(options.path), { recursive: true });
    await fs.copyFile(saved, options.path);
    return options.path;
  }

  /**
   * Save this page's login state (cookies, local and session storage,
   * IndexedDB) under `name`, encrypted at rest by the daemon. Load it
   * in a later run with loadAuth(name) to skip the login flow.
   */
  /** @internal Load an imported cookie blob into this page's jar (the session's). */
  async loadCookieBlob(name: string): Promise<void> {
    await this.ensureOpen();
    await this.client.call('vs_auth', ['load', this.id, name], { session: this.sessionId });
    await this.client.call('vs_auth', ['clear', name], { session: this.sessionId }).catch(() => {});
  }

  async saveAuth(name: string): Promise<void> {
    await this.client.call('vs_auth', ['save', this.id, name], { session: this.sessionId });
  }

  /**
   * Restore login state saved with saveAuth(name). Storage is per
   * origin, so goto() a page on the site first, then load, then goto()
   * the page under test.
   */
  async loadAuth(name: string): Promise<void> {
    // The reply carries the zero token, not a page state; re-read later.
    await this.client.call('vs_auth', ['load', this.id, name], { session: this.sessionId });
    this.token = null;
    this.synced = false;
    this.fresh = false;
  }

  /** Delete login state saved under `name`. */
  async clearAuth(name: string): Promise<void> {
    await this.client.call('vs_auth', ['clear', name], { session: this.sessionId });
  }

  /** Trusted native pointer input at viewport coordinates (CSS px). */
  readonly mouse = new Mouse(this.inputHost());

  /** What page.mouse, page.keyboard and page.touchscreen drive. */
  private inputHost(): InputHost {
    return {
      cursorOp: (op, coords, mode, mutates) => this.cursorOp(op, coords, mode, mutates),
      clickAt: (x, y, mode, opts) => this.clickAt(x, y, mode, opts),
      nativeWheel: () => this.nativeWheel,
      evaluate: (fn, arg) => this.evaluate(fn, arg),
      engineCall: (body) => this.engineCall(body),
      typeTrusted: (text) => this.typeTrusted(text),
    };
  }

  private async cursorOp(op: string, coords: number[], mode: InputMode | undefined, mutates: boolean): Promise<void> {
    await this.ensureOpen();
    const z = await this.mobileZoom.ready();
    // A wheel's deltas are CSS px of scrolling, not points on the screen.
    if (z !== 1) coords = coords.map((c, i) => (op === 'vs_wheel' && i >= 2 ? c : c * z));
    const flags: Record<string, string> = { session: this.sessionId, mode: mode ?? this.inputMode };
    if (mutates) flags['token'] = this.token ?? '0';
    try {
      const resp = await this.client.call(op, [this.id, ...coords.map((c) => String(Math.round(c)))], flags);
      if (resp.token && !/^0+$/.test(resp.token)) this.token = resp.token;
      if (mutates && this.actDeltas) this.applyMutationBody(resp);
      else this.fresh = false;
    } catch (e) {
      if (e instanceof WireError && e.code === 'STALE_TOKEN' && e.args[0]) {
        this.token = e.args[0];
      }
      this.synced = false;
      this.fresh = false;
      throw e;
    }
  }

  /** The whole page as template text (see toMatchAriaSnapshot). */
  async ariaSnapshot(): Promise<string> {
    const snap = await this.view();
    return renderSnapshot(snap, snap.roots);
  }

  /** The document title. */
  async title(): Promise<string> {
    return this.evaluate<string>('document.title');
  }

  getByRole(role: string, options: ByRoleOptions = {}): Locator {
    return new Locator(this, { kind: 'role', role, options });
  }

  getByText(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return new Locator(this, { kind: 'text', text, options });
  }

  getByLabel(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return new Locator(this, { kind: 'label', text, options });
  }

  /** Locators inside the iframe matching `selector` (same-origin frames, vibesurfer 0.2.15+). */
  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this.locator(selector));
  }

  /** Elements matching a CSS selector, mapped to their tree nodes. */
  locator(selector: string, options?: LocatorOptions): Locator {
    const l = new Locator(this, selectorSteps(selector));
    return options && Object.keys(options).length ? l.filter(options) : l;
  }

  /** Exact match on the test-id attribute (`data-testid` by default). */
  getByTestId(id: string | RegExp): Locator {
    return new Locator(this, byAttr('getByTestId', this.testIdAttribute, id, true));
  }

  /** Fields by placeholder text (substring, case-insensitive; exact for whole-string). */
  getByPlaceholder(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return new Locator(this, byAttr('getByPlaceholder', 'placeholder', text, options.exact ?? false));
  }

  /** Images and areas by alt text. */
  getByAltText(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return new Locator(this, byAttr('getByAltText', 'alt', text, options.exact ?? false));
  }

  /** Elements by their title attribute. */
  getByTitle(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return new Locator(this, byAttr('getByTitle', 'title', text, options.exact ?? false));
  }

  async close(): Promise<void> {
    if (this.closedFlag) return;
    for (const h of this.harWriters.splice(0)) await h.save().catch(() => {});
    if (this.videoValue && this.pageId) {
      const r = await this.client.call('vs_record', ['stop', this.pageId], { session: this.sessionId }).catch(() => null);
      const line = r?.body.find((l) => l.startsWith('path\t'));
      if (line) await this.videoValue.finish(line.slice(5)).catch(() => {});
    }
    this.downloads.stop();
    const id = this.pageId;
    this.pageId = null;
    this.markClosed();
    if (id) await this.client.call('vs_close', [id], { session: this.sessionId }).catch(() => {});
    this.token = null;
    this.snapshot = null;
    this.synced = false;
    this.fresh = false;
  }
}
