/**
 * Playwright's Clock: fake Date, timers, animation frames and
 * performance.now in the page, driven from the test. The page side is a
 * document-start script; each call is applied to the current document
 * and recorded, so later documents start from the clock's state.
 */

const CLOCK_JS = String.raw`function (op) {
  var w = self;
  if (!w.__tsClock) {
    var real = {
      Date: w.Date, setTimeout: w.setTimeout.bind(w), clearTimeout: w.clearTimeout.bind(w),
      setInterval: w.setInterval.bind(w), clearInterval: w.clearInterval.bind(w),
      raf: w.requestAnimationFrame && w.requestAnimationFrame.bind(w), caf: w.cancelAnimationFrame && w.cancelAnimationFrame.bind(w),
      ric: w.requestIdleCallback && w.requestIdleCallback.bind(w), cic: w.cancelIdleCallback && w.cancelIdleCallback.bind(w),
      perf: performance.now.bind(performance)
    };
    var st = { installed: false, fixed: null, now: real.Date.now(), paused: false, last: real.perf(), timers: new Map(), seq: 1, wake: null, origin: real.Date.now() - real.perf() };
    var current = function () {
      if (st.installed && !st.paused) { var r = real.perf(); st.now += r - st.last; st.last = r; }
      return st.installed ? st.now : real.Date.now();
    };
    var dateNow = function () { return st.fixed !== null ? st.fixed : current(); };
    var D = function (a, b, c, d, e, f, g) {
      var n = arguments.length;
      if (!(this instanceof D)) return new real.Date(dateNow()).toString();
      return n === 0 ? new real.Date(dateNow()) : n === 1 ? new real.Date(a) : new real.Date(a, b, c === undefined ? 1 : c, d || 0, e || 0, f || 0, g || 0);
    };
    D.prototype = real.Date.prototype;
    D.now = dateNow;
    D.parse = real.Date.parse;
    D.UTC = real.Date.UTC;
    var fireDue = function (until, once) {
      var fired = new Set();
      for (;;) {
        var next = null;
        st.timers.forEach(function (t) { if (t.at <= until && !(once && fired.has(t.id)) && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t; });
        if (!next) break;
        fired.add(next.id);
        st.now = Math.max(st.now, next.at);
        if (next.every !== null) next.at += Math.max(1, next.every); else st.timers.delete(next.id);
        try { next.fn.apply(w, next.args); } catch (e) { real.setTimeout(function () { throw e; }, 0); }
      }
      st.now = Math.max(st.now, until);
    };
    var arm = function () {
      if (st.wake !== null) real.clearTimeout(st.wake);
      st.wake = null;
      if (!st.installed || st.paused) return;
      var soonest = Infinity;
      st.timers.forEach(function (t) { soonest = Math.min(soonest, t.at); });
      if (soonest === Infinity) return;
      st.wake = real.setTimeout(function () { st.wake = null; fireDue(current(), false); arm(); }, Math.max(0, soonest - current()));
    };
    var add = function (fn, delay, args, every) {
      if (typeof fn !== 'function') fn = new Function(String(fn));
      var id = st.seq++;
      var d = Math.max(0, Number(delay) || 0);
      st.timers.set(id, { id: id, at: current() + d, fn: fn, args: args, every: every ? d : null });
      arm();
      return id;
    };
    var clear = function (id) { st.timers.delete(id); arm(); };
    var install = function () {
      if (st.installed) return;
      st.installed = true;
      st.last = real.perf();
      w.Date = D;
      w.setTimeout = function (fn, d) { return add(fn, d, [].slice.call(arguments, 2), false); };
      w.setInterval = function (fn, d) { return add(fn, d, [].slice.call(arguments, 2), true); };
      w.clearTimeout = clear;
      w.clearInterval = clear;
      if (real.raf) w.requestAnimationFrame = function (fn) { return add(function () { fn(current() - st.origin); }, 16, [], false); };
      if (real.caf) w.cancelAnimationFrame = clear;
      if (real.ric) w.requestIdleCallback = function (fn) { return add(function () { fn({ didTimeout: false, timeRemaining: function () { return 50; } }); }, 1, [], false); };
      if (real.cic) w.cancelIdleCallback = clear;
      performance.now = function () { return current() - st.origin; };
    };
    w.__tsClock = function (o) {
      if (o.kind === 'fixed') { st.fixed = o.time; if (!st.installed) w.Date = D; return; }
      if (o.kind === 'install') { st.now = o.time === undefined ? real.Date.now() : o.time; install(); }
      if (o.kind === 'system') { current(); st.now = o.time; if (!st.installed) { st.fixed = o.time; w.Date = D; } }
      if (o.kind === 'fastForward') { current(); fireDue(st.now + o.ms, true); }
      if (o.kind === 'runFor') { current(); fireDue(st.now + o.ms, false); }
      if (o.kind === 'pauseAt') { current(); if (o.time > st.now) fireDue(o.time, false); st.now = o.time; st.paused = true; }
      if (o.kind === 'resume') { st.paused = false; st.last = real.perf(); }
      if (o.kind === 'paused') { st.now = o.time; st.paused = o.paused; st.last = real.perf(); }
      arm();
    };
  }
  w.__tsClock(op);
}`;

type Op =
  | { kind: 'install'; time?: number }
  | { kind: 'fixed'; time: number }
  | { kind: 'system'; time: number }
  | { kind: 'fastForward'; ms: number }
  | { kind: 'runFor'; ms: number }
  | { kind: 'pauseAt'; time: number }
  | { kind: 'resume' }
  | { kind: 'paused'; time: number; paused: boolean };

/** What the clock needs from its page (or every page of a context). */
export interface ClockHost {
  /** Run a script in the current document(s). */
  evaluate(script: string): Promise<unknown>;
  /** Add a document-start script for later documents. */
  addInitScript(script: string): Promise<void>;
}

const toMs = (t: number | string | Date): number => (t instanceof Date ? t.getTime() : typeof t === 'string' ? Date.parse(t) : t);
/** `"01:00"`, `"30:00"`, `"02:34:10"` or a number of ms. */
const ticks = (t: number | string): number => {
  if (typeof t === 'number') return t;
  const parts = t.split(':').map(Number);
  let ms = 0;
  for (const p of parts) ms = ms * 60 + p;
  return ms * 1000;
};

export class Clock {
  private readonly host: ClockHost;
  private installed = false;

  constructor(host: ClockHost) {
    this.host = host;
  }

  private async run(op: Op, persist: boolean): Promise<void> {
    const src = `(${CLOCK_JS})(${JSON.stringify(op)});`;
    if (persist) await this.host.addInitScript(src);
    await this.host.evaluate(src);
  }

  /** Fake Date, timers, animation frames and performance.now, starting at `time` (now by default). */
  async install(options: { time?: number | string | Date } = {}): Promise<void> {
    this.installed = true;
    await this.run({ kind: 'install', ...(options.time === undefined ? {} : { time: toMs(options.time) }) }, true);
  }

  /** Jump ahead, firing each due timer at most once. */
  async fastForward(t: number | string): Promise<void> {
    await this.run({ kind: 'fastForward', ms: ticks(t) }, false);
  }

  /** Advance, firing every timer that comes due on the way. */
  async runFor(t: number | string): Promise<void> {
    await this.run({ kind: 'runFor', ms: ticks(t) }, false);
  }

  /** Advance to `time`, firing timers on the way, and stop the clock there. */
  async pauseAt(time: number | string | Date): Promise<void> {
    if (!this.installed) await this.install();
    await this.run({ kind: 'pauseAt', time: toMs(time) }, false);
  }

  /** Let a paused clock run again. */
  async resume(): Promise<void> {
    await this.run({ kind: 'resume' }, false);
  }

  /** Date.now() and new Date() always answer `time`; timers run as usual. */
  async setFixedTime(time: number | string | Date): Promise<void> {
    await this.run({ kind: 'fixed', time: toMs(time) }, true);
  }

  /** Change the wall-clock time without firing timers. */
  async setSystemTime(time: number | string | Date): Promise<void> {
    await this.run({ kind: 'system', time: toMs(time) }, true);
  }
}
