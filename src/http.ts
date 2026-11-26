/** The HTTP objects page events hand out: Request, Response and the APIResponse a route fetched. */

import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

interface RequestInfo {
  id: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  /** fetch, xhr, document, script, stylesheet, image, font, media, websocket, manifest or other. */
  type: string;
  /** The main-frame or iframe navigation (proxy mode). */
  navigation?: boolean;
  frame?: 'main' | 'sub';
  /** Headers in their original case and order, as sent (proxy mode). */
  raw?: { name: string; value: string }[];
  /** The request body's bytes (proxy mode). */
  bodyBytes?: Buffer | null;
}

/** A fetch or XHR the page made. */
export class Request {
  private readonly info: RequestInfo;
  /** Set once the response (or failure) arrives. */
  responseValue: Response | null = null;
  /** The frame that made the request. */
  frameValue: unknown = null;
  /** Redirect chain, when the proxy saw a 3xx before this request. */
  redirectedFromValue: Request | null = null;
  redirectedToValue: Request | null = null;
  /** The route aborted it. */
  abortedByRoute = false;
  /** Proxy mode: the page's service worker handed it on; its response is fromServiceWorker(). */
  viaServiceWorker = false;

  frame(): any {
    // Resolved on first use: an iframe's frame may not be listed yet when its request starts.
    if (typeof this.frameValue === 'function') {
      const f = (this.frameValue as () => unknown)();
      if (f) this.frameValue = f;
      return f;
    }
    return this.frameValue;
  }
  failureText: string | null = null;

  constructor(info: RequestInfo) {
    this.info = info;
  }
  /** The shim's id for this request. */
  get id(): number {
    return this.info.id;
  }
  url(): string {
    return this.info.url;
  }
  method(): string {
    return this.info.method;
  }
  headers(): Record<string, string> {
    return { ...this.info.headers };
  }
  /** @internal setExtraHTTPHeaders() values join the request's headers. */
  addHeader(name: string, value: string): void {
    this.info.headers[name.toLowerCase()] = value;
  }
  postData(): string | null {
    return this.info.body;
  }
  postDataJSON(): unknown {
    if (this.info.body === null) return null;
    const type = this.info.headers['content-type'] ?? '';
    // A form body parses as name/value pairs, as in Playwright.
    if (type.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(this.info.body));
    }
    return JSON.parse(this.info.body);
  }
  /** `fetch`, `xhr`, or `document` for the main-frame navigation goto() returns. */
  resourceType(): string {
    return this.info.type;
  }
  isNavigationRequest(): boolean {
    return this.info.navigation ?? this.info.type === 'document';
  }
  /** `main` or `sub` (an iframe), as far as the proxy can tell. */
  frameKind(): 'main' | 'sub' {
    return this.info.frame ?? 'main';
  }
  headersArray(): { name: string; value: string }[] {
    if (this.info.raw) return this.info.raw.map((h) => ({ ...h }));
    return Object.entries(this.info.headers).map(([name, value]) => ({ name, value }));
  }
  redirectedFrom(): Request | null {
    return this.redirectedFromValue;
  }
  redirectedTo(): Request | null {
    return this.redirectedToValue;
  }
  timing(): Record<string, number> {
    return { startTime: 0, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, secureConnectionStart: -1, connectEnd: -1, requestStart: -1, responseStart: -1, responseEnd: -1 };
  }
  async allHeaders(): Promise<Record<string, string>> {
    return this.headers();
  }
  async headerValue(name: string): Promise<string | null> {
    return this.info.headers[name.toLowerCase()] ?? null;
  }
  /** The response, when it has arrived (no waiting). */
  existingResponse(): Response | null {
    return this.responseValue;
  }
  async sizes(): Promise<{ requestBodySize: number; requestHeadersSize: number; responseBodySize: number; responseHeadersSize: number }> {
    return { requestBodySize: this.postDataBuffer()?.length ?? 0, requestHeadersSize: -1, responseBodySize: -1, responseHeadersSize: -1 };
  }
  serviceWorker(): null {
    return null;
  }
  postDataBuffer(): Buffer | null {
    if (this.info.bodyBytes !== undefined) return this.info.bodyBytes;
    return this.info.body === null ? null : Buffer.from(this.info.body);
  }
  failure(): { errorText: string } | null {
    return this.failureText === null ? null : { errorText: this.failureText };
  }
  /** Proxy mode: response() waits for the response or the failure. */
  awaitsResponse = false;
  private settled = false;
  private waiters: (() => void)[] = [];

  /** @internal The response arrived, or the request failed or finished. */
  markSettled(): void {
    this.settled = true;
    for (const w of this.waiters.splice(0)) w();
  }

  private resolveDone: () => void = () => {};
  /** @internal Resolves when the whole response body has arrived (or the request failed). */
  readonly done: Promise<void> = new Promise((r) => (this.resolveDone = r));
  /** @internal */
  markDone(): void {
    this.resolveDone();
  }

  async response(): Promise<Response | null> {
    if (this.responseValue || this.settled || !this.awaitsResponse) return this.responseValue;
    await new Promise<void>((res) => this.waiters.push(res));
    return this.responseValue;
  }
}

/**
 * Response metadata. The body is read on demand by fetching the URL
 * again from the page (GET only), since it is not captured in flight.
 */
export class Response {
  private readonly req: Request;
  private readonly data: { url: string; status: number; statusText: string; headers: Record<string, string> };
  /** Reads the body; set by whoever built the response. */
  bodyLoader: (() => Promise<Buffer>) | null = null;
  /** Headers in their original case and order (proxy mode). */
  rawHeaders: { name: string; value: string }[] | null = null;
  constructor(req: Request, data: { url: string; status: number; statusText: string; headers: Record<string, string> }) {
    this.req = req;
    this.data = data;
  }
  headersArray(): { name: string; value: string }[] {
    if (this.rawHeaders) return this.rawHeaders.map((h) => ({ ...h }));
    return Object.entries(this.data.headers).map(([name, value]) => ({ name, value }));
  }
  async headersArrayAsync(): Promise<{ name: string; value: string }[]> {
    return this.headersArray();
  }
  async headerValues(name: string): Promise<string[]> {
    const n = name.toLowerCase();
    return this.headersArray()
      .filter((h) => h.name.toLowerCase() === n)
      .map((h) => h.value);
  }
  /** Proxy mode: the page's service worker handed the request on (see PageEvents.netViaServiceWorker). */
  viaServiceWorker = false;

  fromServiceWorker(): boolean {
    return this.viaServiceWorker;
  }
  httpVersion(): string {
    return 'HTTP/1.1';
  }
  async serverAddr(): Promise<null> {
    return null;
  }
  async securityDetails(): Promise<null> {
    return null;
  }
  async allHeaders(): Promise<Record<string, string>> {
    return this.headers();
  }
  async headerValue(name: string): Promise<string | null> {
    return this.data.headers[name.toLowerCase()] ?? null;
  }
  async body(): Promise<Buffer> {
    if (this.data.status >= 300 && this.data.status < 400 && this.data.headers['location']) {
      throw new Error('response.body: Response body is unavailable for redirect responses');
    }
    if (!this.bodyLoader) {
      throw new Error('response.body: the body of this response was not captured');
    }
    const raw = await this.bodyLoader();
    // The proxy keeps bodies as they came over the wire; the page saw them decoded.
    const enc = (this.data.headers['content-encoding'] ?? '').toLowerCase().trim();
    try {
      if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(raw);
      if (enc === 'deflate') return inflateSync(raw);
      if (enc === 'br') return brotliDecompressSync(raw);
    } catch {
      /* not actually encoded; hand back what came */
    }
    return raw;
  }
  async text(): Promise<string> {
    return (await this.body()).toString('utf8');
  }
  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
  async finished(): Promise<null> {
    return null;
  }
  frame(): unknown {
    return null;
  }
  url(): string {
    return this.data.url;
  }
  status(): number {
    return this.data.status;
  }
  statusText(): string {
    return this.data.statusText;
  }
  ok(): boolean {
    // Playwright counts status 0 (file: and data: URLs) as ok.
    return this.data.status === 0 || (this.data.status >= 200 && this.data.status < 300);
  }
  headers(): Record<string, string> {
    return { ...this.data.headers };
  }
  request(): Request {
    return this.req;
  }
}

/** The real response route.fetch() fetched, with its body. */
interface APIResponseData {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
}

export class APIResponse {
  private readonly data: APIResponseData;
  constructor(data: APIResponseData) {
    this.data = data;
  }
  url(): string {
    return this.data.url;
  }
  status(): number {
    return this.data.status;
  }
  statusText(): string {
    return this.data.statusText;
  }
  ok(): boolean {
    return this.data.status >= 200 && this.data.status < 300;
  }
  headers(): Record<string, string> {
    return { ...this.data.headers };
  }
  async body(): Promise<Buffer> {
    return this.data.body;
  }
  async text(): Promise<string> {
    return this.data.body.toString('utf8');
  }
  async json(): Promise<unknown> {
    return JSON.parse(this.data.body.toString('utf8'));
  }
}
