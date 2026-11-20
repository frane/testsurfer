/**
 * A Page wraps one vibesurfer page: navigation, fresh views, token
 * management, and locator factories. Authors never see state tokens;
 * the page caches the latest one and every mutation uses it.
 */

import type { WireClient } from './client.ts';
import type { BrowserContext } from './browser.ts';
import type { WireResponse } from './wire.ts';

/** Parse `<ref> x=.. y=.. w=.. h=.. visible=.. z=..` lines; `!` error lines are skipped. */
function parseLayoutLines(lines: string[]): Map<number, LayoutRect> {
  const out = new Map<number, LayoutRect>();
  for (const line of lines) {
    if (line.startsWith('!')) continue;
    const tokens = line.trim().split(/\s+/);
    const ref = Number(tokens[0]);
    if (!Number.isInteger(ref)) continue;
    const rect: LayoutRect = { x: 0, y: 0, w: 0, h: 0, visible: false };
    for (const tok of tokens.slice(1)) {
      const eq = tok.indexOf('=');
      if (eq <= 0) continue;
      const k = tok.slice(0, eq);
      const v = tok.slice(eq + 1);
      if (k === 'visible') rect.visible = v === 'true';
      else if (k === 'x') rect.x = Number(v);
      else if (k === 'y') rect.y = Number(v);
      else if (k === 'w') rect.w = Number(v);
      else if (k === 'h') rect.h = Number(v);
    }
    out.set(ref, rect);
  }
  return out;
}
import { WireError } from './errors.ts';
import { applyDelta, isDeltaBody, parseFullTree, walk, type Snapshot } from './tree.ts';
import { byAttr, FrameLocator, Locator, type ByRoleOptions, type ByTextOptions } from './locator.ts';
import { renderSnapshot } from './aria.ts';
import { PAGE_SHIM } from './shim.ts';
import {
  ConsoleMessage,
  PageEvents,
  Request,
  Response,
  urlMatches,
  type RouteHandler,
  type UrlMatcher,
} from './events.ts';

export interface Timeouts {
  /** Budget for actions (click, fill, ...) including auto-waiting. */
  action: number;
  /** Budget for expect() assertions. */
  expect: number;
  /** Budget for goto(). */
  navigation: number;
}

/**
 * Cursor and keyboard cadence for trusted input. `robotic` teleports
 * (fast, right for tests); `human` synthesizes a Bezier path with
 * human arrival timing (slow, right for anti-bot flows); `careful` is
 * a single-shot move in between.
 */
export type InputMode = 'human' | 'careful' | 'robotic';

/**
 * How Locator.click reaches a visible target. `act` sends vs_act click
 * --mode directly (vibesurfer 0.2+, negotiated from the clickVia
 * flag). `click-at` resolves the rect and issues a coordinate click,
 * for 0.1.x daemons whose vs_act ignores --mode and always takes the
 * slow humanized path.
 */
export type ClickVia = 'click-at' | 'act';

/** Options for how the page tracks daemon state across mutations. */
export interface ProtocolOptions {
  /**
   * vibesurfer 0.2+ returns each mutation's tree delta inline (act and
   * cursor ops advance the delta baseline and emit their ViewForm).
   * When enabled the page applies those bodies and skips the re-read
   * after actions. Negotiated from the actDeltas flag; 0.1.x daemons
   * advance the baseline silently and must leave it off.
   */
  actDeltas?: boolean;
  /**
   * Navigate an existing page in place via vs_goto (protocol v1),
   * reusing the engine web view instead of paying page creation on
   * every goto. Falls back to close+open when the daemon rejects it.
   */
  navInPlace?: boolean;
}

export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  action: 10_000,
  expect: 5_000,
  navigation: 30_000,
};

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
  readonly baseURL: string | undefined;
  /** Attribute getByTestId matches. Set with the `testIdAttribute` launch option. */
  testIdAttribute = 'data-testid';
  /** Document-start scripts, replayed into the web view when it is created. */
  private initScripts: string[] = [];
  private shimInstalled = false;
  private readonly events: PageEvents;
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
    this.client = client;
    this.sessionId = sessionId;
    this.timeouts = timeouts;
    this.inputMode = inputMode;
    this.clickVia = clickVia;
    this.actDeltas = protocol.actDeltas ?? false;
    this.navInPlace = protocol.navInPlace ?? false;
    this.events = new PageEvents({
      openPoller: () => this.client.sibling(),
      target: () => ({ pageId: this.pageId, sessionId: this.sessionId }),
      baseURL,
      ensureShim: () => this.ensureShim(),
      addInitScript: (src) => this.addInitSource(src),
    });
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
   * Intercept fetch and XHR requests whose URL matches. The handler
   * gets a Route to fulfill, continue, abort, fall back or fetch.
   * Navigations, images, scripts and stylesheets are not intercepted.
   */
  async route(url: UrlMatcher, handler: RouteHandler, options: { times?: number } = {}): Promise<void> {
    this.events.addRoute(url, handler, options.times ?? null);
    await this.events.sync();
  }

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
  on(event: string, listener: (arg: never) => void): this {
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
      const now = await this.url().catch(() => '');
      if (now && urlMatches(url, now, this.baseURL)) return;
      if (Date.now() >= deadline) throw new Error(`waitForURL(${String(url)}) timed out after ${budget}ms; URL is ${now}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** goto() already waits for the load; kept for Playwright compatibility. */
  async waitForLoadState(_state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void> {}

  /** Load the current URL again. */
  async reload(): Promise<void> {
    await this.goto(await this.url());
  }

  /** History back; resolves once the URL changed (or immediately when there is no history). */
  async goBack(): Promise<void> {
    await this.historyMove(-1);
  }

  async goForward(): Promise<void> {
    await this.historyMove(1);
  }

  private async historyMove(delta: number): Promise<void> {
    const before = await this.url();
    await this.evaluate(`(history.go(${delta}), 'ok')`);
    // No history entry means no change; give up on the URL after 2s.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      const now = await this.url().catch(() => before);
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

  /**
   * Navigate to a URL, relative to the baseURL launch option when set.
   * Navigates in place on protocol-v1 daemons; older ones close the
   * page and open a new one.
   */
  async goto(target: string): Promise<void> {
    const url = this.baseURL ? new URL(target, this.baseURL).href : target;
    if (this.pageId && this.navInPlace) {
      try {
        const resp = await this.client.call('vs_goto', [this.pageId, url], {
          session: this.sessionId,
        });
        this.token = resp.token;
        this.snapshot = null;
        this.synced = false;
        this.fresh = false;
        this.events.documentChanged();
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
    const first = this.initScripts.length > 0 ? 'about:blank' : url;
    const resp = await this.client.call('vs_open', [first], { session: this.sessionId });
    const id = resp.body[0];
    if (!id) throw new Error(`vs_open returned no page id for ${url}`);
    this.pageId = id;
    this.token = resp.token;
    if (first !== url) {
      for (const src of this.initScripts) {
        await this.client.call('vs_init_script', [id, src], { session: this.sessionId });
      }
      const nav = await this.client.call('vs_goto', [id, url], { session: this.sessionId });
      this.token = nav.token;
    }
    this.events.documentChanged();
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
      if (e instanceof WireError && e.code === 'STALE_TOKEN' && e.args[0]) {
        this.token = e.args[0];
      }
      this.synced = false;
      this.fresh = false;
      throw e;
    }
  }

  /**
   * Trusted native click at viewport coordinates via vs_click_at. The
   * cursor op leaves the daemon's delta baseline and last token
   * untouched, so `synced` survives (the next delta view picks up the
   * click's effects) but `fresh` does not.
   */
  async clickAt(x: number, y: number, mode?: InputMode): Promise<void> {
    if (this.token === null) await this.view();
    try {
      const resp = await this.client.call(
        'vs_click_at',
        [this.id, String(Math.round(x)), String(Math.round(y))],
        { session: this.sessionId, token: this.token ?? '', mode: mode ?? this.inputMode },
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
  async evaluate<T = unknown>(fnOrExpr: string | (() => unknown)): Promise<T> {
    const src = typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})()` : `(${fnOrExpr})`;
    const resp = await this.client.call(
      'vs_inspect',
      ['eval', this.id, `JSON.stringify(${src}) ?? "null"`],
      { session: this.sessionId, full: true },
    );
    const line = resp.body.find((l) => l.startsWith('result='));
    if (line === undefined) {
      throw new Error(`evaluate failed: ${resp.body.join(' ').slice(0, 300)}`);
    }
    return JSON.parse(line.slice('result='.length)) as T;
  }

  /** The page's current URL. */
  async url(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  /**
   * Save a PNG of the viewport (or the whole page with `fullPage`).
   * Returns the file path; with `path`, the file is copied there.
   */
  async screenshot(options: { path?: string; fullPage?: boolean } = {}): Promise<string> {
    return this.capture(null, options);
  }

  /** PNG of the page, or of one element when `ref` is given. Returns the file path. */
  async capture(ref: number | null, options: { path?: string; fullPage?: boolean } = {}): Promise<string> {
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

  /**
   * Trusted native pointer input at viewport coordinates (CSS px).
   * Every event reaches the page with isTrusted=true, so canvas apps,
   * sliders and drag-and-drop work. Cadence follows the page's input
   * mode unless a call overrides it.
   */
  readonly mouse = {
    move: (x: number, y: number, options?: { mode?: InputMode }): Promise<void> =>
      this.cursorOp('vs_move_to', [x, y], options?.mode, false),
    click: (x: number, y: number, options?: { mode?: InputMode }): Promise<void> =>
      this.clickAt(x, y, options?.mode),
    /** Press at (x1, y1), move along a path, release at (x2, y2). Fires the HTML5 drag events too. */
    drag: (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      options?: { mode?: InputMode },
    ): Promise<void> => this.cursorOp('vs_drag', [x1, y1, x2, y2], options?.mode, true),
  };

  private async cursorOp(op: string, coords: number[], mode: InputMode | undefined, mutates: boolean): Promise<void> {
    if (this.token === null) await this.view();
    const flags: Record<string, string> = { session: this.sessionId, mode: mode ?? this.inputMode };
    if (mutates) flags['token'] = this.token ?? '';
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

  /** The document title (the doc node's label). */
  async title(): Promise<string> {
    const snap = await this.view();
    for (const node of walk(snap)) {
      if (node.role === 'doc') return node.label;
    }
    return '';
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
  locator(selector: string): Locator {
    return new Locator(this, { kind: 'css', selector });
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
    this.events.close();
    if (!this.pageId) return;
    await this.client
      .call('vs_close', [this.pageId], { session: this.sessionId })
      .catch(() => {});
    this.pageId = null;
    this.token = null;
    this.snapshot = null;
    this.synced = false;
    this.fresh = false;
  }
}
