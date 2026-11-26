/**
 * Network events and routing through vibesurfer's intercepting proxy
 * (`vs session-open --intercept`, vibesurfer 0.2.16+). Every http
 * request the engine makes passes the proxy: documents, iframes,
 * scripts, images, fetch, XHR. One hub per session polls `vs_net_poll`
 * and hands each event to the session's pages; while any page or the
 * context has a route, the proxy holds every request until a handler
 * (or the hub, when none matches) decides.
 *
 * HTTPS goes through the proxy too: it answers the browser's TLS with
 * leaves from the daemon's CA, which only intercept pages trust.
 * Popups (`--popups`) arrive on the same stream as `page` and `close`
 * lines, and become Page objects of the context.
 */

import type { WireClient } from './client.ts';
import { APIResponse, Request, Response } from './http.ts';
import type { ContinueOptions } from './route.ts';

/** What a page's event state offers the hub. */
export interface NetPage {
  /** Report an event to this page's listeners. */
  netEmit(name: string, arg: unknown): void;
  /** True when the page needs requests held: routes, or extra headers to add. */
  netRoutes(): boolean;
  /** setExtraHTTPHeaders() values. */
  netExtraHeaders(): Record<string, string>;
  /** The frame for request.frame(): the main frame, or the iframe loading `url`. */
  netFrame(kind: 'main' | 'sub', url: string): unknown;
  /** A route aborted a main-frame navigation. */
  netNavAborted(): void;
  /**
   * Run this page's matching route handlers for a held request.
   * Resolves true when one of them decided; `fallthrough` collects
   * fallback() overrides for the next page or the network.
   */
  netHandle(req: Request, decide: NetDecider, fallthrough: ContinueOptions): Promise<boolean>;
  /** A popup: it gets its own requests only, not the session's. */
  netIsPopup?(): boolean;
  /** The page's service worker handed on a request with this referer. */
  netViaServiceWorker?(referer: string): boolean;
}

/** The context side of a session's hub: popups, closes, context-level events. */
export interface NetContext {
  netEmit(name: string, arg: unknown): void;
  /** A page opened a popup (vibesurfer `--popups`); returns the popup's events, attached. */
  netPopup(openerId: string, pageId: string, url: string): NetPage | null;
  /** A page closed itself (`window.close()`). */
  netPageClosed(pageId: string): void;
  /** A page's web content process died. */
  netPageCrashed?(pageId: string): void;
  /** A page opened a dialog; `answer` closes it. */
  netDialog(
    pageId: string,
    kind: string,
    message: string,
    defaultText: string,
    answer: (accept: boolean, text?: string) => Promise<void>,
  ): void;
}

/** How a handler's decision reaches the proxy. */
export interface NetDecider {
  continue(o: ContinueOptions): Promise<void>;
  fulfill(status: number, headers: Record<string, string>, body: Buffer): Promise<void>;
  abort(errorCode: string): Promise<void>;
  fetch(o: ContinueOptions): Promise<APIResponse>;
}

const hubs = new Map<string, NetHub>();

/** Playwright's error codes for route.abort(), passed to the proxy as the failure text. */
function headerLines(h: Record<string, string>): string {
  return Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

function overrideFlags(o: ContinueOptions): Record<string, string> {
  const f: Record<string, string> = {};
  if (o.url) f['url'] = o.url;
  if (o.method) f['method'] = o.method;
  if (o.headers) f['headers'] = headerLines(o.headers);
  if (o.postData !== undefined) f['body-b64'] = Buffer.from(o.postData).toString('base64');
  return f;
}

interface Pending {
  kind: 'req' | 'res';
  id: number;
  head: string[];
  headers: Record<string, string>;
  raw: { name: string; value: string }[];
  body?: string;
}

export class NetHub {
  private readonly sessionId: string;
  private readonly open: () => Promise<WireClient>;
  private client: WireClient | null = null;
  private readonly pages = new Set<NetPage>();
  private running = false;
  private routing = false;
  private readonly requests = new Map<number, Request>();
  private readonly responses = new Map<number, Response>();
  /** Body sizes of fulfilled requests, by id. */
  private readonly fulfilledLength = new Map<number, number>();

  /** The last main-frame document response, for goto(). */
  lastNav: Response | null = null;

  /** Take the proxy's queue now (after a navigation), rather than on the next poll. */
  async drainNow(): Promise<void> {
    try {
      const resp = await this.call('vs_net_poll', [], { 'wait-ms': '0' });
      this.handle(resp.body);
    } catch {
      /* the regular poll will pick it up */
    }
  }

  /** Redirect targets seen in 3xx responses, to link the next hop to its origin request. */
  private readonly redirects = new Map<string, Request>();

  private constructor(sessionId: string, open: () => Promise<WireClient>) {
    this.sessionId = sessionId;
    this.open = open;
  }

  static for(sessionId: string, open: () => Promise<WireClient>): NetHub {
    let h = hubs.get(sessionId);
    if (!h) {
      h = new NetHub(sessionId, open);
      hubs.set(sessionId, h);
    }
    return h;
  }

  private closed = false;
  private opening: Promise<WireClient> | null = null;

  private async conn(): Promise<WireClient> {
    if (this.client) return this.client;
    this.opening ??= this.open();
    const c = await this.opening;
    // Closed while the connection was opening: do not keep it.
    if (this.closed) {
      c.close();
      throw new Error('network hub closed');
    }
    this.client = c;
    return c;
  }

  private call(prim: string, args: string[], flags: Record<string, string> = {}) {
    return this.conn().then((c) => c.call(prim, args, { session: this.sessionId, ...flags }));
  }

  // The long poll has a connection of its own: a connection answers one
  // request at a time, so a decision sent behind a waiting poll would
  // wait out the poll first (about 250 ms per routed request).
  private pollClient: WireClient | null = null;
  private pollOpening: Promise<WireClient> | null = null;

  private async pollConn(): Promise<WireClient> {
    if (this.pollClient) return this.pollClient;
    this.pollOpening ??= this.open();
    const c = await this.pollOpening;
    if (this.closed) {
      c.close();
      throw new Error('network hub closed');
    }
    this.pollClient = c;
    return c;
  }

  attach(page: NetPage): void {
    this.pages.add(page);
    this.loop();
  }

  detach(page: NetPage): void {
    this.pages.delete(page);
    if (this.pages.size === 0 && !this.ctx) this.close();
  }

  private ctx: NetContext | null = null;

  /** The context listens for popups and context-level events. */
  attachContext(ctx: NetContext): void {
    this.ctx = ctx;
    this.loop();
  }

  detachContext(): void {
    this.ctx = null;
    if (this.pages.size === 0) this.close();
  }

  /** Popups whose first navigation has not arrived yet, by URL. */
  private readonly popupNav = new Map<string, NetPage>();
  /** The page a request belongs to, when not the whole session. */
  /** The page a request belongs to; null for a service worker's own requests (context only). */
  private readonly owners = new Map<number, NetPage | null>();
  /** Service worker scripts seen (`Service-Worker: script`). */
  private readonly swScripts = new Set<string>();

  /** Hold requests while any page has a route; let them run otherwise. */
  async sync(): Promise<void> {
    const want = [...this.pages].some((p) => p.netRoutes());
    if (want === this.routing) return;
    this.routing = want;
    await this.call('vs_net_route', [want ? 'on' : 'off']);
  }

  private close(): void {
    this.closed = true;
    this.running = false;
    this.client?.close();
    this.client = null;
    void this.opening?.then((c) => c.close(), () => {});
    this.pollClient?.close();
    this.pollClient = null;
    void this.pollOpening?.then((c) => c.close(), () => {});
    hubs.delete(this.sessionId);
  }

  private loop(): void {
    if (this.running) return;
    this.running = true;
    void (async () => {
      while (this.running && (this.pages.size > 0 || this.ctx)) {
        try {
          const c = await this.pollConn();
          const resp = await c.call('vs_net_poll', [], { session: this.sessionId, 'wait-ms': '250' });
          this.handle(resp.body);
        } catch {
          if (!this.running) return;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      this.running = false;
    })();
  }

  /**
   * To `owner` alone, to the context alone (`null`), or to every page
   * but popups (`undefined`); and to the context in every case.
   */
  private emit(name: string, arg: unknown, owner?: NetPage | null): void {
    if (owner) owner.netEmit(name, arg);
    else if (owner === undefined) for (const p of this.pages) if (!p.netIsPopup?.()) p.netEmit(name, arg);
    this.ctx?.netEmit(name, arg);
  }

  /** Parse one poll body: `req`/`res` lines with their `h`/`body` lines, `fin`, `fail`. */
  private handle(lines: string[]): void {
    let cur: Pending | null = null;
    const flush = () => {
      if (cur) this.event(cur);
      cur = null;
    };
    for (const line of lines) {
      if (line.startsWith('h ') && cur) {
        const i = line.indexOf(': ');
        if (i > 2) {
          const name = line.slice(2, i);
          const k = name.toLowerCase();
          const v = line.slice(i + 2);
          cur.raw.push({ name, value: v });
          // Repeated headers join with ", "; set-cookie values with newlines, as Playwright does.
          const sep = k === 'set-cookie' ? '\n' : ', ';
          cur.headers[k] = cur.headers[k] === undefined ? v : `${cur.headers[k]}${sep}${v}`;
        }
        continue;
      }
      if (line.startsWith('body ') && cur) {
        cur.body = line.slice(5);
        continue;
      }
      flush();
      const parts = line.split(' ');
      const id = Number(parts[1]);
      switch (parts[0]) {
        case 'req':
        case 'res':
          cur = { kind: parts[0], id, head: parts, headers: {}, raw: [] };
          break;
        case 'fin': {
          const req = this.requests.get(id);
          if (req) {
            req.markSettled();
            req.markDone();
            this.emit('requestfinished', req, this.owners.get(id));
            this.requests.delete(id);
            this.owners.delete(id);
          }
          break;
        }
        case 'fail': {
          const req = this.requests.get(id);
          if (req) {
            // WebKit reports a request a route aborted this way.
            req.failureText = req.abortedByRoute ? 'Blocked by Web Inspector' : parts.slice(2).join(' ') || 'failed';
            req.markSettled();
            req.markDone();
            this.emit('requestfailed', req, this.owners.get(id));
            this.requests.delete(id);
            this.owners.delete(id);
          }
          break;
        }
        case 'page': {
          // page <opener> <page> <url>: the popup exists before its first request.
          const url = parts.slice(3).join(' ');
          const popup = this.ctx?.netPopup(parts[1] ?? '', parts[2] ?? '', url) ?? null;
          if (popup && url && url !== 'about:blank') this.popupNav.set(url, popup);
          break;
        }
        case 'close':
          this.ctx?.netPageClosed(parts[1] ?? '');
          break;
        case 'crash':
          this.ctx?.netPageCrashed?.(parts[1] ?? '');
          break;
        case 'sw':
          this.serviceWorkerResponse(parts[1] ?? '');
          break;
        case 'dialog': {
          // dialog <page> <id> <kind> <message-b64> <default-b64>
          const dec = (s: string | undefined) => Buffer.from(s ?? '', 'base64').toString('utf8');
          const did = parts[2] ?? '';
          const answer = async (accept: boolean, text?: string) => {
            const flags: Record<string, string> = text === undefined ? {} : { text };
            await this.call('vs_net_dialog', [did, accept ? 'accept' : 'dismiss'], flags);
          };
          if (this.ctx) this.ctx.netDialog(parts[1] ?? '', parts[3] ?? 'alert', dec(parts[4]), dec(parts[5]), answer);
          else void answer(false).catch(() => {});
          break;
        }
      }
    }
    flush();
  }

  private event(p: Pending): void {
    if (p.kind === 'req') {
      // req <id> <METHOD> <url> type=<t> nav=<0|1> [frame=main|sub]
      const [, , method = 'GET', url = ''] = p.head;
      const attrs = Object.fromEntries(p.head.slice(4).map((kv) => kv.split('=') as [string, string]));
      let type = attrs['type'] ?? 'other';
      // The proxy cannot tell an EventSource from fetch; its Accept header can.
      if (type === 'fetch' && (p.headers['accept'] ?? '').includes('text/event-stream')) type = 'eventsource';
      // The proxy forwards one request per connection, so the server sees
      // `Connection: close`; report the headers as they reached it. A
      // WebSocket handshake keeps `Connection: Upgrade`: continuing it with
      // `close` (a route, a user agent, extra headers) would turn it into a
      // plain GET.
      if (type !== 'websocket') {
        if (p.headers['connection'] !== undefined) p.headers['connection'] = 'close';
        for (const h of p.raw) if (h.name.toLowerCase() === 'connection') h.value = 'close';
      }
      const bytes = p.body ? Buffer.from(p.body, 'base64') : null;
      const req = new Request({
        id: p.id,
        url,
        method,
        headers: p.headers,
        body: bytes ? bytes.toString('utf8') : null,
        bodyBytes: bytes,
        raw: p.raw,
        type,
        navigation: attrs['nav'] === '1',
        frame: attrs['frame'] === 'sub' ? 'sub' : 'main',
      });
      // A popup's first navigation is the popup's; Playwright has no
      // frame for it yet. Everything else goes to the session's pages.
      const popup = req.isNavigationRequest() && req.frameKind() === 'main' ? this.popupNav.get(url) : undefined;
      if (popup) {
        this.popupNav.delete(url);
        this.owners.set(p.id, popup);
        req.frameValue = () => {
          throw new Error(
            'request.frame: Frame for this navigation request is not available, because the request was issued before the frame is created. You can check whether the request is a navigation request by calling isNavigationRequest() method.',
          );
        };
      } else {
        const page = [...this.pages].find((pg) => !pg.netIsPopup?.()) ?? [...this.pages][0];
        req.frameValue = page ? () => page.netFrame(req.frameKind(), url) : null;
        // Service workers: a worker script, the worker's own requests
        // (sent with the script as referer; not the page's), and the
        // page's requests the worker handed on.
        const referer = p.headers['referer'] ?? '';
        if (p.headers['service-worker'] === 'script') this.swScripts.add(url);
        if (this.swScripts.has(referer)) this.owners.set(p.id, null);
        else if (page && referer && !req.isNavigationRequest()) req.viaServiceWorker = page.netViaServiceWorker?.(referer) ?? false;
      }
      // setExtraHTTPHeaders() values are part of the request, as handlers and listeners see it.
      const add = Object.assign({}, ...[...this.pages].map((pg) => pg.netExtraHeaders()));
      for (const [k, v] of Object.entries(add)) req.addHeader(k, v as string);
      // A hop of a redirect the proxy already reported: link it, and
      // let it through without routes, as Playwright does.
      const from = this.redirects.get(url);
      if (from) {
        this.redirects.delete(url);
        req.redirectedFromValue = from;
        from.redirectedToValue = req;
      }
      req.awaitsResponse = true;
      this.requests.set(p.id, req);
      this.emit('request', req, this.owners.get(p.id));
      if (this.routing) void this.route(req, !!from);
      return;
    }
    // res <id> <status> <url> <reason...>
    const req = this.requests.get(p.id);
    if (!req) return;
    const status = Number(p.head[2]);
    const url = p.head[3] ?? req.url();
    // A fulfilled response gets the Content-Length the proxy sends with it.
    const sent = this.fulfilledLength.get(p.id);
    if (sent !== undefined && p.headers['content-length'] === undefined) {
      p.headers['content-length'] = String(sent);
      p.raw.push({ name: 'content-length', value: String(sent) });
    }
    const res = new Response(req, { url, status, statusText: p.head.slice(4).join(' '), headers: p.headers });
    res.rawHeaders = p.raw;
    res.viaServiceWorker = req.viaServiceWorker;
    res.bodyLoader = async () => {
      // As in Playwright, the body is there once the response completed.
      await req.done;
      const r = await this.call('vs_net_body', [String(p.id)]);
      const line = r.body.find((l) => l.startsWith('body ')) ?? 'body ';
      return Buffer.from(line.slice(5), 'base64');
    };
    req.responseValue = res;
    req.markSettled();
    this.responses.set(p.id, res);
    if (req.isNavigationRequest() && req.frameKind() === 'main' && !(status >= 300 && status < 400)) this.lastNav = res;
    const loc = p.headers['location'];
    if (status >= 300 && status < 400 && loc) {
      try {
        this.redirects.set(new URL(loc, url).href, req);
      } catch {
        /* not a URL; no hop to link */
      }
    }
    this.emit('response', res, this.owners.get(p.id));
  }

  /** Ids for service-worker responses, below the proxy's. */
  private swSeq = 0;

  /**
   * `sw <base64 JSON>`: a response the page's service worker built or
   * took from its cache, which no network request carried. Reported as
   * the page's request and response, with fromServiceWorker() true.
   */
  private serviceWorkerResponse(b64: string): void {
    let r: {
      url: string;
      method: string;
      headers: [string, string][];
      status: number;
      statusText: string;
      responseHeaders: [string, string][];
      body: string;
    };
    try {
      r = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } catch {
      return;
    }
    const lower = (list: [string, string][]) => Object.fromEntries(list.map(([k, v]) => [k.toLowerCase(), v]));
    const raw = (list: [string, string][]) => list.map(([name, value]) => ({ name, value }));
    const id = -++this.swSeq;
    const page = [...this.pages].find((pg) => !pg.netIsPopup?.()) ?? [...this.pages][0];
    const req = new Request({
      id,
      url: r.url,
      method: r.method,
      headers: lower(r.headers),
      body: null,
      bodyBytes: null,
      raw: raw(r.headers),
      type: 'fetch',
      navigation: false,
      frame: 'main',
    });
    req.frameValue = page ? () => page.netFrame('main', r.url) : null;
    req.viaServiceWorker = true;
    this.emit('request', req);
    const res = new Response(req, { url: r.url, status: r.status, statusText: r.statusText, headers: lower(r.responseHeaders) });
    res.rawHeaders = raw(r.responseHeaders);
    res.viaServiceWorker = true;
    const body = Buffer.from(r.body, 'base64');
    res.bodyLoader = async () => body;
    req.responseValue = res;
    req.markSettled();
    this.emit('response', res);
    this.emit('requestfinished', req);
  }

  /** Offer a held request to each page's routes; continue when none decides. */
  private async route(req: Request, redirectHop = false): Promise<void> {
    const id = String(req.id);
    // A request the page already gave up on is gone from the proxy; ignore that.
    const quiet = (e: unknown) => {
      if (!(e instanceof Error && /NOT_FOUND/.test(e.message))) throw e;
    };
    const extra = (): Record<string, string> => Object.assign({}, ...[...this.pages].map((p) => p.netExtraHeaders()));
    const withExtra = (o: ContinueOptions): ContinueOptions => {
      const add = extra();
      if (!o.headers && Object.keys(add).length === 0) return o;
      const headers = { ...(o.headers ?? req.headers()), ...add };
      // Playwright keeps the page's own cookies even when a route overrides headers.
      const cookie = req.headers()['cookie'];
      if (o.headers && cookie !== undefined) {
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'cookie') delete headers[k];
        headers['cookie'] = cookie;
      }
      return { ...o, headers };
    };
    const decider: NetDecider = {
      continue: async (o) => {
        await this.call('vs_net_continue', [id], overrideFlags(withExtra(o))).catch(quiet);
      },
      fulfill: async (status, headers, body) => {
        const h = { ...headers };
        this.fulfilledLength.set(req.id, body.length);
        // Like Playwright, answer a cross-origin request with its origin allowed.
        const origin = req.headers()['origin'];
        if (origin && !Object.keys(h).some((k) => k.toLowerCase() === 'access-control-allow-origin')) {
          h['access-control-allow-origin'] = origin;
          h['access-control-allow-credentials'] = 'true';
        }
        await this.call('vs_net_fulfill', [id], {
          status: String(status),
          headers: headerLines(h),
          'body-b64': body.toString('base64'),
        }).catch(quiet);
      },
      abort: async (code) => {
        req.abortedByRoute = true;
        if (req.isNavigationRequest() && req.frameKind() === 'main') for (const p of this.pages) p.netNavAborted();
        await this.call('vs_net_abort', [id], { error: code }).catch(quiet);
      },
      fetch: async (o) => {
        const r = await this.call('vs_net_fetch', [id], overrideFlags(o));
        let status = 0;
        let statusText = '';
        let url = req.url();
        const headers: Record<string, string> = {};
        let body = Buffer.alloc(0);
        for (const line of r.body) {
          if (line.startsWith('res ')) {
            const parts = line.split(' ');
            status = Number(parts[2]);
            url = parts[3] ?? url;
            statusText = parts.slice(4).join(' ');
          } else if (line.startsWith('h ')) {
            const i = line.indexOf(': ');
            if (i > 2) headers[line.slice(2, i).toLowerCase()] = line.slice(i + 2);
          } else if (line.startsWith('body ')) body = Buffer.from(line.slice(5), 'base64');
        }
        return new APIResponse({ status, statusText, headers, body, url });
      },
    };
    const fallthrough: ContinueOptions = {};
    try {
      // CORS preflights are not shown to routes. With routes active, the
      // server's own answer is used when it grants the request; when it
      // does not (or cannot be reached), the preflight is granted here,
      // so a route can fulfill a cross-origin request to any host.
      const preflight = req.method() === 'OPTIONS' && req.headers()['access-control-request-method'] !== undefined;
      if (preflight && [...this.pages].some((p) => p.netRoutes())) {
        const real = await decider.fetch({}).catch(() => null);
        const granted = real && Object.keys(real.headers()).some((k) => k.toLowerCase() === 'access-control-allow-origin');
        if (real && granted) {
          await this.call('vs_net_fulfill', [id], {
            status: String(real.status()),
            headers: headerLines(real.headers()),
            'body-b64': (await real.body()).toString('base64'),
          }).catch(quiet);
        } else {
          await this.call('vs_net_fulfill', [id], {
            status: '204',
            headers: headerLines({
              'access-control-allow-origin': req.headers()['origin'] ?? '*',
              'access-control-allow-methods': req.headers()['access-control-request-method'] ?? '*',
              'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? '*',
              'access-control-allow-credentials': 'true',
            }),
            'body-b64': '',
          }).catch(quiet);
        }
        return;
      }
      if (!redirectHop && !preflight) {
        for (const page of [...this.pages]) {
          if (await page.netHandle(req, decider, fallthrough)) return;
        }
      }
      await decider.continue(fallthrough);
    } catch {
      // The request may already be gone (navigation, timeout); nothing to do.
    }
  }
}
