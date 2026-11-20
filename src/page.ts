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
import {
  byAttr,
  ElementHandle,
  FrameLocator,
  JSHandle,
  selectorSteps,
  Locator,
  type BoundingBox,
  type ByRoleOptions,
  type ByTextOptions,
  type ClickOptions,
  type InputFile,
  type LocatorOptions,
  type SelectOptionValue,
} from './locator.ts';
import { installEngine } from './injected.ts';
import { APIRequestContext } from './request.ts';
import { Frame } from './frame.ts';
import { deserializeValue, serializeValue, SERIALIZE_JS } from './serialize.ts';
import { decodePng, encodePng } from './png.ts';

/** The engine install expression: defines window.__tse and yields it. */
const ENGINE_JS = `(${installEngine.toString()})(${SERIALIZE_JS})`;

interface EngineReply {
  v?: unknown;
  e?: { name?: string; message: string; stack?: string };
  p?: number;
  gone?: boolean;
  noengine?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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
  /** HTTP requests from the test process (not the browser). */
  readonly request: APIRequestContext;
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
    this.request = new APIRequestContext(baseURL);
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
      await sleep(20);
    }
  }

  /** goto() already waits for the load; kept for Playwright compatibility. */
  async waitForLoadState(_state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void> {
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
    const here = this.pageId ? await this.url().catch(() => '') : '';
    if (!/^https?:/.test(here)) {
      const shown = here.startsWith('data:') ? await this.url() : 'about:blank';
      const data = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      await this.navigate(data);
      await this.rememberNav(shown, data);
      await this.refreshFrames();
      return;
    }
    await this.evaluate(`(document.open(), document.write(${JSON.stringify(html)}), document.close(), 'ok')`);
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
    return this.goto(await this.url());
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
   * A new page starts at about:blank, as in Playwright: the first call
   * that needs a document opens one (with the init scripts installed).
   */
  private async ensureOpen(): Promise<void> {
    if (this.pageId) return;
    const resp = await this.client.call('vs_open', ['about:blank'], { session: this.sessionId });
    const id = resp.body[0];
    if (!id) throw new Error('vs_open returned no page id for about:blank');
    this.pageId = id;
    await this.applyViewport();
    this.token = resp.token;
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
    await this.navigate(target);
    return this.mainResponse();
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
    const req = new Request({ id: 0, url, method: 'GET', headers: {}, body: null, type: 'document' });
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

  private async navigate(target: string): Promise<void> {
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
    const first = this.initScripts.length > 0 ? 'about:blank' : url;
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
      const nav = await this.client.call('vs_goto', [id, url], { session: this.sessionId });
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
    await this.ensureOpen();
    try {
      const resp = await this.client.call(
        'vs_click_at',
        [this.id, String(Math.round(x * 100) / 100), String(Math.round(y * 100) / 100)],
        { session: this.sessionId, token: this.token ?? '0', mode: mode ?? this.inputMode },
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
  private async rawEval<T>(src: string): Promise<T> {
    await this.ensureOpen();
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

  /**
   * Run `body` (an expression that may use the engine as `E`) in the
   * page. Installs the engine on first use in each document, waits out
   * promises, and turns page exceptions into thrown Errors.
   */
  async engineCall(body: string): Promise<unknown> {
    const call = (install: boolean) =>
      `(function(){var E=${install ? ENGINE_JS : 'window.__tse'};if(!E)return {noengine:1};return E.exec(function(){return ${body};});})()`;
    let r = await this.rawEval<EngineReply | null>(call(false));
    if (r && r.noengine) r = await this.rawEval<EngineReply | null>(call(true));
    for (let i = 0; r && r.p !== undefined; i++) {
      await sleep(i < 5 ? 2 : i < 20 ? 10 : 25);
      r = await this.rawEval<EngineReply | null>(`(function(){var E=window.__tse;return E?E.take(${r.p}):{gone:1};})()`);
    }
    if (!r || r.gone || r.noengine) {
      throw new Error('Execution context was destroyed, most likely because of a navigation');
    }
    if (r.e) {
      const err = new Error(r.e.message);
      err.name = r.e.name ?? 'Error';
      throw err;
    }
    return deserializeValue(r.v);
  }

  /** One locator-engine request (see src/injected.ts). `fn` is a function source passed alongside. */
  async engineRun<T>(req: Record<string, unknown>, fn?: string): Promise<T> {
    return (await this.engineCall(`E.run(${JSON.stringify(req)}${fn ? `,(${fn})` : ''})`)) as T;
  }

  /** Log lines from the last locator-handler run that blocked a wait. */
  handlerLog: string[] = [];

  private locatorHandlers: {
    locator: Locator;
    handler: (l: Locator) => unknown;
    times: number | null;
    noWaitAfter: boolean;
  }[] = [];
  private handlingLocators = false;

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
    this.locatorHandlers.push({ locator, handler, times: options.times ?? null, noWaitAfter: options.noWaitAfter ?? false });
  }

  async removeLocatorHandler(locator: Locator): Promise<void> {
    this.locatorHandlers = this.locatorHandlers.filter((h) => h.locator.toString() !== locator.toString());
  }

  /**
   * @internal Run the handlers whose locator is visible now. Called on
   * each action and assertion retry. Returns false while a handled
   * locator has not gone away yet: the caller keeps waiting, as
   * Playwright does, until it hides or the caller's time runs out.
   */
  async runLocatorHandlers(deadline = Date.now() + this.timeouts.action): Promise<boolean> {
    if (this.handlingLocators || this.locatorHandlers.length === 0) return true;
    this.handlingLocators = true;
    try {
      for (const h of [...this.locatorHandlers]) {
        const seen = await h.locator.peek<boolean>('locatorHandler', 'visible').catch(() => ({ found: false, v: false, preview: '' }));
        if (!seen.found || seen.v !== true) continue;
        this.handlerLog = [`found ${h.locator.toString()}, intercepting action to run the handler`, `locator resolved to visible ${seen.preview ?? ''}`];
        await h.handler(h.locator);
        if (h.times !== null && --h.times <= 0) this.locatorHandlers = this.locatorHandlers.filter((x) => x !== h);
        if (h.noWaitAfter) continue;
        this.handlerLog.push(`locator handler has finished, waiting for ${h.locator.toString()} to be hidden`);
        const left = Math.max(1, deadline - Date.now());
        const hidden = await h.locator.waitFor({ state: 'hidden', timeout: left }).then(() => true, () => false);
        if (!hidden) return false;
        this.handlerLog = [];
      }
      return true;
    } finally {
      this.handlingLocators = false;
    }
  }

  /** Poll `fn(arg)` in the page until it returns a truthy value, and return that value. */
  async waitForFunction<T = unknown, A = unknown>(
    fn: string | ((arg: A) => unknown),
    arg?: A,
    options: { timeout?: number; polling?: number | 'raf' } = {},
  ): Promise<T> {
    const budget = options.timeout ?? this.timeouts.action;
    const deadline = Date.now() + budget;
    const every = typeof options.polling === 'number' ? options.polling : 16;
    for (;;) {
      const v = await this.evaluate<T, A>(fn, arg);
      if (v) return v;
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

  private main: Frame | null = null;

  /** The page's top frame. */
  mainFrame(): Frame {
    this.main ??= new Frame(this, null, null);
    return this.main;
  }

  private frameCache: Frame[] = [];

  /**
   * The main frame, then every iframe, depth first, as of the last
   * navigation or refreshFrames() call (Playwright's frames() is
   * synchronous; testsurfer reads the frame tree after each load).
   */
  frames(): Frame[] {
    return [this.mainFrame(), ...this.frameCache];
  }

  /** Re-read the frame tree, for iframes added after the page loaded. */
  async refreshFrames(): Promise<Frame[]> {
    let rows: [number, number | null, string, string][] = [];
    try {
      rows = (await this.engineCall('E.frames()')) as [number, number | null, string, string][];
    } catch {
      rows = [];
    }
    const byId = new Map<number, Frame>();
    const out: Frame[] = [];
    for (const [id, parent, name, url] of rows) {
      const f = new Frame(this, new ElementHandle(this, id), parent === null ? this.mainFrame() : (byId.get(parent) ?? this.mainFrame()));
      f.frameName = name;
      f.frameUrl = url;
      byId.set(id, f);
      out.push(f);
    }
    this.frameCache = out;
    return this.frames();
  }

  /** A frame by name, or by URL (string, RegExp or predicate). */
  frame(match: string | { name?: string; url?: string | RegExp | ((u: URL) => boolean) }): Frame | null {
    const all = this.frames();
    const m = typeof match === 'string' ? { name: match } : match;
    return (
      all.find((f) => {
        if (m.name !== undefined && f.name() !== m.name) return false;
        if (m.url !== undefined) {
          const u = f === this.main ? '' : f.frameUrl;
          if (typeof m.url === 'string' && u !== m.url) return false;
          if (m.url instanceof RegExp && !m.url.test(u)) return false;
          if (typeof m.url === 'function' && !(u && m.url(new URL(u)))) return false;
        }
        return true;
      }) ?? null
    );
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
  click(selector: string, options?: ClickOptions): Promise<void> {
    return this.locator(selector).click(options);
  }
  dblclick(selector: string, options?: ClickOptions): Promise<void> {
    return this.locator(selector).dblclick(options);
  }
  tap(selector: string, options?: ClickOptions): Promise<void> {
    return this.locator(selector).tap(options);
  }
  hover(selector: string, options?: { timeout?: number; force?: boolean }): Promise<void> {
    return this.locator(selector).hover(options);
  }
  focus(selector: string, options?: { timeout?: number }): Promise<void> {
    return this.locator(selector).focus(options);
  }
  fill(selector: string, value: string, options?: { timeout?: number; force?: boolean }): Promise<void> {
    return this.locator(selector).fill(value, options);
  }
  type(selector: string, text: string, options?: { timeout?: number }): Promise<void> {
    return this.locator(selector).type(text, options);
  }
  press(selector: string, key: string, options?: { timeout?: number }): Promise<void> {
    return this.locator(selector).press(key, options);
  }
  check(selector: string, options?: ClickOptions): Promise<void> {
    return this.locator(selector).check(options);
  }
  uncheck(selector: string, options?: ClickOptions): Promise<void> {
    return this.locator(selector).uncheck(options);
  }
  setChecked(selector: string, checked: boolean, options?: ClickOptions): Promise<void> {
    return this.locator(selector).setChecked(checked, options);
  }
  selectOption(selector: string, values: SelectOptionValue | SelectOptionValue[] | null, options?: { timeout?: number }): Promise<string[]> {
    return this.locator(selector).selectOption(values, options);
  }
  setInputFiles(selector: string, files: InputFile | InputFile[], options?: { timeout?: number }): Promise<void> {
    return this.locator(selector).setInputFiles(files, options);
  }
  dispatchEvent(selector: string, type: string, eventInit?: Record<string, unknown>, options?: { timeout?: number }): Promise<void> {
    return this.locator(selector).dispatchEvent(type, eventInit, options);
  }
  textContent(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.locator(selector).textContent(options);
  }
  innerText(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.locator(selector).innerText(options);
  }
  innerHTML(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.locator(selector).innerHTML(options);
  }
  getAttribute(selector: string, name: string, options?: { timeout?: number }): Promise<string | null> {
    return this.locator(selector).getAttribute(name, options);
  }
  inputValue(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.locator(selector).inputValue(options);
  }
  isVisible(selector: string): Promise<boolean> {
    return this.locator(selector).isVisible();
  }
  isHidden(selector: string): Promise<boolean> {
    return this.locator(selector).isHidden();
  }
  isChecked(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.locator(selector).isChecked(options);
  }
  isDisabled(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.locator(selector).isDisabled(options);
  }
  isEnabled(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.locator(selector).isEnabled(options);
  }
  isEditable(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.locator(selector).isEditable(options);
  }

  /**
   * Keyboard input to the focused element. press/down/up dispatch key
   * events with the browser's default action (typing, Enter submits,
   * Backspace deletes, Tab moves focus); type() sends trusted
   * per-character input.
   */
  readonly keyboard = {
    press: async (key: string, _options?: { delay?: number }): Promise<void> => {
      await this.engineCall(`E.key(${JSON.stringify(key)})`);
    },
    down: async (key: string): Promise<void> => {
      await this.engineCall(`E.key(${JSON.stringify(key)},'down')`);
    },
    up: async (key: string): Promise<void> => {
      await this.engineCall(`E.key(${JSON.stringify(key)},'up')`);
    },
    type: async (text: string, _options?: { delay?: number }): Promise<void> => {
      await this.typeTrusted(text);
    },
    insertText: async (text: string): Promise<void> => {
      await this.engineCall(`E.insertText(${JSON.stringify(text)})`);
    },
  };

  private viewport: { width: number; height: number } | null = null;
  private dpr = 1;

  /** @internal Size every new web view of this page gets. */
  initialViewport(size: { width: number; height: number } | null, dpr: number): void {
    this.viewport = size;
    this.dpr = dpr;
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
    const out = encodePng({ width: w, height: h, data });
    if (path) {
      const nodePath = await import('node:path');
      await fs.mkdir(nodePath.dirname(path), { recursive: true });
      await fs.writeFile(path, out);
    }
    return out;
  }

  /** The page's current URL. */
  async url(): Promise<string> {
    const href = await this.evaluate<string>('location.href');
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
    return nav ? nav.shown : href;
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
    const file = await this.capture(null, options);
    return (await import('node:fs/promises')).readFile(file);
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
    await this.ensureOpen();
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
