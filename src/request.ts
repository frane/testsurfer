/**
 * page.request / context.request: HTTP calls from the test process
 * (Playwright's APIRequestContext). Requests go out through Node's
 * fetch. With a jar (a context's), each request carries the jar's
 * cookies for its URL and every Set-Cookie of every redirect hop goes
 * back into the jar, so the page and the requests share one login.
 */

import { cookieHeader, fromWire, parseSetCookie, type Cookie, type StorageState, type WireCookie } from './cookies.ts';
import { APIResponse } from './events.ts';

/** Where an APIRequestContext reads and stores cookies. */
export interface CookieJar {
  cookies(): Promise<Cookie[]>;
  store(cookies: WireCookie[]): Promise<void>;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** A string or Buffer is sent as-is; anything else as JSON. */
  data?: unknown;
  form?: Record<string, string | number | boolean>;
  params?: Record<string, string | number | boolean> | string;
  timeout?: number;
  failOnStatusCode?: boolean;
  maxRedirects?: number;
}

export class APIRequestContext {
  private readonly baseURL: string | undefined;
  private readonly jar: CookieJar | null;
  private readonly extraHeaders: () => Record<string, string>;

  constructor(baseURL?: string, jar?: CookieJar, extraHeaders?: () => Record<string, string>) {
    this.baseURL = baseURL;
    this.jar = jar ?? null;
    this.extraHeaders = extraHeaders ?? (() => ({}));
  }

  async fetch(urlOrRequest: string, options: RequestOptions = {}): Promise<APIResponse> {
    const url = new URL(urlOrRequest, this.baseURL);
    if (options.params) {
      const p = typeof options.params === 'string' ? new URLSearchParams(options.params) : options.params;
      const entries = p instanceof URLSearchParams ? [...p.entries()] : Object.entries(p);
      for (const [k, v] of entries) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { ...options.headers };
    let body: string | Buffer | undefined;
    if (options.form) {
      body = new URLSearchParams(Object.entries(options.form).map(([k, v]): [string, string] => [k, String(v)])).toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (options.data !== undefined) {
      if (typeof options.data === 'string' || Buffer.isBuffer(options.data)) body = options.data;
      else {
        body = JSON.stringify(options.data);
        headers['content-type'] ??= 'application/json';
      }
    }
    let method = options.method ?? (body !== undefined ? 'POST' : 'GET');
    const maxRedirects = options.maxRedirects ?? 20;
    const deadline = AbortSignal.timeout(options.timeout ?? 30_000);
    let current = url.href;
    let res: Response;
    for (let hop = 0; ; hop++) {
      const h: Record<string, string> = { ...this.extraHeaders(), ...headers };
      const hasCookie = Object.keys(h).some((k) => k.toLowerCase() === 'cookie');
      if (this.jar && !hasCookie) {
        const c = cookieHeader(await this.jar.cookies(), current);
        if (c) h['cookie'] = c;
      }
      const init: RequestInit = { method, headers: h, redirect: 'manual', signal: deadline };
      if (body !== undefined) init.body = body;
      res = await fetch(current, init);
      if (this.jar) {
        const set = res.headers.getSetCookie().map((v) => parseSetCookie(v, current)).filter((c): c is WireCookie => c !== null);
        if (set.length) await this.jar.store(set);
      }
      const location = res.headers.get('location');
      const redirect = !!location && res.status >= 300 && res.status < 400 && res.status !== 304;
      if (!redirect || maxRedirects === 0) break;
      if (hop >= maxRedirects) throw new Error('apiRequestContext.fetch: Max redirect count exceeded');
      await res.arrayBuffer().catch(() => {});
      current = new URL(location, current).href;
      // 303, and 301/302 after a POST, follow with a GET and no body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        for (const k of Object.keys(headers)) if (/^content-/i.test(k)) delete headers[k];
      }
    }
    const out = new APIResponse({
      url: current,
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      body: Buffer.from(await res.arrayBuffer()),
    });
    if (options.failOnStatusCode && !out.ok()) {
      throw new Error(`apiRequestContext.fetch: ${out.status()} ${out.statusText()}`);
    }
    return out;
  }

  get(url: string, options: RequestOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'GET' });
  }
  head(url: string, options: RequestOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'HEAD' });
  }
  post(url: string, options: RequestOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'POST' });
  }
  put(url: string, options: RequestOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'PUT' });
  }
  patch(url: string, options: RequestOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'PATCH' });
  }
  delete(url: string, options: RequestOptions = {}): Promise<APIResponse> {
    return this.fetch(url, { ...options, method: 'DELETE' });
  }
  async dispose(): Promise<void> {}

  /** The jar's cookies (and no origins: a request context has no storage), as Playwright saves them. */
  async storageState(options: { path?: string } = {}): Promise<StorageState> {
    const state: StorageState = { cookies: this.jar ? await this.jar.cookies() : [], origins: [] };
    if (options.path) {
      const fs = await import('node:fs/promises');
      await fs.writeFile(options.path, JSON.stringify(state, null, 2));
    }
    return state;
  }
}

/** A cookie jar in memory, for request.newContext(). */
class MemoryJar implements CookieJar {
  private jar: Cookie[] = [];
  async cookies(): Promise<Cookie[]> {
    const now = Date.now() / 1000;
    this.jar = this.jar.filter((c) => c.expires < 0 || c.expires > now);
    return [...this.jar];
  }
  async store(list: WireCookie[]): Promise<void> {
    for (const w of list) {
      const c = fromWire(w);
      this.jar = this.jar.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
      if (c.expires < 0 || c.expires > Date.now() / 1000) this.jar.push(c);
    }
  }
  load(cookies: Cookie[]): void {
    this.jar = [...cookies];
  }
}

export interface NewRequestContextOptions {
  baseURL?: string;
  extraHTTPHeaders?: Record<string, string>;
  httpCredentials?: { username: string; password: string; origin?: string };
  ignoreHTTPSErrors?: boolean;
  storageState?: StorageState | string;
  userAgent?: string;
}

/** Playwright's `request`: API request contexts of their own, outside any browser. */
export const request = {
  async newContext(options: NewRequestContextOptions = {}): Promise<APIRequestContext> {
    const jar = new MemoryJar();
    if (options.storageState) {
      const st: StorageState =
        typeof options.storageState === 'string'
          ? (JSON.parse(await (await import('node:fs/promises')).readFile(options.storageState, 'utf8')) as StorageState)
          : options.storageState;
      jar.load(st.cookies ?? []);
    }
    const headers: Record<string, string> = { ...(options.extraHTTPHeaders ?? {}) };
    if (options.userAgent) headers['user-agent'] = options.userAgent;
    const creds = options.httpCredentials;
    const extra = (): Record<string, string> => {
      const h = { ...headers };
      if (creds) h['authorization'] = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
      return h;
    };
    if (options.ignoreHTTPSErrors) process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    return new APIRequestContext(options.baseURL, jar, extra);
  },
};
