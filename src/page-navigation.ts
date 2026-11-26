/**
 * Navigation for a Page: goto (with routed documents), setContent,
 * history, the load and URL waits, and the URL the page reports.
 * The Page owns one and delegates its navigation API to it.
 */

import type { PageEvents } from './events.ts';
import type { Frame } from './frame.ts';
import { Request, Response } from './http.ts';
import type { JSHandle } from './handle.ts';
import type { Timeouts } from './page-options.ts';
import type { PageSession } from './page-session.ts';
import { sleep } from './retry.ts';
import { urlMatches, type UrlMatcher } from './url.ts';
import type { WireClient } from './client.ts';

/** Poll interval while waiting for the URL to change (waitForURL, back/forward). */
const URL_POLL_MS = 50;
/** Poll interval for waitForNavigation's document check. */
const NAV_POLL_MS = 20;
/** Poll interval while a popup's first document loads. */
const POPUP_LOAD_POLL_MS = 30;
/** How long goBack/goForward wait for the URL to change before treating the move as a no-op. */
const HISTORY_SETTLE_MS = 2_000;

/** What PageNavigation needs from its page. */
export interface NavigationHost {
  readonly client: WireClient;
  readonly sessionId: string;
  readonly session: PageSession;
  readonly events: PageEvents;
  readonly baseURL: string | undefined;
  readonly timeouts: Timeouts;
  /** Navigate in place with vs_goto (protocol v1) instead of close and reopen. */
  readonly navInPlace: boolean;
  /** Document-start scripts every new web view gets before its first document. */
  initScripts(): string[];
  applyViewport(): Promise<void>;
  /** Re-work out the isMobile zoom for the new document. */
  updateZoom(): Promise<void>;
  refreshFrames(): Promise<Frame[]>;
  mainFrame(): Frame;
  evaluate<T = unknown>(fn: string, arg?: unknown): Promise<T>;
  /** Evaluate an expression through vs_inspect, without the engine. */
  rawEval<T>(src: string): Promise<T>;
  waitForFunction(fn: string, arg: undefined, options: { timeout?: number }): Promise<JSHandle>;
}

export class PageNavigation {
  private readonly host: NavigationHost;

  constructor(host: NavigationHost) {
    this.host = host;
  }

  /** The URL a popup was opened with, until waitForLoadState() sees it loaded. */
  popupURL = '';

  /** Poll until the URL matches. */
  async waitForURL(url: UrlMatcher, options: { timeout?: number } = {}): Promise<void> {
    const budget = options.timeout ?? this.host.timeouts.navigation;
    const deadline = Date.now() + budget;
    for (;;) {
      const now = await this.currentURL().catch(() => '');
      if (now && urlMatches(url, now, this.host.baseURL)) return;
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
    const budget = options.timeout ?? this.host.timeouts.navigation;
    const deadline = Date.now() + budget;
    // Mark the current document; a new one will not carry the mark.
    const mark = `nav${Date.now()}${Math.random().toString(36).slice(2)}`;
    await this.host.rawEval(`(window.__tsNavMark = ${JSON.stringify(mark)}, 0)`).catch(() => {});
    for (;;) {
      const state = await this.host.rawEval<{ m: string | null; r: string; u: string } | null>(
        `({ m: window.__tsNavMark || null, r: document.readyState, u: location.href })`,
      ).catch(() => null);
      if (state && state.m !== mark && state.r !== 'loading') {
        if (!options.url || urlMatches(options.url, state.u, this.host.baseURL)) {
          this.host.session.invalidate();
          this.host.events.documentChanged();
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
      const budget = options.timeout ?? this.host.timeouts.navigation;
      const deadline = Date.now() + budget;
      for (;;) {
        const r = await this.host.rawEval<string>(`location.href + ' ' + document.readyState`).catch(() => '');
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
    await this.host.refreshFrames();
  }

  /**
   * Replace the document with `html`; its scripts run. On an http(s)
   * page the document is rewritten in place, so it keeps that origin
   * and relative URLs resolve against it. Otherwise the page loads the
   * HTML as a data: URL (an opaque origin, no storage): WebKit drops
   * native clicks on a rewritten about:blank.
   */
  async setContent(html: string): Promise<void> {
    const here = this.host.session.pageId ? await this.currentURL().catch(() => '') : '';
    if (!/^https?:/.test(here)) {
      const shown = here.startsWith('data:') ? here : 'about:blank';
      const data = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      await this.navigate(data);
      await this.rememberNav(shown, data);
      await this.host.refreshFrames();
      await this.host.updateZoom().catch(() => {});
      return;
    }
    await this.host.evaluate(`(document.open(), document.write(${JSON.stringify(html)}), document.close(), 'ok')`);
    // Like Playwright, return once the new document (stylesheets, images) has loaded.
    await this.host.waitForFunction("document.readyState === 'complete'", undefined, { timeout: this.host.timeouts.navigation }).catch(() => {});
    await this.host.updateZoom().catch(() => {});
    await this.host.refreshFrames();
    this.host.session.invalidate();
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
    await this.host.evaluate(`(history.go(${delta}), 'ok')`);
    // No history entry means no change; give up on the URL after a while.
    const deadline = Date.now() + HISTORY_SETTLE_MS;
    while (Date.now() < deadline) {
      await sleep(URL_POLL_MS);
      const now = await this.currentURL().catch(() => before);
      if (now !== before) break;
    }
    this.host.session.invalidate();
    this.host.events.documentChanged();
  }

  /**
   * Navigate to a URL, relative to the baseURL launch option when set.
   * Navigates in place on protocol-v1 daemons; older ones close the
   * page and open a new one.
   */
  async goto(target: string, _options: { waitUntil?: string; timeout?: number; referer?: string } = {}): Promise<Response | null> {
    try {
      await this.host.events.beforeNavigation();
      // Shim mode: the in-page shim cannot see a document request, so
      // the page's routes decide it here.
      const url = this.host.baseURL ? new URL(target, this.host.baseURL).href : target;
      const routed = /^https?:/.test(url) ? await this.host.events.routeDocument(url) : null;
      if (routed?.kind === 'abort') this.host.events.netNavAborted();
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
      if (this.host.events.abortedNavigation()) throw new Error(`page.goto: Blocked by Web Inspector`);
      throw e;
    }
    const viaProxy = await this.host.events.proxiedNavResponse();
    const res = viaProxy ?? (await this.mainResponse());
    if (res || !target.startsWith('file:')) return res;
    // A file: page has a response too, with status 0, as in WebKit under Playwright.
    const req = new Request({ id: 0, url: target, method: 'GET', headers: {}, body: null, type: 'document', navigation: true });
    req.frameValue = this.host.mainFrame();
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
    if (!this.host.session.pageId) return null;
    let body: string[];
    try {
      body = (await this.host.client.call('vs_inspect', ['response', this.host.session.pageId], { session: this.host.sessionId })).body;
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
    req.frameValue = this.host.mainFrame();
    const res = new Response(req, { url, status, statusText, headers });
    req.responseValue = res;
    res.bodyLoader = async () => {
      const b64 = await this.host.evaluate<string>(
        `fetch(${JSON.stringify(url)}, { credentials: 'include' }).then((r) => r.arrayBuffer()).then((b) => { let s = ''; const a = new Uint8Array(b); for (let i = 0; i < a.length; i += 32768) s += String.fromCharCode.apply(null, a.subarray(i, i + 32768)); return btoa(s); })`,
      );
      return Buffer.from(b64, 'base64');
    };
    return res;
  }

  /** `html`: load that document under the URL instead of fetching it (a routed document). */
  private async navigate(target: string, html?: Buffer): Promise<void> {
    const url = this.host.baseURL ? new URL(target, this.host.baseURL).href : target;
    const gotoFlags: Record<string, string> = { session: this.host.sessionId };
    if (html) gotoFlags['html'] = html.toString('base64');
    if (this.host.session.pageId && this.host.navInPlace) {
      try {
        const resp = await this.host.client.call('vs_goto', [this.host.session.pageId, url], gotoFlags);
        this.host.session.token = resp.token;
        this.host.session.invalidate();
        this.host.events.documentChanged();
        await this.rememberNav(url, url);
        await this.host.refreshFrames();
        return;
      } catch {
        // Old daemon or dead page; fall through to close+open.
      }
    }
    if (this.host.session.pageId) {
      await this.host.client
        .call('vs_close', [this.host.session.pageId], { session: this.host.sessionId })
        .catch(() => {});
      this.host.session.pageId = null;
    }
    this.host.session.token = null;
    this.host.session.invalidate();
    // Init scripts have to be in place before the first document, so
    // a page that has them opens blank, installs them, then loads.
    const first = this.host.initScripts().length > 0 || html ? 'about:blank' : url;
    const resp = await this.host.client.call('vs_open', [first], { session: this.host.sessionId });
    const id = resp.body[0];
    if (!id) throw new Error(`vs_open returned no page id for ${url}`);
    this.host.session.pageId = id;
    await this.host.applyViewport();
    this.host.session.token = resp.token;
    if (first !== url) {
      for (const src of this.host.initScripts()) {
        await this.host.client.call('vs_init_script', [id, src], { session: this.host.sessionId });
      }
      const nav = await this.host.client.call('vs_goto', [id, url], gotoFlags);
      this.host.session.token = nav.token;
    }
    this.host.events.documentChanged();
    await this.rememberNav(url, url);
    await this.host.refreshFrames();
    // No settle wait here: locators auto-wait and assertions poll, so
    // a still-loading tree just resolves a poll tick later.
  }

  /** The page's current URL. */
  /** The location every engine call reports; Playwright's page.url() is synchronous. */
  lastHref = 'about:blank';

  /** A service worker controlled the page as of the last engine call. */
  swControlled = false;

  /** The page's URL as of the last call into the page (actions, reads and navigations all refresh it). */
  url(): string {
    return this.shownURL(this.lastHref);
  }

  /** Read location.href now. */
  async currentURL(): Promise<string> {
    this.lastHref = await this.host.evaluate<string>('location.href');
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
    const actual = await this.host.evaluate<string>('location.href').catch(() => '');
    this.navURL = actual ? { shown, actual } : null;
  }
}
