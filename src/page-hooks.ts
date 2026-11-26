/**
 * What the page shim reports besides network events: WebSockets (seen
 * and routed), dedicated workers and file choosers. The Page owns one
 * PageHooks and forwards the shim's `wsEvent` rows to it.
 */

import type { PageEvents } from './events.ts';
import { FileChooser } from './filechooser.ts';
import type { ElementHandle } from './locator.ts';
import type { Page } from './page.ts';
import { urlMatches, type UrlMatcher } from './url.ts';
import { WebSocket, WebSocketRoute, type WireFrame } from './websocket.ts';
import { Worker } from './worker.ts';

/** What PageHooks needs from its page. */
export interface HooksHost {
  readonly page: Page;
  readonly events: PageEvents;
  baseURL(): string | undefined;
  /** The page has a document (a web view) to run scripts in. */
  hasDocument(): boolean;
  ensureShim(): Promise<void>;
  /** Add a document-start script for later documents. */
  addInitSource(source: string): Promise<void>;
  evaluate(fn: string, arg?: unknown): Promise<unknown>;
  evaluateHandle(fn: string): Promise<unknown>;
}

/** A shim row about a WebSocket, a worker or a file chooser. */
type HookEvent = Record<string, unknown>;

export class PageHooks {
  private readonly host: HooksHost;
  private shimPolled = false;
  private fileChooserOn = false;
  private readonly wsRoutes: { url: UrlMatcher; handler: (ws: WebSocketRoute) => unknown }[] = [];
  private readonly sockets = new Map<number, WebSocket>();
  private readonly wsRouted = new Map<number, WebSocketRoute>();
  private readonly workerList = new Map<number, Worker>();

  constructor(host: HooksHost) {
    this.host = host;
  }

  /**
   * Watch or route WebSockets. The hook itself is in every page from
   * its first document (EAGER_SHIM), so a socket opened before anyone
   * listened is still reported; this keeps the shim queue polled.
   */
  async ensureWsShim(): Promise<void> {
    if (this.shimPolled) return;
    this.shimPolled = true;
    this.host.events.on('__ws', () => {});
    await this.host.ensureShim();
    await this.host.events.sync();
  }

  /** Answer the page's WebSockets matching `url` with `handler` instead of the server. */
  async routeWebSocket(url: UrlMatcher, handler: (ws: WebSocketRoute) => unknown): Promise<void> {
    this.wsRoutes.unshift({ url, handler });
    await this.ensureWsShim();
    await this.enableInPage('window.__ts && (window.__ts.wsRouting = true);');
  }

  /** Run one window.__ts WebSocket call in the page. */
  async wsCall(fn: string, ...args: unknown[]): Promise<void> {
    if (fn === 'wsDeliver') this.sockets.get(Number(args[0]))?.frame('framereceived', args[1] as WireFrame);
    await this.host.evaluate(`(a) => window.__ts && window.__ts.${fn} && window.__ts.${fn}(...a)`, args);
  }

  /** Report file inputs as `filechooser` events instead of opening a dialog. */
  async interceptFileChooser(): Promise<void> {
    if (this.fileChooserOn) return;
    this.fileChooserOn = true;
    await this.ensureWsShim();
    await this.enableInPage('window.__ts && (window.__ts.fc = true);');
  }

  workers(): Worker[] {
    return [...this.workerList.values()];
  }

  worker(id: number): Worker | null {
    return this.workerList.get(id) ?? null;
  }

  /** Dispatch one shim row. */
  async onEvent(e: HookEvent): Promise<void> {
    const id = Number(e['id']);
    switch (e['t']) {
      case 'worker':
        return this.workerStarted(id, String(e['url']));
      case 'workerClose':
        this.workerList.get(id)?.closed();
        this.workerList.delete(id);
        return;
      case 'filechooser':
        return this.fileChooserOpened(id, !!e['multiple']);
      default:
        return this.onSocketEvent(id, e);
    }
  }

  /** Set a page flag for later documents and the current one. */
  private async enableInPage(statement: string): Promise<void> {
    await this.host.addInitSource(statement);
    if (this.host.hasDocument()) await this.host.evaluate(`() => { ${statement} }`).catch(() => {});
  }

  private workerStarted(id: number, url: string): void {
    const w = new Worker(this.host.page, id, url);
    this.workerList.set(id, w);
    this.host.events.emitPageEvent('worker', w);
  }

  private async fileChooserOpened(id: number, multiple: boolean): Promise<void> {
    const input = (await this.host.evaluateHandle(`() => window.__ts.fcEls[${id}]`)) as ElementHandle;
    this.host.events.emitPageEvent('filechooser', new FileChooser(this.host.page, input, multiple));
  }

  private async onSocketEvent(id: number, e: HookEvent): Promise<void> {
    const d = e['d'] as WireFrame | undefined;
    const code = e['code'] as number | undefined;
    const reason = e['reason'] as string | undefined;
    switch (e['t']) {
      case 'ws':
        this.socketOpened(id, String(e['url']));
        break;
      case 'wsSent':
        this.sockets.get(id)?.frame('framesent', d);
        break;
      case 'wsRecv':
        this.sockets.get(id)?.frame('framereceived', d);
        break;
      case 'wsClose':
      case 'wsError':
        this.sockets.get(id)?.ended(e['t'] === 'wsError');
        break;
      case 'wsRouted':
        await this.routedSocketOpened(id, String(e['url']));
        break;
      case 'wsPageSend':
        this.sockets.get(id)?.frame('framesent', d);
        await this.wsRouted.get(id)?.fromPage(d);
        break;
      case 'wsPageClose':
        await this.wsRouted.get(id)?.pageClosed(code, reason);
        this.sockets.get(id)?.ended(false);
        break;
      case 'wsServerMsg':
        await this.wsRouted.get(id)?.fromServer(d);
        break;
      case 'wsServerClose':
        await this.wsRouted.get(id)?.serverClosed(code, reason);
        break;
    }
  }

  private socketOpened(id: number, url: string): void {
    const ws = new WebSocket(url);
    this.sockets.set(id, ws);
    this.host.events.emitPageEvent('websocket', ws);
  }

  /** A socket the page shim holds for routing: hand it to the first matching route, else connect it through. */
  private async routedSocketOpened(id: number, url: string): Promise<void> {
    const route = new WebSocketRoute(this.host.page, id, url, false);
    this.wsRouted.set(id, route);
    this.socketOpened(id, url);
    const match = this.wsRoutes.find((r) => urlMatches(r.url, url, this.host.baseURL()));
    await this.host.page.wsCall('wsOpen', id);
    if (match) await match.handler(route);
    else route.connectToServer();
  }
}
