/**
 * Network events and routing through vibesurfer's intercepting proxy
 * (`vs session-open --intercept`, vibesurfer 0.2.16+). Every http
 * request the engine makes passes the proxy: documents, iframes,
 * scripts, images, fetch, XHR. One hub per session polls `vs_net_poll`
 * and hands each event to the session's pages; while any page or the
 * context has a route, the proxy holds every request until a handler
 * (or the hub, when none matches) decides.
 *
 * HTTPS is tunnelled by the proxy without interception, so https
 * requests are neither reported nor routable in this mode.
 */

import type { WireClient } from './client.ts';
import { APIResponse, Request, Response, type ContinueOptions } from './events.ts';

/** What a page's event state offers the hub. */
export interface NetPage {
  /** Report an event to this page's listeners. */
  netEmit(name: string, arg: unknown): void;
  /** True when the page needs requests held: routes, or extra headers to add. */
  netRoutes(): boolean;
  /** setExtraHTTPHeaders() values. */
  netExtraHeaders(): Record<string, string>;
  /** The page's main frame, for request.frame(). */
  netFrame(): unknown;
  /** A route aborted a main-frame navigation. */
  netNavAborted(): void;
  /**
   * Run this page's matching route handlers for a held request.
   * Resolves true when one of them decided; `fallthrough` collects
   * fallback() overrides for the next page or the network.
   */
  netHandle(req: Request, decide: NetDecider, fallthrough: ContinueOptions): Promise<boolean>;
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

  private async conn(): Promise<WireClient> {
    this.client ??= await this.open();
    return this.client;
  }

  private call(prim: string, args: string[], flags: Record<string, string> = {}) {
    return this.conn().then((c) => c.call(prim, args, { session: this.sessionId, ...flags }));
  }

  attach(page: NetPage): void {
    this.pages.add(page);
    this.loop();
  }

  detach(page: NetPage): void {
    this.pages.delete(page);
    if (this.pages.size === 0) this.close();
  }

  /** Hold requests while any page has a route; let them run otherwise. */
  async sync(): Promise<void> {
    const want = [...this.pages].some((p) => p.netRoutes());
    if (want === this.routing) return;
    this.routing = want;
    await this.call('vs_net_route', [want ? 'on' : 'off']);
  }

  private close(): void {
    this.running = false;
    this.client?.close();
    this.client = null;
    hubs.delete(this.sessionId);
  }

  private loop(): void {
    if (this.running) return;
    this.running = true;
    void (async () => {
      while (this.running && this.pages.size > 0) {
        try {
          const resp = await this.call('vs_net_poll', [], { 'wait-ms': '250' });
          this.handle(resp.body);
        } catch {
          if (!this.running) return;
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      this.running = false;
    })();
  }

  private emit(name: string, arg: unknown): void {
    for (const p of this.pages) p.netEmit(name, arg);
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
          const k = line.slice(2, i).toLowerCase();
          const v = line.slice(i + 2);
          cur.headers[k] = cur.headers[k] === undefined ? v : `${cur.headers[k]}, ${v}`;
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
          cur = { kind: parts[0], id, head: parts, headers: {} };
          break;
        case 'fin': {
          const req = this.requests.get(id);
          if (req) {
            this.emit('requestfinished', req);
            this.requests.delete(id);
          }
          break;
        }
        case 'fail': {
          const req = this.requests.get(id);
          if (req) {
            // WebKit reports a request a route aborted this way.
            req.failureText = req.abortedByRoute ? 'Blocked by Web Inspector' : parts.slice(2).join(' ') || 'failed';
            this.emit('requestfailed', req);
            this.requests.delete(id);
          }
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
      const type = attrs['type'] ?? 'other';
      const req = new Request({
        id: p.id,
        url,
        method,
        headers: p.headers,
        body: p.body ? Buffer.from(p.body, 'base64').toString('latin1') : null,
        type: type as 'fetch',
        navigation: attrs['nav'] === '1',
        frame: attrs['frame'] === 'sub' ? 'sub' : 'main',
      });
      const page = [...this.pages][0];
      req.frameValue = page ? page.netFrame() : null;
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
      this.requests.set(p.id, req);
      this.emit('request', req);
      if (this.routing) void this.route(req, !!from);
      return;
    }
    // res <id> <status> <url> <reason...>
    const req = this.requests.get(p.id);
    if (!req) return;
    const status = Number(p.head[2]);
    const url = p.head[3] ?? req.url();
    const res = new Response(req, { url, status, statusText: p.head.slice(4).join(' '), headers: p.headers });
    res.bodyLoader = async () => {
      const r = await this.call('vs_net_body', [String(p.id)]);
      const line = r.body.find((l) => l.startsWith('body ')) ?? 'body ';
      return Buffer.from(line.slice(5), 'base64');
    };
    req.responseValue = res;
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
    this.emit('response', res);
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
      // CORS preflights are not shown to routes; they go to the network.
      const preflight = req.method() === 'OPTIONS' && req.headers()['access-control-request-method'] !== undefined;
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
