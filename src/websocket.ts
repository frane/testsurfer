/**
 * WebSockets: page.on('websocket') and page.routeWebSocket().
 *
 * The page's WebSocket constructor is wrapped at document start. A
 * socket nobody routes is the real one, with its frames reported
 * through the shim queue. While routes exist, a new socket is a stand-in
 * the test drives (WebSocketRoute): it opens at once, what the page
 * sends goes to the route, and connectToServer() opens the real socket
 * behind it, forwarding both ways unless a handler takes the messages.
 */

import { EventEmitter } from 'node:events';

export const WS_SHIM = String.raw`(function () {
  var ts = window.__ts;
  var OWS = window.WebSocket;
  if (!ts || !OWS || ts.wsHooked) return;
  ts.wsHooked = true;
  var emit = function (e) { if (ts.ev.length < 2000) ts.ev.push(e); };
  var enc = function (d) {
    if (typeof d === 'string') return { s: d };
    try {
      var u = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
      if (u) { var b = ''; for (var i = 0; i < u.length; i++) b += String.fromCharCode(u[i]); return { b: btoa(b) }; }
    } catch (e) {}
    return { s: String(d) };
  };
  var dec = function (d, binaryType) {
    if (d.s !== undefined) return d.s;
    var bin = atob(d.b), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return binaryType === 'arraybuffer' ? u.buffer : new Blob([u]);
  };
  var seq = 0;
  ts.ws = {};
  ts.wsRouting = false;
  var watch = function (id, url, real) {
    var send = real.send;
    real.send = function (d) { emit({ t: 'wsSent', id: id, d: enc(d) }); return send.call(real, d); };
    real.addEventListener('message', function (e) {
      if (typeof e.data === 'string' || e.data instanceof ArrayBuffer) emit({ t: 'wsRecv', id: id, d: enc(e.data) });
      else if (e.data && e.data.arrayBuffer) e.data.arrayBuffer().then(function (b) { emit({ t: 'wsRecv', id: id, d: enc(b) }); });
    });
    real.addEventListener('close', function (e) { emit({ t: 'wsClose', id: id, code: e.code, reason: e.reason }); });
    real.addEventListener('error', function () { emit({ t: 'wsError', id: id }); });
  };
  function Fake(url, protocols) {
    var t = new EventTarget();
    t.url = url; t.protocol = ''; t.extensions = ''; t.bufferedAmount = 0; t.binaryType = 'blob'; t.readyState = 0;
    t.CONNECTING = 0; t.OPEN = 1; t.CLOSING = 2; t.CLOSED = 3;
    ['open', 'message', 'close', 'error'].forEach(function (n) {
      var h = null;
      Object.defineProperty(t, 'on' + n, {
        get: function () { return h; },
        set: function (f) { if (h) t.removeEventListener(n, h); h = f; if (f) t.addEventListener(n, f); }
      });
    });
    return t;
  }
  function W(url, protocols) {
    if (!(this instanceof W)) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator");
    var abs = new URL(url, location.href).href.replace(/^http/, 'ws');
    var id = ++seq;
    if (!ts.wsRouting) {
      var real = protocols === undefined ? new OWS(url) : new OWS(url, protocols);
      emit({ t: 'ws', id: id, url: abs });
      watch(id, abs, real);
      return real;
    }
    var fake = Fake(abs, protocols);
    fake.send = function (d) {
      if (fake.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
      emit({ t: 'wsPageSend', id: id, d: enc(d) });
    };
    fake.close = function (code, reason) {
      if (fake.readyState >= 2) return;
      fake.readyState = 2;
      emit({ t: 'wsPageClose', id: id, code: code, reason: reason });
    };
    ts.ws[id] = { fake: fake, server: null, url: abs, protocols: protocols };
    emit({ t: 'wsRouted', id: id, url: abs });
    return fake;
  }
  W.prototype = OWS.prototype;
  W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3;
  Object.defineProperty(W, Symbol.hasInstance, { value: function (o) { return o instanceof OWS || !!(o && o.CONNECTING === 0 && o.send && o.readyState !== undefined && o instanceof EventTarget); } });
  window.WebSocket = W;
  ts.wsOpen = function (id) {
    var s = ts.ws[id]; if (!s || s.fake.readyState !== 0) return;
    s.fake.readyState = 1; s.fake.dispatchEvent(new Event('open'));
  };
  ts.wsDeliver = function (id, d) {
    var s = ts.ws[id]; if (!s || s.fake.readyState !== 1) return;
    s.fake.dispatchEvent(new MessageEvent('message', { data: dec(d, s.fake.binaryType) }));
  };
  ts.wsCloseFake = function (id, code, reason) {
    var s = ts.ws[id]; if (!s || s.fake.readyState === 3) return;
    s.fake.readyState = 3; s.fake.dispatchEvent(new CloseEvent('close', { code: code || 1000, reason: reason || '', wasClean: true }));
  };
  ts.wsConnect = function (id) {
    var s = ts.ws[id]; if (!s || s.server) return;
    var real = s.protocols === undefined ? new OWS(s.url) : new OWS(s.url, s.protocols);
    real.binaryType = 'arraybuffer';
    s.server = real;
    s.queue = [];
    real.addEventListener('open', function () { emit({ t: 'wsServerOpen', id: id }); var q = s.queue; s.queue = null; q.forEach(function (d) { real.send(dec(d, 'arraybuffer')); }); });
    real.addEventListener('message', function (e) { emit({ t: 'wsServerMsg', id: id, d: enc(e.data) }); });
    real.addEventListener('close', function (e) { emit({ t: 'wsServerClose', id: id, code: e.code, reason: e.reason }); });
    real.addEventListener('error', function () { emit({ t: 'wsServerError', id: id }); });
  };
  ts.wsServerSend = function (id, d) {
    var s = ts.ws[id]; if (!s || !s.server) return;
    if (s.queue) s.queue.push(d); else s.server.send(dec(d, 'arraybuffer'));
  };
  ts.wsServerClose = function (id, code, reason) {
    var s = ts.ws[id]; if (s && s.server) s.server.close(code, reason);
  };
})();`;

export interface WireFrame {
  s?: string;
  b?: string;
}

const payload = (d: WireFrame | undefined): string | Buffer => (d?.b !== undefined ? Buffer.from(d.b, 'base64') : (d?.s ?? ''));
const wire = (m: string | Buffer): WireFrame => (typeof m === 'string' ? { s: m } : { b: Buffer.from(m).toString('base64') });

/** A page's WebSocket as Playwright reports it. */
export class WebSocket extends EventEmitter {
  private readonly address: string;
  private closed = false;

  /** Frames that came before anyone listened for them, delivered to the first listener. */
  private readonly held = new Map<string, unknown[]>();

  constructor(url: string) {
    super();
    this.address = url;
    this.on('newListener', (event: string) => {
      const q = this.held.get(event);
      if (!q) return;
      this.held.delete(event);
      setImmediate(() => {
        for (const arg of q) this.emit(event, arg);
      });
    });
  }

  private deliver(event: string, arg: unknown): void {
    if (this.listenerCount(event) > 0) this.emit(event, arg);
    else {
      const q = this.held.get(event) ?? [];
      q.push(arg);
      this.held.set(event, q);
    }
  }

  url(): string {
    return this.address;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** @internal */
  frame(kind: 'framesent' | 'framereceived', d: WireFrame | undefined): void {
    this.deliver(kind, { payload: payload(d) });
  }

  /** @internal */
  ended(error: boolean): void {
    if (error) this.deliver('socketerror', 'WebSocket error');
    if (this.closed) return;
    this.closed = true;
    this.deliver('close', this);
  }

  waitForEvent(event: string, options: { predicate?: (arg: any) => boolean | Promise<boolean>; timeout?: number } | ((arg: any) => boolean) = {}): Promise<any> {
    const opts = typeof options === 'function' ? { predicate: options } : options;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, fn);
        reject(new Error(`webSocket.waitForEvent: Timeout ${opts.timeout ?? 30_000}ms exceeded while waiting for event "${event}"`));
      }, opts.timeout ?? 30_000);
      const fn = (arg: unknown) => {
        void Promise.resolve(opts.predicate ? opts.predicate(arg) : true).then((ok) => {
          if (!ok) return;
          clearTimeout(timer);
          this.off(event, fn);
          resolve(arg);
        });
      };
      this.on(event, fn);
    });
  }
}

/** What a WebSocketRoute needs from its page. */
export interface WsPage {
  /** Run a `window.__ts` WebSocket call in the page. */
  wsCall(fn: string, ...args: unknown[]): Promise<void>;
}

type MessageHandler = (message: string | Buffer) => unknown;
type CloseHandler = (code: number | undefined, reason: string | undefined) => unknown;

/** One routed socket (Playwright's WebSocketRoute): the page's side, or with connectToServer() the server's. */
export class WebSocketRoute {
  private readonly page: WsPage;
  private readonly id: number;
  private readonly address: string;
  private readonly serverSide: boolean;
  /** @internal */ messageHandler: MessageHandler | null = null;
  /** @internal */ closeHandler: CloseHandler | null = null;
  /** @internal */ server: WebSocketRoute | null = null;
  /** @internal */ peer: WebSocketRoute | null = null;

  /** @internal */
  constructor(page: WsPage, id: number, url: string, serverSide: boolean) {
    this.page = page;
    this.id = id;
    this.address = url;
    this.serverSide = serverSide;
  }

  url(): string {
    return this.address;
  }

  /** Send a message to the page (or, on the server side, to the server). */
  async send(message: string | Buffer): Promise<void> {
    await this.page.wsCall(this.serverSide ? 'wsServerSend' : 'wsDeliver', this.id, wire(message));
  }

  /** Close the page's socket (or the server connection). */
  async close(options: { code?: number; reason?: string } = {}): Promise<void> {
    await this.page.wsCall(this.serverSide ? 'wsServerClose' : 'wsCloseFake', this.id, options.code ?? 1000, options.reason ?? '');
  }

  /** Take the messages this side receives, instead of forwarding them. */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Called when this side closes, instead of closing the other side. */
  onClose(handler: CloseHandler): void {
    this.closeHandler = handler;
  }

  /** Open the real connection behind the page's socket; returns its side. */
  connectToServer(): WebSocketRoute {
    if (this.serverSide) throw new Error('connectToServer must be called on the page side');
    if (this.server) return this.server;
    const s = new WebSocketRoute(this.page, this.id, this.address, true);
    s.peer = this;
    this.server = s;
    void this.page.wsCall('wsConnect', this.id);
    return s;
  }

  /** @internal What the page sent. */
  async fromPage(d: WireFrame | undefined): Promise<void> {
    const m = payload(d);
    if (this.messageHandler) await this.messageHandler(m);
    else if (this.server) await this.server.send(m);
  }

  /** @internal What the server sent. */
  async fromServer(d: WireFrame | undefined): Promise<void> {
    const m = payload(d);
    if (this.server?.messageHandler) await this.server.messageHandler(m);
    else await this.send(m);
  }

  /** @internal The page closed its socket. */
  async pageClosed(code: number | undefined, reason: string | undefined): Promise<void> {
    if (this.closeHandler) await this.closeHandler(code, reason);
    else if (this.server) await this.server.close({ ...(code ? { code } : {}), ...(reason ? { reason } : {}) });
    await this.page.wsCall('wsCloseFake', this.id, code ?? 1000, reason ?? '');
  }

  /** @internal The server closed the connection. */
  async serverClosed(code: number | undefined, reason: string | undefined): Promise<void> {
    if (this.server?.closeHandler) await this.server.closeHandler(code, reason);
    else await this.close({ ...(code ? { code } : {}), ...(reason ? { reason } : {}) });
  }
}
