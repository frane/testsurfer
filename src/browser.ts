/**
 * Browser: one vibesurfer session. Owns the wire client, opens pages,
 * and closes the session on shutdown.
 */

import { WireClient, type ClientOptions } from './client.ts';
import { BrowserContext, type ContextOptions } from './context.ts';
import { Page, EAGER_SHIM } from './page.ts';
import { DEFAULT_TIMEOUTS, type ClickVia, type InputMode, type ProtocolOptions, type Timeouts } from './page-options.ts';

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
export interface Spare {
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
        webm: options.protocol?.webm ?? caps.flags.has('webm'),
        drop: options.protocol?.drop ?? caps.flags.has('drop'),
      },
      options.baseURL,
    );
    browser.daemonVersion = caps.version;
    browser.socketPath = client.endpoint;
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

  /** @internal The daemon socket this browser talks to. */
  socketPath = '';

  /**
   * Make this browser reachable for other clients: the vibesurfer
   * daemon is already a shared server, so the endpoint is its socket,
   * which browserType.connect() takes.
   */
  async bind(_title: string, _options: { host?: string; port?: number; metadata?: Record<string, unknown> } = {}): Promise<{ endpoint: string }> {
    return { endpoint: this.socketPath };
  }

  async unbind(): Promise<void> {}

  /** Chromium only, as in Playwright on WebKit. */
  async newBrowserCDPSession(): Promise<never> {
    throw new Error('browser.newBrowserCDPSession: CDP session is only available in Chromium');
  }

  async startTracing(): Promise<never> {
    throw new Error('browser.startTracing: Browser tracing is only available in Chromium');
  }

  async stopTracing(): Promise<never> {
    throw new Error('browser.stopTracing: Browser tracing is only available in Chromium');
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
      await c.call('vs_init_script', [pageId, EAGER_SHIM], { session: sessionId });
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

/** A Playwright BrowserType (webkit, chromium, firefox): every one drives the OS web view through vibesurfer. */
export function browserType(name: string) {
  return {
    name: () => name,
    executablePath: () => process.env['TESTSURFER_VS'] ?? 'vs',
    launch: (options: LaunchOptions = {}) => Browser.launch(options),
    /** Connect to a daemon socket (browser.bind's endpoint). */
    connect: (endpoint: string, options: LaunchOptions = {}) => Browser.launch({ ...options, socketPath: endpoint }),
    /**
     * A context whose cookies and localStorage live in `userDataDir`:
     * loaded from it on launch, written back on close, so a later
     * launch with the same directory starts where this one ended.
     */
    launchPersistentContext: async (userDataDir: string, options: LaunchOptions & ContextOptions = {}) => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const file = path.join(userDataDir, 'testsurfer-state.json');
      fs.mkdirSync(userDataDir, { recursive: true });
      const b = await Browser.launch(options);
      const ctx = await b.newContext({ ...options, ...(fs.existsSync(file) ? { storageState: file } : {}) });
      const close = ctx.close.bind(ctx);
      ctx.close = async () => {
        // Session cookies end with the browser, as they do in Playwright.
        const state = await ctx.storageState().catch(() => null);
        if (state) {
          state.cookies = state.cookies.filter((c) => c.expires > 0);
          fs.writeFileSync(file, JSON.stringify(state, null, 2));
        }
        await close();
        await b.close();
      };
      return ctx;
    },
  };
}
