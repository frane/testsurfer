/**
 * Frames (Playwright's Frame). The main frame stands in for the page;
 * a child frame is a same-origin iframe, addressed through a handle to
 * its <iframe> element, and its evaluate() runs in the frame's own
 * window. A cross-origin frame is reached by URL through vibesurfer
 * (`vs inspect eval --frame`), since the page itself cannot.
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

  /** @internal The handle id of the <iframe> element (-1 for the main frame). */
  elementId(): number {
    return this.element?.handleId ?? -1;
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

  /** @internal A cross-origin frame: the page cannot reach into it, so evaluate() goes through vibesurfer by URL. */
  crossOrigin = false;

  /** The frame's URL: the page's for the main frame, else as of the last frame listing. */
  url(): string {
    if (!this.element) return this.owner.url();
    return this.frameUrl;
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
    if (this.crossOrigin) return this.owner.evaluateInFrame<T, A>(this.frameUrl, fn, arg);
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
  ): Promise<JSHandle & { jsonValue(): Promise<T> }> {
    if (!this.element) return this.owner.waitForFunction<T, A>(fn, arg, options);
    const budget = options.timeout ?? this.owner.timeouts.action;
    const deadline = Date.now() + budget;
    for (;;) {
      const v = await this.evaluate<T, A>(fn, arg);
      if (v) return (await this.evaluateHandle(fn, arg)) as JSHandle & { jsonValue(): Promise<T> };
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
  isHidden(selector: string): Promise<boolean> {
    return this.locator(selector).isHidden();
  }
  isChecked(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.locator(selector).isChecked(options);
  }
  isDisabled(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.locator(selector).isDisabled(options);
  }
  isEditable(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.locator(selector).isEditable(options);
  }
  isEnabled(selector: string, options?: { timeout?: number }): Promise<boolean> {
    return this.locator(selector).isEnabled(options);
  }
  inputValue(selector: string, options?: { timeout?: number }): Promise<string> {
    return this.locator(selector).inputValue(options);
  }
  check(selector: string, options?: Parameters<Locator['check']>[0]): Promise<void> {
    return this.locator(selector).check(options);
  }
  uncheck(selector: string, options?: Parameters<Locator['uncheck']>[0]): Promise<void> {
    return this.locator(selector).uncheck(options);
  }
  setChecked(selector: string, checked: boolean, options?: Parameters<Locator['setChecked']>[1]): Promise<void> {
    return this.locator(selector).setChecked(checked, options);
  }
  dblclick(selector: string, options?: Parameters<Locator['dblclick']>[0]): Promise<void> {
    return this.locator(selector).dblclick(options);
  }
  tap(selector: string, options?: Parameters<Locator['tap']>[0]): Promise<void> {
    return this.locator(selector).tap(options);
  }
  hover(selector: string, options?: Parameters<Locator['hover']>[0]): Promise<void> {
    return this.locator(selector).hover(options);
  }
  focus(selector: string, options?: { timeout?: number }): Promise<void> {
    return this.locator(selector).focus(options);
  }
  press(selector: string, key: string, options?: Parameters<Locator['press']>[1]): Promise<void> {
    return this.locator(selector).press(key, options);
  }
  type(selector: string, text: string, options?: Parameters<Locator['pressSequentially']>[1]): Promise<void> {
    return this.locator(selector).pressSequentially(text, options);
  }
  selectOption(selector: string, values: Parameters<Locator['selectOption']>[0], options?: Parameters<Locator['selectOption']>[1]): Promise<string[]> {
    return this.locator(selector).selectOption(values, options);
  }
  setInputFiles(selector: string, files: Parameters<Locator['setInputFiles']>[0], options?: Parameters<Locator['setInputFiles']>[1]): Promise<void> {
    return this.locator(selector).setInputFiles(files, options);
  }
  dispatchEvent(selector: string, type: string, eventInit?: Record<string, unknown>, options?: { timeout?: number }): Promise<void> {
    return this.locator(selector).dispatchEvent(type, eventInit, options);
  }
  dragAndDrop(source: string, target: string, options?: { timeout?: number }): Promise<void> {
    return this.locator(source).dragTo(this.locator(target), options);
  }
  waitForTimeout(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Add a <script> to this frame and wait for it to load; returns its element. */
  async addScriptTag(options: { url?: string; path?: string; content?: string; type?: string }): Promise<ElementHandle> {
    if (!this.element) return this.owner.addScriptTag(options);
    let content = options.content;
    if (options.path !== undefined) content = (await (await import('node:fs/promises')).readFile(options.path, 'utf8')) + `\n//# sourceURL=${options.path}`;
    return (await this.evaluateHandle(
      `(o) => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        if (o.type) s.type = o.type;
        if (o.url !== undefined) { s.src = o.url; s.onload = () => resolve(s); s.onerror = () => reject(new Error('Failed to load script at ' + o.url)); document.head.appendChild(s); }
        else { s.textContent = o.content || ''; document.head.appendChild(s); resolve(s); }
      })`,
      { url: options.url, content, type: options.type },
    )) as unknown as ElementHandle;
  }

  /** Add a <style> or stylesheet <link> to this frame and wait for it to load; returns its element. */
  async addStyleTag(options: { url?: string; path?: string; content?: string }): Promise<ElementHandle> {
    if (!this.element) return this.owner.addStyleTag(options);
    let content = options.content;
    if (options.path !== undefined) content = await (await import('node:fs/promises')).readFile(options.path, 'utf8');
    return (await this.evaluateHandle(
      `(o) => new Promise((resolve, reject) => {
        if (o.url !== undefined) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = o.url; l.onload = () => resolve(l); l.onerror = () => reject(new Error('Failed to load stylesheet at ' + o.url)); document.head.appendChild(l); }
        else { const s = document.createElement('style'); s.textContent = o.content || ''; document.head.appendChild(s); resolve(s); }
      })`,
      { url: options.url, content },
    )) as unknown as ElementHandle;
  }

  /** Wait until this frame's URL matches. */
  async waitForURL(url: string | RegExp | ((u: URL) => boolean), options: { timeout?: number } = {}): Promise<void> {
    if (!this.element) return this.owner.waitForURL(url, options);
    const test = (u: string) =>
      typeof url === 'string' ? u === url || globMatch(url, u) : url instanceof RegExp ? url.test(u) : url(new URL(u));
    const deadline = Date.now() + (options.timeout ?? 30_000);
    for (;;) {
      const u = await this.evaluate<string>('() => location.href').catch(() => '');
      if (u && test(u)) return;
      if (Date.now() > deadline) throw new Error(`frame.waitForURL: Timeout ${options.timeout ?? 30_000}ms exceeded.`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Wait for this frame's next navigation (and run `action` meanwhile). */
  async waitForNavigation(options: { url?: string | RegExp | ((u: URL) => boolean); timeout?: number } = {}): Promise<null> {
    if (!this.element) {
      await this.owner.waitForNavigation(options);
      return null;
    }
    const before = await this.evaluate<string>('() => location.href + "#" + performance.timeOrigin').catch(() => '');
    const deadline = Date.now() + (options.timeout ?? 30_000);
    for (;;) {
      const now = await this.evaluate<string>('() => location.href + "#" + performance.timeOrigin').catch(() => '');
      if (now && now !== before) {
        if (options.url) await this.waitForURL(options.url, { timeout: Math.max(0, deadline - Date.now()) });
        return null;
      }
      if (Date.now() > deadline) throw new Error(`frame.waitForNavigation: Timeout ${options.timeout ?? 30_000}ms exceeded.`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** Playwright's URL glob: `**` any characters, `*` any but `/`, `?` one. */
function globMatch(glob: string, url: string): boolean {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(url);
}
