/**
 * Browser: one vibesurfer session. Owns the wire client, opens pages,
 * and closes the session on shutdown.
 */

import { WireClient, type ClientOptions } from './client.ts';

/** Parse the vs_status daemon line into negotiated capabilities. */
async function negotiate(client: WireClient): Promise<{ proto: number; flags: Set<string> }> {
  const caps = { proto: 0, flags: new Set<string>() };
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
      if (key === 'flags') for (const f of value.split(',')) caps.flags.add(f.trim());
    }
  } catch {
    // Status shape unknown; stay on pinned-contract defaults.
  }
  return caps;
}
import type { RouteHandler, UrlMatcher } from './events.ts';
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
      },
      options.baseURL,
    );
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
   * persistent jar (logins survive across runs).
   */
  async newContext(options: { isolated?: boolean } = {}): Promise<BrowserContext> {
    const flags: Record<string, true> = options.isolated === false ? {} : { isolated: true };
    const resp = await this.client.call('vs_session_open', [], flags);
    const id = resp.body[0];
    if (!id) throw new Error('vs_session_open returned no session id');
    const ctx = new BrowserContext(this, id, true);
    this.openContexts.add(ctx);
    return ctx;
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
    for (const ctx of [...this.openContexts]) await ctx.close().catch(() => {});
    // The default context shares the browser's session; closing it closes its pages and their pollers.
    if (this.defaultCtx) await this.defaultCtx.close().catch(() => {});
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

  constructor(owner: Browser, sessionId: string, ownsSession: boolean) {
    this.owner = owner;
    this.sessionId = sessionId;
    this.ownsSession = ownsSession;
  }

  browser(): Browser {
    return this.owner;
  }

  /** @internal Track a page created elsewhere as part of this context. */
  adopt(page: Page): void {
    this.open.push(page);
    page.bindContext(this);
  }

  async newPage(): Promise<Page> {
    const page = this.owner.makePage(this.sessionId);
    this.adopt(page);
    for (const s of this.scripts) await page.addInitScript(s.script, s.arg);
    for (const r of this.routes) await page.route(r.url, r.handler, r.times === undefined ? {} : { times: r.times });
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
    for (const p of this.open.splice(0)) await p.close().catch(() => {});
    if (this.ownsSession) {
      await this.owner.closeSession(this.sessionId);
      this.owner.forgetContext(this);
    }
  }
}
