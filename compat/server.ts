import * as zlib from 'node:zlib';
/**
 * The subset of Playwright's TestServer (tests/config/testserver) the
 * ported specs use: static files from Playwright's tests/assets,
 * per-path routes and redirects, and waiting for a request.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
};

export class TestServer {
  PREFIX = '';
  CROSS_PROCESS_PREFIX = '';
  EMPTY_PAGE = '';
  PORT = 0;
  private server: http.Server;
  private routes = new Map<string, Handler>();
  private waiters = new Map<string, ((req: http.IncomingMessage) => void)[]>();
  private extra = new Map<string, Record<string, string>>();
  private readonly assets: string;

  constructor(assets: string) {
    this.assets = assets;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<void> {
    // All interfaces: *.localhost names resolve to ::1 in Node and 127.0.0.1 in the proxy.
    await new Promise<void>((r) => this.server.listen(0, r));
    this.PORT = (this.server.address() as AddressInfo).port;
    // Names under .localhost: macOS WebKit never sends localhost or
    // 127.0.0.1 through vibesurfer's proxy, but does send these.
    this.PREFIX = `http://compat.localhost:${this.PORT}`;
    this.CROSS_PROCESS_PREFIX = `http://cross.localhost:${this.PORT}`;
    this.EMPTY_PAGE = `${this.PREFIX}/empty.html`;
  }

  stop(): void {
    this.server.close();
    // A request a test left hanging (held by a route, never answered)
    // would otherwise keep the process alive for Node's 300 s request timeout.
    this.server.closeAllConnections();
  }

  reset(): void {
    this.routes.clear();
    this.waiters.clear();
    this.extra.clear();
  }

  setRoute(p: string, handler: Handler): void {
    this.routes.set(p, handler);
  }

  setRedirect(from: string, to: string): void {
    this.setRoute(from, (_req, res) => {
      res.writeHead(302, { location: to });
      res.end();
    });
  }

  setExtraHeaders(p: string, headers: Record<string, string>): void {
    this.extra.set(p, headers);
  }

  private gzipped = new Set<string>();

  /** Serve this path gzip-encoded, as Playwright's TestServer does. */
  enableGzip(p: string): void {
    this.gzipped.add(p);
  }


  waitForRequest(p: string): Promise<http.IncomingMessage & { postBody: Promise<Buffer> }> {
    return new Promise((resolve) => {
      const list = this.waiters.get(p) ?? [];
      list.push(resolve as (req: http.IncomingMessage) => void);
      this.waiters.set(p, list);
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    const chunks: Buffer[] = [];
    const postBody = new Promise<Buffer>((r) => {
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => r(Buffer.concat(chunks)));
    });
    Object.assign(req, { postBody });
    for (const w of this.waiters.get(pathname) ?? []) w(req);
    this.waiters.delete(pathname);
    for (const [k, v] of Object.entries(this.extra.get(pathname) ?? {})) res.setHeader(k, v);
    // Playwright's TestServer keys routes by path plus query.
    const route = this.routes.get(req.url ?? pathname) ?? this.routes.get(pathname);
    if (route) {
      route(req, res);
      return;
    }
    const file = path.join(this.assets, decodeURIComponent(pathname));
    if (!file.startsWith(this.assets) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end(`File not found: ${pathname}`);
      return;
    }
    const data = fs.readFileSync(file);
    const gzip = this.gzipped.has(pathname);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
    });
    res.end(gzip ? zlib.gzipSync(data) : data);
  }
}
