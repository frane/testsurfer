/**
 * Browser: one vibesurfer session. Owns the wire client, opens pages,
 * and closes the session on shutdown.
 */

import { WireClient, type ClientOptions } from './client.ts';

/** Parse the vs_status daemon line into negotiated capabilities. */
async function negotiate(client: WireClient): Promise<{ proto: number; flags: Set<string>; version: string }> {
  const caps = { proto: 0, flags: new Set<string>(), version: '' };
  try {
    const status = await client.call('vs_status');
    const line = status.body.find((l) => l.startsWith('daemon'));
    if (!line) return caps;
    for (const field of line.split('\t').slice(1)) {
      const eq = field.indexOf('=');
      if (eq <= 0) continue;
      const key = field.slice(0, eq);
      const value = field.slice(eq + 1);
      if (key === 'proto') caps.proto = Number(value) || 0;
      if (key === 'version') caps.version = value;
      if (key === 'flags') for (const f of value.split(',')) caps.flags.add(f.trim());
    }
  } catch {
    // Status shape unknown; stay on pinned-contract defaults.
  }
  return caps;
}
import { fromWire, matches, toWire, type Cookie, type CookieInput, type StorageState, type WireCookie } from './cookies.ts';
import { Dialog, type RouteHandler, type UrlMatcher } from './events.ts';
import { APIRequestContext } from './request.ts';
import { geolocationScript, localeScript, onlineScript, timezoneScript, touchScript, userAgentScript, type Geolocation } from './emulation.ts';
import type { MediaOptions } from './media.ts';
import { Clock } from './clock.ts';

/** Playwright's browser.newContext() / `use` options that testsurfer applies per context. */
export interface ContextOptions {
  colorScheme?: MediaOptions['colorScheme'];
  reducedMotion?: MediaOptions['reducedMotion'];
  forcedColors?: MediaOptions['forcedColors'];
  contrast?: MediaOptions['contrast'];
  extraHTTPHeaders?: Record<string, string>;
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  geolocation?: Geolocation;
  permissions?: string[];
  offline?: boolean;
  httpCredentials?: { username: string; password: string; origin?: string; send?: 'always' | 'unauthorized' };
  javaScriptEnabled?: boolean;
  hasTouch?: boolean;
  isMobile?: boolean;
  bypassCSP?: boolean;
  serviceWorkers?: 'allow' | 'block';
  ignoreHTTPSErrors?: boolean;
  acceptDownloads?: boolean;
  baseURL?: string;
  storageState?: StorageState | string;
}

/** The keys of ContextOptions, for picking them out of `use` and test.use(). */
export const CONTEXT_OPTION_KEYS = [
  'colorScheme', 'reducedMotion', 'forcedColors', 'contrast', 'extraHTTPHeaders', 'userAgent', 'locale', 'timezoneId',
  'geolocation', 'permissions', 'offline', 'httpCredentials', 'javaScriptEnabled', 'hasTouch', 'isMobile', 'bypassCSP',
  'serviceWorkers', 'ignoreHTTPSErrors', 'acceptDownloads', 'storageState',
] as const;
import { NetHub, type NetContext, type NetPage } from './net.ts';
import {
  Page,
  DEFAULT_TIMEOUTS,
  type ClickVia,
  type InputMode,
  type ProtocolOptions,
  type Timeouts,
} from './page.ts';

export interface LaunchOptions extends ClientOptions {
  timeouts?: Partial<Timeouts>;
  /** vs policy name passed to session-open. */
  policy?: string;
  /**
   * Cursor and keyboard cadence for trusted input. Defaults to
   * `robotic` (instant, right for tests). Set `human` when a flow sits
   * behind bot detection that scores cursor motion.
   */
  inputMode?: InputMode;
  /** How click() reaches visible targets. See ClickVia; negotiated from the daemon by default. */
  clickVia?: ClickVia;
  /** Wire-semantics options for newer daemons. See ProtocolOptions. */
  protocol?: ProtocolOptions;
  /** Resolve relative goto() URLs against this, e.g. `http://localhost:3000`. */
  baseURL?: string;
  /** Attribute getByTestId matches. Default `data-testid`. */
  testIdAttribute?: string;
  /** Page size in CSS px. Default 1280x720, as Playwright; null keeps the engine's own size. */
  viewport?: { width: number; height: number } | null;
  /** Device pixel ratio for screenshots. Default 1. */
  deviceScaleFactor?: number;
}

/** A session and blank page opened ahead of the context that will use them. */
interface Spare {
  sessionId: string;
  pageId: string;
  token: string;
  sized: { width: number; height: number; dpr: number } | null;
}

export class Browser {
  private readonly client: WireClient;
  readonly sessionId: string;
  private readonly timeouts: Timeouts;
  private readonly inputMode: InputMode;
  private readonly clickVia: ClickVia;
  private readonly protocol: ProtocolOptions;
  private readonly baseURL: string | undefined;
  private testIdAttribute: string | null = null;
  private viewport: { width: number; height: number } | null = { width: 1280, height: 720 };
  private deviceScaleFactor = 1;

  private constructor(
    client: WireClient,
    sessionId: string,
    timeouts: Timeouts,
    inputMode: InputMode,
    clickVia: ClickVia,
    protocol: ProtocolOptions,
    baseURL: string | undefined,
  ) {
    this.baseURL = baseURL;
    this.client = client;
    this.sessionId = sessionId;
    this.timeouts = timeouts;
    this.inputMode = inputMode;
    this.clickVia = clickVia;
    this.protocol = protocol;
  }

  /**
   * Connect to the daemon (spawning it if needed) and open a session.
   * Wire capabilities are negotiated from the vs_status daemon line
   * (`daemon version=... proto=N flags=a,b`): protocol-v1 daemons get
   * inline act deltas, act-mode clicks, and nav-in-place goto
   * automatically. Explicit options always win over negotiation.
   */
  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const client = await WireClient.connect(options);
    const caps = await negotiate(client);
    const flags: Record<string, string> = {};
    if (options.policy) flags['policy'] = options.policy;
    const resp = await client.call('vs_session_open', [], flags);
    const sessionId = resp.body[0];
    if (!sessionId) {
      client.close();
      throw new Error('vs_session_open returned no session id');
    }
    const browser = new Browser(
      client,
      sessionId,
      { ...DEFAULT_TIMEOUTS, ...options.timeouts },
      options.inputMode ?? 'robotic',
      options.clickVia ?? (caps.flags.has('clickVia') ? 'act' : 'click-at'),
      {
        actDeltas: options.protocol?.actDeltas ?? caps.flags.has('actDeltas'),
        navInPlace: options.protocol?.navInPlace ?? caps.proto >= 1,
        nativeWheel: options.protocol?.nativeWheel ?? caps.flags.has('wheel'),
        cookies: options.protocol?.cookies ?? caps.flags.has('cookies'),
        clickOptions: options.protocol?.clickOptions ?? caps.flags.has('clickOptions'),
      },
      options.baseURL,
    );
    browser.daemonVersion = caps.version;
    if (options.testIdAttribute) browser.testIdAttribute = options.testIdAttribute;
    if (options.viewport !== undefined) browser.viewport = options.viewport;
    if (options.deviceScaleFactor !== undefined) browser.deviceScaleFactor = options.deviceScaleFactor;
    return browser;
  }

  private defaultCtx: BrowserContext | null = null;
  private readonly openContexts = new Set<BrowserContext>();

  /** The context that browser.newPage() opens pages in. */
  get defaultContext(): BrowserContext {
    this.defaultCtx ??= new BrowserContext(this, this.sessionId, false);
    return this.defaultCtx;
  }

  /**
   * A new context: its own vibesurfer session, closed with the context.
   * By default the session is isolated (vibesurfer 0.2.16+): its own
   * in-memory cookie and storage jar, discarded on close, as a
   * Playwright context is. `{ isolated: false }` shares the engine's
   * persistent jar (logins survive across runs). Every request goes
   * through vibesurfer's intercepting proxy unless `{ intercept: false }`
   * (an isolated context only; the shared jar cannot be proxied).
   */
  async newContext(options: { isolated?: boolean; intercept?: boolean } & ContextOptions = {}): Promise<BrowserContext> {
    const ctx = await this.openContext({ ...options, ...(options.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}) });
    await ctx.configure(options);
    if (options.storageState) await ctx.applyStorageState(options.storageState);
    return ctx;
  }

  /** The vibesurfer daemon's version. */
  version(): string {
    return this.daemonVersion;
  }

  /** @internal Set by launch from the daemon's status line. */
  daemonVersion = '';

  isConnected(): boolean {
    return !this.closed;
  }

  private closed = false;

  /** The browser type: WebKit, the engine vibesurfer drives. */
  browserType(): { name(): string } {
    return { name: () => 'webkit' };
  }

  private async openContext(opts: { isolated?: boolean; intercept?: boolean; ignoreHTTPSErrors?: boolean }): Promise<BrowserContext> {
    const options = { ...opts, intercept: opts.intercept ?? opts.isolated !== false };
    const flags: Record<string, true> = options.isolated === false ? {} : { isolated: true };
    if (opts.ignoreHTTPSErrors && options.intercept) flags['ignore-https-errors'] = true;
    // Every http request goes through vibesurfer's proxy (0.2.16+); see
    // src/net.ts. Popups then open as their own pages, reported on the
    // same event stream.
    if (options.intercept) {
      flags['intercept'] = true;
      flags['popups'] = true;
    }
    // A context opened ahead of time with the same flags, if there is one;
    // then start the next, so a run of tests never waits for a web view.
    // Take the spare only when it is ready and matches; never wait for
    // one (parallel tests call this at once). Claim it before any await.
    const key = JSON.stringify(flags);
    const ready = this.spareReady && this.spareKey === key ? this.spareReady : null;
    if (ready) {
      this.spare = null;
      this.spareReady = null;
    } else if (this.spare && this.spareKey !== key) {
      void this.dropSpare(this.spare);
      this.spare = null;
      this.spareReady = null;
    }
    if (!this.spare && (flags['isolated'] || flags['intercept'])) this.warm(flags, key);
    const spare = ready;
    if (spare) {
      const ctx = new BrowserContext(this, spare.sessionId, true, options.intercept);
      ctx.warmPage = spare;
      this.openContexts.add(ctx);
      return ctx;
    }
    const resp = await this.client.call('vs_session_open', [], flags);
    const id = resp.body[0];
    if (!id) throw new Error('vs_session_open returned no session id');
    const ctx = new BrowserContext(this, id, true, options.intercept);
    this.openContexts.add(ctx);
    return ctx;
  }

  private spare: Promise<Spare | null> | null = null;
  /** The spare, once it is open. */
  private spareReady: Spare | null = null;
  private spareKey = '';
  private warmer: Promise<WireClient> | null = null;

  /** Open a session with `flags` and a blank, sized page in it, on a connection of its own. */
  private warm(flags: Record<string, true>, key: string): void {
    this.spareKey = key;
    const p: Promise<Spare | null> = (async (): Promise<Spare | null> => {
      const c = await (this.warmer ??= this.client.sibling());
      const sessionId = (await c.call('vs_session_open', [], flags)).body[0];
      if (!sessionId) return null;
      const r = await c.call('vs_open', ['about:blank'], { session: sessionId });
      const pageId = r.body[0];
      if (!pageId) {
        await c.call('vs_session_close', [sessionId], {}).catch(() => {});
        return null;
      }
      let sized: Spare['sized'] = null;
      if (this.viewport) {
        const v = this.viewport;
        await c.call('vs_viewport', [pageId, `${v.width}x${v.height}`], { session: sessionId, dpr: String(this.deviceScaleFactor) });
        sized = { ...v, dpr: this.deviceScaleFactor };
      }
      return { sessionId, pageId, token: r.token, sized };
    })().catch(() => null);
    this.spare = p;
    void p.then((s) => {
      // Still the current spare (not dropped or replaced): mark it ready.
      if (this.spare === p) this.spareReady = s;
    });
  }

  /** Close a spare nobody will take (its flags did not match). */
  private async dropSpare(spare: Promise<Spare | null>): Promise<void> {
    const s = await spare;
    if (s) await this.client.call('vs_session_close', [s.sessionId], {}).catch(() => {});
  }

  /** A context over this browser's own session; closing it closes its pages only. */
  sharedContext(): BrowserContext {
    return new BrowserContext(this, this.sessionId, false);
  }

  contexts(): BrowserContext[] {
    return [...(this.defaultCtx ? [this.defaultCtx] : []), ...this.openContexts];
  }

  /** @internal Called by a context when it closes. */
  forgetContext(ctx: BrowserContext): void {
    this.openContexts.delete(ctx);
  }

  /** @internal Close a context's session. */
  async closeSession(sessionId: string): Promise<void> {
    await this.client.call('vs_session_close', [sessionId], {}).catch(() => {});
  }

  /** @internal A second daemon connection, for a context's event poller. */
  openPoller(): Promise<WireClient> {
    return this.client.sibling();
  }

  /** @internal The daemon reads and writes cookie jars host-side (`vs_cookies`, vibesurfer 0.2.19+). */
  get hostCookies(): boolean {
    return this.protocol.cookies ?? false;
  }

  /** @internal The baseURL launch option. */
  get base(): string | undefined {
    return this.baseURL;
  }

  /** @internal One wire call on the browser's own connection. */
  rawCall(prim: string, args: string[], flags: Record<string, string | true> = {}) {
    return this.client.call(prim, args, flags);
  }

  /** A new page in this session. Call page.goto(url) to load a URL. */
  newPage(): Page {
    const page = this.makePage(this.sessionId);
    this.defaultContext.adopt(page);
    return page;
  }

  /** @internal A page bound to `sessionId`, with this browser's options. */
  makePage(sessionId: string): Page {
    const page = new Page(
      this.client,
      sessionId,
      this.timeouts,
      this.inputMode,
      this.clickVia,
      this.protocol,
      this.baseURL,
    );
    if (this.testIdAttribute) page.testIdAttribute = this.testIdAttribute;
    page.initialViewport(this.viewport, this.deviceScaleFactor);
    return page;
  }

  /** Close the session and drop the connection. */
  async close(): Promise<void> {
    this.closed = true;
    for (const ctx of [...this.openContexts]) await ctx.close().catch(() => {});
    // The default context shares the browser's session; closing it closes its pages and their pollers.
    if (this.defaultCtx) await this.defaultCtx.close().catch(() => {});
    if (this.spare) await this.dropSpare(this.spare);
    this.spare = null;
    this.spareReady = null;
    if (this.warmer) (await this.warmer.catch(() => null))?.close();
    await this.client.call('vs_session_close', [this.sessionId], {}).catch(() => {});
    this.client.close();
  }
}

/**
 * A group of pages, with routes and init scripts that apply to all of
 * them (Playwright's BrowserContext). See Browser.newContext() for the
 * isolation caveat.
 */
export class BrowserContext {
  private readonly owner: Browser;
  readonly sessionId: string;
  private readonly ownsSession: boolean;
  private readonly open: Page[] = [];
  private readonly routes: { url: UrlMatcher; handler: RouteHandler; times?: number }[] = [];
  private readonly scripts: { script: Parameters<Page['addInitScript']>[0]; arg?: unknown }[] = [];

  /** The session runs through vibesurfer's intercepting proxy. */
  readonly intercept: boolean;

  constructor(owner: Browser, sessionId: string, ownsSession: boolean, intercept = false) {
    this.owner = owner;
    this.sessionId = sessionId;
    this.ownsSession = ownsSession;
    this.intercept = intercept;
    this.request = new APIRequestContext(
      owner.base,
      { cookies: () => this.cookies(), store: (list) => this.storeCookies(list) },
      () => this.extraHeaders,
    );
  }

  /** HTTP calls from the test process that share this context's cookies (Playwright's context.request). */
  readonly request: APIRequestContext;

  /** Fake time for every page of the context (Playwright's context.clock). */
  readonly clock = new Clock({
    evaluate: async (script) => {
      for (const p of this.open) await p.evaluate(`() => { ${script} }`).catch(() => {});
    },
    addInitScript: (script) => this.addInitScript(script),
  });

  private media: MediaOptions = {};
  private geo: Geolocation | null = null;
  private granted = new Set<string>();
  private offlineNow = false;
  private credentials: ContextOptions['httpCredentials'] | null = null;
  private jsDisabled = false;
  private cspBypass = false;
  private internalRoute = false;
  private closedFlag = false;
  private readonly timeoutDefaults: { action?: number; navigation?: number } = {};

  /** @internal Apply newContext() options. */
  async configure(o: ContextOptions): Promise<void> {
    const headers: Record<string, string> = { ...(o.extraHTTPHeaders ?? {}) };
    if (o.userAgent) {
      headers['user-agent'] = o.userAgent;
      await this.addInitScript(userAgentScript(o.userAgent));
    }
    if (o.locale) {
      headers['accept-language'] = o.locale;
      await this.addInitScript(localeScript(o.locale));
    }
    if (o.timezoneId) await this.addInitScript(timezoneScript(o.timezoneId));
    if (o.hasTouch || o.isMobile) await this.addInitScript(touchScript());
    if (o.serviceWorkers === 'block') {
      await this.addInitScript(`(() => { if (navigator.serviceWorker) navigator.serviceWorker.register = () => Promise.reject(new DOMException('Service workers are blocked', 'SecurityError')); })();`);
    }
    if (Object.keys(headers).length) await this.setExtraHTTPHeaders({ ...this.extraHeaders, ...headers });
    for (const k of ['colorScheme', 'reducedMotion', 'forcedColors', 'contrast'] as const) {
      if (o[k] !== undefined) (this.media as Record<string, unknown>)[k] = o[k];
    }
    if (o.geolocation || o.permissions) {
      this.geo = o.geolocation ?? null;
      for (const p of o.permissions ?? []) this.granted.add(p);
      await this.addInitScript(geolocationScript(this.geo, [...this.granted]));
    }
    if (o.offline) await this.setOffline(true);
    if (o.httpCredentials) await this.setHTTPCredentials(o.httpCredentials);
    if (o.javaScriptEnabled === false) {
      this.jsDisabled = true;
      await this.ensureInternalRoute();
    }
    if (o.bypassCSP) {
      this.cspBypass = true;
      await this.ensureInternalRoute();
    }
  }

  /** @internal Per-page settings a new page (or popup) gets. */
  private async preparePage(page: Page): Promise<void> {
    if (Object.keys(this.media).length) await page.emulateMedia(this.media);
    if (this.timeoutDefaults.action !== undefined) page.setDefaultTimeout(this.timeoutDefaults.action);
    if (this.timeoutDefaults.navigation !== undefined) page.setDefaultNavigationTimeout(this.timeoutDefaults.navigation);
  }

  /**
   * One context route, added the first time something needs it: it
   * fails every request while offline, adds HTTP credentials, and
   * turns scripts off (CSP) or the page's CSP off on documents.
   */
  private async ensureInternalRoute(): Promise<void> {
    if (this.internalRoute) return;
    this.internalRoute = true;
    await this.route('**/*', async (route) => {
      const req = route.request();
      if (this.offlineNow) return route.abort('internetdisconnected');
      const add: Record<string, string> = {};
      const c = this.credentials;
      if (c && (!c.origin || new URL(req.url()).origin === new URL(c.origin).origin)) {
        add['authorization'] = `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
      }
      const doc = req.resourceType() === 'document';
      if (doc && (this.jsDisabled || this.cspBypass)) {
        const res = await route.fetch(Object.keys(add).length ? { headers: { ...req.headers(), ...add } } : {});
        const h = { ...res.headers() };
        if (this.cspBypass) for (const k of Object.keys(h)) if (k.toLowerCase().startsWith('content-security-policy')) delete h[k];
        if (this.jsDisabled) h['content-security-policy'] = "script-src 'none'";
        return route.fulfill({ response: res, headers: h });
      }
      if (Object.keys(add).length) return route.fallback({ headers: { ...req.headers(), ...add } });
      return route.fallback();
    });
  }

  /** An init script for later documents that also runs in the documents open now. */
  private async addLiveScript(script: string): Promise<void> {
    await this.addInitScript(script);
    for (const p of this.open) await p.evaluate(`() => { ${script} }`).catch(() => {});
  }

  /** Fail every request (and report navigator.onLine false) while `offline`. */
  async setOffline(offline: boolean): Promise<void> {
    this.offlineNow = offline;
    if (offline) await this.ensureInternalRoute();
    await this.addLiveScript(onlineScript(offline));
  }

  /** The position navigator.geolocation reports; null makes it unavailable. */
  async setGeolocation(geolocation: Geolocation | null): Promise<void> {
    this.geo = geolocation;
    await this.addLiveScript(geolocationScript(this.geo, [...this.granted]));
  }

  /** Grant permissions (`geolocation`, `notifications`, ...) as navigator.permissions reports them. */
  async grantPermissions(permissions: string[], _options: { origin?: string } = {}): Promise<void> {
    for (const p of permissions) this.granted.add(p);
    await this.addLiveScript(geolocationScript(this.geo, [...this.granted]));
  }

  async clearPermissions(): Promise<void> {
    this.granted.clear();
    await this.addLiveScript(geolocationScript(this.geo, []));
  }

  /** Credentials for HTTP authentication, sent to `origin` (every origin when unset); null stops sending them. */
  async setHTTPCredentials(credentials: ContextOptions['httpCredentials'] | null): Promise<void> {
    this.credentials = credentials ?? null;
    if (credentials) await this.ensureInternalRoute();
  }

  /** exposeFunction() on every page of the context, current and future. */
  async exposeFunction(name: string, fn: (...args: any[]) => unknown): Promise<void> {
    await this.exposeBinding(name, (_source: unknown, ...args: unknown[]) => fn(...args));
  }

  /** exposeBinding() on every page of the context, current and future. */
  async exposeBinding(name: string, fn: (source: { page: Page; context: BrowserContext; frame: unknown }, ...args: any[]) => unknown): Promise<void> {
    this.bindings.push({ name, fn });
    for (const p of this.open) await p.exposeBinding(name, fn as Parameters<Page['exposeBinding']>[1]);
  }

  private readonly bindings: { name: string; fn: (source: { page: Page; context: BrowserContext; frame: unknown }, ...args: any[]) => unknown }[] = [];

  setDefaultTimeout(ms: number): void {
    this.timeoutDefaults.action = ms;
    for (const p of this.open) p.setDefaultTimeout(ms);
  }

  setDefaultNavigationTimeout(ms: number): void {
    this.timeoutDefaults.navigation = ms;
    for (const p of this.open) p.setDefaultNavigationTimeout(ms);
  }

  isClosed(): boolean {
    return this.closedFlag;
  }

  /** Service workers running for the context's pages (not tracked separately; always empty). */
  serviceWorkers(): never[] {
    return [];
  }

  /** Replace the context's cookies and localStorage with `state`. */
  async setStorageState(state: StorageState | string): Promise<void> {
    if (this.owner.hostCookies) await this.clearCookies();
    await this.applyStorageState(state);
  }

  /** A page whose data store holds the context's jar: an open page, or a blank one kept for this. */
  private async jarPage(): Promise<string> {
    const open = this.open[0];
    if (open) return open.openedId();
    if (this.blankJarPage) return this.blankJarPage;
    const r = await this.owner.rawCall('vs_open', ['about:blank'], { session: this.sessionId });
    const id = r.body[0];
    if (!id) throw new Error('vs_open returned no page id');
    this.blankJarPage = id;
    return id;
  }

  private blankJarPage: string | null = null;

  private async jar(op: 'list' | 'clear' | 'set', list?: WireCookie[]): Promise<Cookie[]> {
    const page = await this.jarPage();
    const args = [page, op];
    if (list) args.push(Buffer.from(JSON.stringify(list)).toString('base64'));
    const r = await this.owner.rawCall('vs_cookies', args, { session: this.sessionId });
    const wire = JSON.parse(r.body[0] ?? '[]') as WireCookie[];
    return wire.map(fromWire);
  }

  /** @internal Put cookies a response set into the jar. */
  async storeCookies(list: WireCookie[]): Promise<void> {
    if (!this.owner.hostCookies) return;
    await this.jar('set', list);
  }

  /** The context's cookies, HttpOnly included; with `urls`, only those that go with a request to one of them. */
  async cookies(urls?: string | string[]): Promise<Cookie[]> {
    if (!this.owner.hostCookies) throw new Error('browserContext.cookies needs vibesurfer 0.2.19 or later');
    const all = await this.jar('list');
    const list = urls === undefined ? [] : Array.isArray(urls) ? urls : [urls];
    return list.length ? all.filter((c) => list.some((u) => matches(c, u))) : all;
  }

  /** Remove cookies: all of them, or those matching `name`, `domain` and `path` (strings or RegExps). */
  async clearCookies(filter: { name?: string | RegExp; domain?: string | RegExp; path?: string | RegExp } = {}): Promise<void> {
    if (!this.owner.hostCookies) throw new Error('browserContext.clearCookies needs vibesurfer 0.2.19 or later');
    const test = (want: string | RegExp | undefined, v: string) =>
      want === undefined || (typeof want === 'string' ? want === v : want.test(v));
    const keep =
      filter.name === undefined && filter.domain === undefined && filter.path === undefined
        ? []
        : (await this.jar('list')).filter((c) => !(test(filter.name, c.name) && test(filter.domain, c.domain) && test(filter.path, c.path)));
    await this.jar('clear');
    if (keep.length) await this.jar('set', keep.map(toWire));
  }

  /**
   * The context's cookies and the localStorage of its pages' origins,
   * as Playwright saves them; written to `path` as JSON when given.
   */
  async storageState(options: { path?: string; indexedDB?: boolean } = {}): Promise<StorageState> {
    const cookies = await this.cookies();
    const origins: StorageState['origins'] = [];
    const seen = new Set<string>();
    for (const p of this.open) {
      const got = (await p
        .evaluate(`() => {
          const o = location.origin;
          if (!o || o === 'null') return null;
          const items = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k !== null) items.push({ name: k, value: localStorage.getItem(k) ?? '' });
          }
          return { origin: o, localStorage: items };
        }`)
        .catch(() => null)) as StorageState['origins'][number] | null;
      if (got && !seen.has(got.origin) && got.localStorage.length) {
        seen.add(got.origin);
        origins.push(got);
      }
    }
    const state = { cookies, origins };
    if (options.path) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.mkdir(path.dirname(options.path), { recursive: true });
      await fs.writeFile(options.path, JSON.stringify(state, null, 2));
    }
    return state;
  }

  /**
   * @internal Load a storage state into the context: its cookies into
   * the jar, and each origin's localStorage by opening that origin on a
   * blank routed document and writing the items there.
   */
  async applyStorageState(state: StorageState | string): Promise<void> {
    const s: StorageState =
      typeof state === 'string'
        ? (JSON.parse(await (await import('node:fs/promises')).readFile(state, 'utf8')) as StorageState)
        : state;
    if (s.cookies?.length) await this.addCookies(s.cookies);
    const origins = (s.origins ?? []).filter((o) => o.localStorage?.length);
    if (!origins.length) return;
    const page = await this.newPage();
    try {
      for (const o of origins) {
        const url = `${o.origin}/__testsurfer_storage_state__`;
        await page.route(url, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>storage</title>' }));
        await page.goto(url);
        await page.evaluate('(items) => { for (const i of items) localStorage.setItem(i.name, i.value); }', o.localStorage);
        await page.unroute(url);
      }
    } finally {
      await page.close();
    }
  }

  browser(): Browser {
    return this.owner;
  }

  /** @internal Track a page created elsewhere as part of this context. */
  adopt(page: Page): void {
    this.open.push(page);
    page.bindContext(this);
    this.listen();
  }

  /** @internal A page closed; it is no longer one of the context's pages. */
  forgetPage(page: Page): void {
    const i = this.open.indexOf(page);
    if (i >= 0) this.open.splice(i, 1);
  }

  // --- Events: page, request, response, requestfinished, requestfailed, close.

  private readonly listeners = new Map<string, Set<(arg: never) => void>>();
  private hub: NetHub | null = null;

  /** Proxy mode: watch the session's event stream for popups and context-level events. */
  private listen(): void {
    if (!this.intercept || this.hub) return;
    this.hub = NetHub.for(this.sessionId, () => this.owner.openPoller());
    this.hub.attachContext(this.netContext());
  }

  private netContext(): NetContext {
    return {
      netEmit: (name, arg) => this.emit(name, arg),
      netPopup: (openerId, pageId, url) => this.popupOpened(openerId, pageId, url),
      netPageClosed: (pageId) => {
        this.open.find((p) => p.wireId() === pageId)?.closedByPage();
      },
      netDialog: (pageId, kind, message, defaultText, answer) => {
        const page = this.open.find((p) => p.wireId() === pageId) ?? null;
        const d = new Dialog(kind, message, defaultText, page, answer);
        const contextListens = (this.listeners.get('dialog')?.size ?? 0) > 0;
        if (page) page.handleDialog(d, contextListens);
        else if (!contextListens) void d.dismiss().catch(() => {});
        if (contextListens) this.emit('dialog', d);
      },
    };
  }

  private popupOpened(openerId: string, pageId: string, url: string): NetPage | null {
    const opener = this.open.find((p) => p.wireId() === openerId) ?? null;
    const popup = this.owner.makePage(this.sessionId);
    this.adopt(popup);
    const events = popup.adoptPopup(pageId, url, opener);
    // The context's routes and init scripts apply to the popup too; its
    // document is already on the way, so they reach it from the next one.
    for (const r of this.routes) void popup.route(r.url, r.handler, r.times === undefined ? {} : { times: r.times });
    void this.preparePage(popup).catch(() => {});
    this.emit('page', popup);
    opener?.emitPopup(popup);
    return events;
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

  on(event: string, listener: (arg: never) => void): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return this;
  }

  once(event: string, listener: (arg: never) => void): this {
    const wrapped = (arg: never) => {
      this.off(event, wrapped);
      listener(arg);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: (arg: never) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: (arg: never) => void): this {
    return this.off(event, listener);
  }

  /** The next `event` that `predicate` accepts. */
  waitForEvent<T = unknown>(
    event: string,
    optionsOrPredicate?: ((arg: T) => boolean | Promise<boolean>) | { predicate?: (arg: T) => boolean | Promise<boolean>; timeout?: number },
  ): Promise<T> {
    const opts = typeof optionsOrPredicate === 'function' ? { predicate: optionsOrPredicate } : (optionsOrPredicate ?? {});
    const timeout = opts.timeout ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, fn);
        reject(new Error(`browserContext.waitForEvent: Timeout ${timeout}ms exceeded while waiting for event "${event}"`));
      }, timeout);
      const fn = (arg: never) => {
        void (async () => {
          if (opts.predicate && !(await opts.predicate(arg as T))) return;
          clearTimeout(timer);
          this.off(event, fn);
          resolve(arg as T);
        })();
      };
      this.on(event, fn);
    });
  }

  /** setExtraHTTPHeaders() for every page of the context. */
  extraHeaders: Record<string, string> = {};

  async setExtraHTTPHeaders(headers: Record<string, string>): Promise<void> {
    this.extraHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    for (const p of this.open) await p.refreshNetwork();
  }

  private pendingCookies: string[] = [];
  private cookieSeq = 0;

  /**
   * Add cookies to the context's jar: `{ name, value, url }` or
   * `{ name, value, domain, path }`, with optional expires, httpOnly,
   * secure and sameSite. HttpOnly cookies work too: they go in through
   * the engine's cookie store, not document.cookie.
   */
  async addCookies(cookies: (CookieInput | Cookie)[]): Promise<void> {
    if (this.owner.hostCookies) {
      await this.jar('set', cookies.map(toWire));
      return;
    }
    const list = (cookies as CookieInput[]).map((c) => {
      const u = c.url ? new URL(c.url) : null;
      const domain = c.domain ?? u?.hostname;
      if (!domain) throw new Error('browserContext.addCookies: a cookie needs url or domain');
      return {
        name: c.name,
        value: c.value,
        domain,
        path: c.path ?? (u ? u.pathname.replace(/\/[^/]*$/, '/') || '/' : '/'),
        ...(c.expires !== undefined && c.expires > 0 ? { expiresUnix: Math.floor(c.expires) } : {}),
        secure: c.secure ?? u?.protocol === 'https:',
        httpOnly: c.httpOnly ?? false,
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      };
    });
    const first = (cookies as CookieInput[])[0];
    const origin = first?.url ? new URL(first.url).origin : `http://${list[0]?.domain ?? 'localhost'}`;
    const blob = { version: 2, url: `${origin}/`, origin, cookies: list, localStorage: {}, sessionStorage: {} };
    const name = `testsurfer-cookies-${this.sessionId}-${++this.cookieSeq}`;
    await this.owner.rawCall('vs_auth', ['import', name, Buffer.from(JSON.stringify(blob)).toString('base64')], {
      session: this.sessionId,
    });
    const page = this.open[0];
    if (page) await page.loadCookieBlob(name);
    else this.pendingCookies.push(name);
  }

  /** @internal A blank page Browser.newContext opened ahead of time; the first newPage() takes it. */
  warmPage: Spare | null = null;

  async newPage(): Promise<Page> {
    const page = this.owner.makePage(this.sessionId);
    const warm = this.warmPage;
    this.warmPage = null;
    if (warm) await page.adoptBlank(warm.pageId, warm.token, warm.sized);
    this.adopt(page);
    for (const name of this.pendingCookies.splice(0)) await page.loadCookieBlob(name);
    for (const s of this.scripts) await page.addInitScript(s.script, s.arg);
    for (const r of this.routes) await page.route(r.url, r.handler, r.times === undefined ? {} : { times: r.times });
    for (const b of this.bindings) await page.exposeBinding(b.name, b.fn as Parameters<Page['exposeBinding']>[1]);
    await this.preparePage(page);
    return page;
  }

  pages(): Page[] {
    return [...this.open];
  }

  /** Route requests of every page in this context, current and future. */
  async route(url: UrlMatcher, handler: RouteHandler, options: { times?: number } = {}): Promise<void> {
    this.routes.push({ url, handler, ...(options.times === undefined ? {} : { times: options.times }) });
    for (const p of this.open) await p.route(url, handler, options);
  }

  /** Remove routes for `url`: all of them, or the one with `handler`. */
  async unroute(url: UrlMatcher, handler?: RouteHandler): Promise<void> {
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const r = this.routes[i]!;
      if (String(r.url) === String(url) && (!handler || r.handler === handler)) this.routes.splice(i, 1);
    }
    for (const p of this.open) await p.unroute(url, handler);
  }

  async unrouteAll(): Promise<void> {
    this.routes.length = 0;
    for (const p of this.open) await p.unrouteAll();
  }

  /** An init script for every page in this context, current and future. */
  async addInitScript(script: Parameters<Page['addInitScript']>[0], arg?: unknown): Promise<void> {
    this.scripts.push({ script, arg });
    for (const p of this.open) await p.addInitScript(script, arg);
  }

  /** Close every page, and the session when the context opened one. */
  async close(): Promise<void> {
    this.closedFlag = true;
    for (const p of this.open.splice(0)) await p.close().catch(() => {});
    if (this.blankJarPage && !this.ownsSession) {
      await this.owner.rawCall('vs_close', [this.blankJarPage], { session: this.sessionId }).catch(() => {});
    }
    this.blankJarPage = null;
    this.hub?.detachContext();
    this.hub = null;
    this.emit('close', this);
    if (this.ownsSession) {
      await this.owner.closeSession(this.sessionId);
      this.owner.forgetContext(this);
    }
  }
}
