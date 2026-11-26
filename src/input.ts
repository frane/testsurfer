/**
 * page.mouse, page.keyboard and page.touchscreen. Pointer input is
 * trusted native input through vibesurfer's cursor primitives; keys go
 * through the page engine, typing through vs_type.
 */

import type { InputMode } from './page-options.ts';

type Button = 'left' | 'right' | 'middle';

/** What the input devices need from their page. */
export interface InputHost {
  /** A vibesurfer cursor op at viewport coordinates; `mutates` ops carry the state token. */
  cursorOp(op: 'vs_move_to' | 'vs_drag' | 'vs_wheel', coords: number[], mode: InputMode | undefined, mutates: boolean): Promise<void>;
  clickAt(x: number, y: number, mode?: InputMode, opts?: { count?: number | undefined; button?: Button | undefined }): Promise<void>;
  /** The daemon has a native wheel (vibesurfer 0.2.19+). */
  nativeWheel(): boolean;
  evaluate(fn: string, arg?: unknown): Promise<unknown>;
  engineCall(body: string): Promise<unknown>;
  typeTrusted(text: string): Promise<void>;
}

/** Resolves after the page has had two animation frames to handle an event. */
const TWO_FRAMES_JS = '() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(0))))';

/**
 * A wheel event at (x, y) dispatched in the page, scrolling the nearest
 * scrollable box unless cancelled: the fallback for daemons without a
 * native wheel (before 0.2.19).
 */
const SCRIPTED_WHEEL_JS = `([x, y, dx, dy]) => new Promise((done) => {
  const t = document.elementFromPoint(x, y) || document.scrollingElement || document.body;
  const ev = new WheelEvent('wheel', { deltaX: dx, deltaY: dy, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true });
  if (t.dispatchEvent(ev)) {
    let s = t instanceof Element ? t : null;
    const scrolls = (e) => {
      const st = getComputedStyle(e);
      return (/(auto|scroll|overlay)/.test(st.overflowY) && e.scrollHeight > e.clientHeight) || (/(auto|scroll|overlay)/.test(st.overflowX) && e.scrollWidth > e.clientWidth);
    };
    while (s && s !== document.documentElement && s !== document.body && !scrolls(s)) s = s.parentElement;
    const box = s && s !== document.documentElement && s !== document.body ? s : (document.scrollingElement || document.documentElement);
    box.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  }
  requestAnimationFrame(() => requestAnimationFrame(() => done(0)));
})`;

/** touchstart and touchend at (x, y), where the page supports touch events. */
const TAP_JS = `([x, y]) => {
  const t = document.elementFromPoint(x, y) || document.body;
  if (typeof Touch === 'undefined' || typeof TouchEvent === 'undefined') return;
  const touch = new Touch({ identifier: Date.now(), target: t, clientX: x, clientY: y, pageX: x + scrollX, pageY: y + scrollY });
  const init = { bubbles: true, cancelable: true, composed: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] };
  t.dispatchEvent(new TouchEvent('touchstart', init));
  t.dispatchEvent(new TouchEvent('touchend', { ...init, touches: [], targetTouches: [] }));
}`;

/**
 * Trusted native pointer input at viewport coordinates (CSS px).
 * Every event reaches the page with isTrusted=true, so canvas apps,
 * sliders and drag-and-drop work. Cadence follows the page's input
 * mode unless a call overrides it.
 */
export class Mouse {
  private readonly host: InputHost;
  /** Where move/click last put the pointer. */
  private pointer = { x: 0, y: 0 };
  /** Where down() pressed, until up(). */
  private pressedAt: { x: number; y: number } | null = null;

  constructor(host: InputHost) {
    this.host = host;
  }

  /**
   * Move the pointer. While a button is down (down()), the move is only
   * recorded: the press, the path and the release go out as one native
   * drag at up(), so the page sees them in order.
   */
  async move(x: number, y: number, options?: { mode?: InputMode; steps?: number }): Promise<void> {
    this.pointer = { x, y };
    if (this.pressedAt) return;
    await this.host.cursorOp('vs_move_to', [x, y], options?.mode, false);
  }

  async click(x: number, y: number, options?: { mode?: InputMode; clickCount?: number; button?: Button; delay?: number }): Promise<void> {
    this.pointer = { x, y };
    await this.host.clickAt(x, y, options?.mode, { count: options?.clickCount, button: options?.button });
  }

  async dblclick(x: number, y: number, options?: { mode?: InputMode; button?: Button }): Promise<void> {
    this.pointer = { x, y };
    await this.host.clickAt(x, y, options?.mode, { count: 2, button: options?.button });
  }

  async down(): Promise<void> {
    this.pressedAt = { ...this.pointer };
  }

  async up(options?: { mode?: InputMode }): Promise<void> {
    const from = this.pressedAt;
    this.pressedAt = null;
    if (!from) return;
    const to = this.pointer;
    if (from.x === to.x && from.y === to.y) await this.host.clickAt(to.x, to.y, options?.mode);
    else await this.host.cursorOp('vs_drag', [from.x, from.y, to.x, to.y], options?.mode, true);
  }

  /**
   * Scroll by (deltaX, deltaY) at the pointer: a trusted native wheel
   * event goes to the element there and, unless the page cancels it,
   * the nearest scrollable box scrolls. Returns once the page has
   * handled it (two animation frames later).
   */
  async wheel(deltaX: number, deltaY: number, options?: { mode?: InputMode }): Promise<void> {
    const { x, y } = this.pointer;
    if (!this.host.nativeWheel()) {
      await this.host.evaluate(SCRIPTED_WHEEL_JS, [x, y, deltaX, deltaY]);
      return;
    }
    await this.host.cursorOp('vs_wheel', [x, y, deltaX, deltaY], options?.mode, false);
    await this.host.evaluate(TWO_FRAMES_JS).catch(() => {});
  }

  /** Press at (x1, y1), move along a path, release at (x2, y2). Fires the HTML5 drag events too. */
  drag(x1: number, y1: number, x2: number, y2: number, options?: { mode?: InputMode }): Promise<void> {
    return this.host.cursorOp('vs_drag', [x1, y1, x2, y2], options?.mode, true);
  }
}

/**
 * Keyboard input to the focused element. press/down/up dispatch key
 * events with the browser's default action (typing, Enter submits,
 * Backspace deletes, Tab moves focus); type() sends trusted
 * per-character input.
 */
export class Keyboard {
  private readonly host: InputHost;

  constructor(host: InputHost) {
    this.host = host;
  }

  async press(key: string, _options?: { delay?: number }): Promise<void> {
    await this.host.engineCall(`E.key(${JSON.stringify(key)})`);
  }

  async down(key: string): Promise<void> {
    await this.host.engineCall(`E.key(${JSON.stringify(key)},'down')`);
  }

  async up(key: string): Promise<void> {
    await this.host.engineCall(`E.key(${JSON.stringify(key)},'up')`);
  }

  async type(text: string, _options?: { delay?: number }): Promise<void> {
    await this.host.typeTrusted(text);
  }

  async insertText(text: string): Promise<void> {
    await this.host.engineCall(`E.insertText(${JSON.stringify(text)})`);
  }
}

/**
 * Touch input (Playwright's touchscreen). `tap` sends touchstart and
 * touchend at the point and then a trusted click there, the click a
 * browser makes of a tap.
 */
export class Touchscreen {
  private readonly host: InputHost;

  constructor(host: InputHost) {
    this.host = host;
  }

  async tap(x: number, y: number): Promise<void> {
    await this.host.evaluate(TAP_JS, [x, y]).catch(() => {});
    await this.host.clickAt(x, y);
  }
}
