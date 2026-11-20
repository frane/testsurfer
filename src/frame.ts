/**
 * Frames (Playwright's Frame). The main frame stands in for the page;
 * a child frame is a same-origin iframe, addressed through a handle to
 * its <iframe> element, and its evaluate() runs in the frame's own
 * window. Cross-origin frames are not reachable from the page.
 */

import { ElementHandle, FrameLocator, JSHandle, type ByRoleOptions, type ByTextOptions, type Locator, type LocatorOptions } from './locator.ts';
import { serializeValue } from './serialize.ts';
import type { Page } from './page.ts';

export class Frame {
  private readonly owner: Page;
  /** The <iframe> element, or null for the main frame. */
  private readonly element: ElementHandle | null;
  private readonly parent: Frame | null;

  constructor(page: Page, element: ElementHandle | null, parent: Frame | null) {
    this.owner = page;
    this.element = element;
    this.parent = parent;
  }

  page(): Page {
    return this.owner;
  }

  parentFrame(): Frame | null {
    return this.parent;
  }

  /** The <iframe> element this frame lives in (null for the main frame). */
  async frameElement(): Promise<ElementHandle> {
    if (!this.element) throw new Error('frame.frameElement: the main frame has no element');
    return this.element;
  }

  isDetached(): boolean {
    return false;
  }

  /** The frame's `name` attribute ('' for the main frame). */
  name(): string {
    return this.frameName;
  }

  /** @internal Set by Page.frames(). */
  frameName = '';

  /** @internal Last URL seen by Page.frames(); url() reads it live. */
  frameUrl = '';

  async url(): Promise<string> {
    if (!this.element) return this.owner.url();
    return this.evaluate<string>('location.href');
  }

  async title(): Promise<string> {
    return this.evaluate<string>('document.title');
  }

  async content(): Promise<string> {
    return this.evaluate<string>('"<!DOCTYPE html>" + document.documentElement.outerHTML');
  }

  /** Frames nested directly inside this one. */
  childFrames(): Frame[] {
    const all = this.owner.frames();
    return all.filter((f) => f.parent === this || (f.parent && this.same(f.parent)));
  }

  private same(other: Frame): boolean {
    return (this.element?.handleId ?? null) === (other.element?.handleId ?? null);
  }

  private scope(): FrameLocator | Page {
    return this.element ? new FrameLocator(this.element as unknown as Locator) : this.owner;
  }

  locator(selector: string, options?: LocatorOptions): Locator {
    return this.scope().locator(selector, options);
  }
  getByRole(role: string, options?: ByRoleOptions): Locator {
    return this.scope().getByRole(role, options);
  }
  getByText(text: string | RegExp, options?: ByTextOptions): Locator {
    return this.scope().getByText(text, options);
  }
  getByLabel(text: string | RegExp, options?: ByTextOptions): Locator {
    return this.scope().getByLabel(text, options);
  }
  getByTestId(id: string | RegExp): Locator {
    return this.scope().getByTestId(id);
  }
  getByPlaceholder(text: string | RegExp, options?: ByTextOptions): Locator {
    return this.scope().getByPlaceholder(text, options);
  }
  getByAltText(text: string | RegExp, options?: ByTextOptions): Locator {
    return this.scope().getByAltText(text, options);
  }
  getByTitle(text: string | RegExp, options?: ByTextOptions): Locator {
    return this.scope().getByTitle(text, options);
  }
  frameLocator(selector: string): FrameLocator {
    return this.scope().frameLocator(selector);
  }

  /** The expression that yields this frame's window in the page. */
  private win(): string {
    return this.element ? `E.h(${this.element.handleId}).contentWindow` : 'window';
  }

  /** Evaluate `fn(arg)` (or an expression) inside this frame's window. */
  async evaluate<T = unknown, A = unknown>(fn: string | ((arg: A) => unknown), arg?: A): Promise<T> {
    if (!this.element) return this.owner.evaluate<T, A>(fn, arg);
    return (await this.owner.engineCall(this.callIn(fn, arg))) as T;
  }

  async evaluateHandle<A = unknown>(fn: string | ((arg: A) => unknown), arg?: A): Promise<JSHandle> {
    if (!this.element) return this.owner.evaluateHandle(fn, arg);
    return this.owner.adoptResult(this.callIn(fn, arg));
  }

  private callIn<A>(fn: string | ((arg: A) => unknown), arg?: A): string {
    const src = typeof fn === 'function' ? fn.toString() : fn;
    const a = JSON.stringify(serializeValue(arg));
    return `(function(){var w=${this.win()};var v=w.eval(${JSON.stringify(`(${src})`)});return typeof v==='function'?v(E.des(${a})):v;})()`;
  }

  async $(selector: string): Promise<ElementHandle | null> {
    return this.locator(selector).firstHandle();
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    return this.locator(selector).elementHandles();
  }

  async $eval<R, A = unknown>(selector: string, fn: string | ((el: any, arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    const h = await this.$(selector);
    if (!h) throw new Error(`frame.$eval: Error: failed to find element matching selector "${selector}"`);
    return h.evaluate(fn, arg);
  }

  async $$eval<R, A = unknown>(selector: string, fn: string | ((els: any[], arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    return this.locator(selector).evaluateAll(fn, arg);
  }

  async waitForSelector(
    selector: string,
    options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {},
  ): Promise<ElementHandle | null> {
    const l = this.locator(selector).first();
    await l.waitFor(options);
    return options.state === 'detached' || options.state === 'hidden' ? null : l.firstHandle();
  }

  async waitForFunction<T = unknown, A = unknown>(
    fn: string | ((arg: A) => unknown),
    arg?: A,
    options: { timeout?: number; polling?: number | 'raf' } = {},
  ): Promise<T> {
    if (!this.element) return this.owner.waitForFunction<T, A>(fn, arg, options);
    const budget = options.timeout ?? this.owner.timeouts.action;
    const deadline = Date.now() + budget;
    for (;;) {
      const v = await this.evaluate<T, A>(fn, arg);
      if (v) return v;
      if (Date.now() >= deadline) throw new Error(`frame.waitForFunction: Timeout ${budget}ms exceeded.`);
      await new Promise((r) => setTimeout(r, typeof options.polling === 'number' ? options.polling : 16));
    }
  }

  // Main-frame navigation and content go through the page.
  async goto(url: string): Promise<void> {
    if (this.element) {
      await this.evaluate(`(location.href = ${JSON.stringify(url)}, 0)`);
      return;
    }
    await this.owner.goto(url);
  }

  async setContent(html: string): Promise<void> {
    if (this.element) {
      await this.evaluate(`(document.open(), document.write(${JSON.stringify(html)}), document.close(), 0)`);
      return;
    }
    await this.owner.setContent(html);
  }

  async waitForLoadState(): Promise<void> {}

  // Selector shorthands, as on Page.
  click(selector: string, options?: Parameters<Locator['click']>[0]): Promise<void> {
    return this.locator(selector).click(options);
  }
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void> {
    return this.locator(selector).fill(value, options);
  }
  textContent(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.locator(selector).textContent(options);
  }
  innerText(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.locator(selector).innerText(options);
  }
  innerHTML(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.locator(selector).innerHTML(options);
  }
  getAttribute(selector: string, name: string, options?: { timeout?: number }): Promise<string | null> {
    return this.locator(selector).getAttribute(name, options);
  }
  isVisible(selector: string): Promise<boolean> {
    return this.locator(selector).isVisible();
  }
}
