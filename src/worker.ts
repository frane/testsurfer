/**
 * Web workers (Playwright's Worker). The page's Worker constructor is
 * wrapped at document start so each worker is reported; the proxy puts
 * a listener in front of worker scripts that evaluates code on request,
 * which worker.evaluate() sends through the page.
 */

import { EventEmitter } from 'node:events';

export const WORKER_SHIM = String.raw`(function () {
  var ts = window.__ts;
  var OW = window.Worker;
  if (!ts || !OW || ts.workerHooked) return;
  ts.workerHooked = true;
  var emit = function (e) { if (ts.ev.length < 2000) ts.ev.push(e); };
  var seq = 0, rseq = 0;
  ts.workers = {};
  function W(url, opts) {
    if (!(this instanceof W)) throw new TypeError("Failed to construct 'Worker': Please use the 'new' operator");
    var w = opts === undefined ? new OW(url) : new OW(url, opts);
    var id = ++seq;
    var rec = { w: w, pending: {} };
    ts.workers[id] = rec;
    w.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || typeof d !== 'object' || d.__tsEvalResult === undefined) return;
      e.stopImmediatePropagation();
      var p = rec.pending[d.__tsEvalResult];
      delete rec.pending[d.__tsEvalResult];
      if (p) d.e !== undefined ? p.reject(new Error(d.e)) : p.resolve(d.v);
    });
    var terminate = w.terminate;
    w.terminate = function () { emit({ t: 'workerClose', id: id }); delete ts.workers[id]; return terminate.call(w); };
    emit({ t: 'worker', id: id, url: new URL(url, location.href).href });
    return w;
  }
  W.prototype = OW.prototype;
  window.Worker = W;
  ts.workerEval = function (id, fn, arg) {
    var rec = ts.workers[id];
    if (!rec) return Promise.reject(new Error('Target closed'));
    var r = ++rseq;
    return new Promise(function (resolve, reject) {
      rec.pending[r] = { resolve: resolve, reject: reject };
      rec.w.postMessage({ __tsEval: r, fn: fn, arg: arg });
    });
  };
})();`;

/** What a Worker needs from its page. */
export interface WorkerPage {
  evaluate<T = unknown>(fn: string, arg?: unknown): Promise<T>;
}

export class Worker extends EventEmitter {
  private readonly page: WorkerPage;
  private readonly id: number;
  private readonly address: string;

  /** @internal */
  constructor(page: WorkerPage, id: number, url: string) {
    super();
    this.page = page;
    this.id = id;
    this.address = url;
  }

  url(): string {
    return this.address;
  }

  /** Run `fn` inside the worker and return its (structured-cloneable) result. */
  async evaluate<T = unknown, A = unknown>(fn: string | ((arg: A) => unknown), arg?: A): Promise<T> {
    const src = typeof fn === 'function' ? fn.toString() : /^\s*(async\s*)?(\(|function\b|[\w$]+\s*=>)/.test(fn) ? fn : `() => (${fn})`;
    const v = await this.page.evaluate<unknown>(
      `([id, fn, arg]) => window.__ts.workerEval(id, fn, arg)`,
      [this.id, src, arg],
    );
    return v as T;
  }

  /** @internal */
  closed(): void {
    this.emit('close', this);
  }
}

