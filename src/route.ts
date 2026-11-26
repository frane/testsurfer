/** page.route(): a held request and the handler's decision (continue, fulfill, abort, fallback). */

import { readFile } from 'node:fs/promises';
import type { APIResponse, Request } from './http.ts';

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

export type Decision = Record<string, unknown> & { kind: string };

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

export function overrides(o: ContinueOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o.url) out['url'] = o.url;
  if (o.method) out['method'] = o.method;
  if (o.headers) out['headers'] = o.headers;
  if (o.postData !== undefined) out['body'] = Buffer.isBuffer(o.postData) ? o.postData.toString('utf8') : o.postData;
  return out;
}

export type RouteHandler = (route: Route, request: Request) => Promise<void> | void;
