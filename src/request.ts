/**
 * page.request / context.request: HTTP calls from the test process
 * (Playwright's APIRequestContext). Requests go out through Node's
 * fetch, not the browser, so they do not share the page's cookies.
 */

import { APIResponse } from './events.ts';

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

  constructor(baseURL?: string) {
    this.baseURL = baseURL;
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
    const init: RequestInit = {
      method: options.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      redirect: options.maxRedirects === 0 ? 'manual' : 'follow',
      signal: AbortSignal.timeout(options.timeout ?? 30_000),
    };
    if (body !== undefined) init.body = body;
    const res = await fetch(url, init);
    const out = new APIResponse({
      url: res.url || url.href,
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
}
