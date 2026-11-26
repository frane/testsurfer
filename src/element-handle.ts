/** ElementHandle: a held element, usable as a locator for it (Playwright's ElementHandle). */

import { registerElementHandle } from './element-factory.ts';
import { TimeoutError } from './errors.ts';
import type { Frame } from './frame.ts';
import { JSHandle } from './handle.ts';
import { Locator } from './locator.ts';
import type { Page } from './page.ts';
import { serializeValue } from './serialize.ts';
import { backoff } from './retry.ts';

/**
 * An element held by the test (Playwright's ElementHandle). It is a
 * locator pinned to that one element, so every locator method works on
 * it; selectors on it search inside the element.
 */
export class ElementHandle extends Locator {
  readonly handleId: number;
  readonly ownerPage: Page;

  constructor(page: Page, id: number) {
    super(page, { kind: 'handle', id });
    this.handleId = id;
    this.ownerPage = page;
  }

  asElement(): ElementHandle {
    return this;
  }

  /**
   * The frame this <iframe> element hosts. Playwright gives handles an
   * async contentFrame() returning a Frame, unlike Locator's, which
   * returns a FrameLocator; the override is deliberately incompatible.
   */
  // @ts-expect-error see above
  override async contentFrame(): Promise<Frame | null> {
    const isFrame = await this.evaluate((e: { nodeName: string }) => e.nodeName === 'IFRAME' || e.nodeName === 'FRAME');
    if (!isFrame) return null;
    const { Frame } = await import('./frame.ts');
    return new Frame(this.page(), this, this.page().mainFrame());
  }

  /** The frame the element is in (the main frame for top-level elements). */
  async ownerFrame(): Promise<Frame> {
    return this.page().mainFrame();
  }

  /** The first element matching `selector` inside this one, or null. */
  async $(selector: string): Promise<ElementHandle | null> {
    return this.locator(selector).firstHandle();
  }

  async $$(selector: string): Promise<ElementHandle[]> {
    return this.locator(selector).elementHandles();
  }

  async $eval<R, A = unknown>(selector: string, fn: string | ((el: any, arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    const r = await this.page().engineRun<{ v?: R; none?: boolean }>(
      { steps: this.locator(selector).wire(), op: 'eval', args: { arg: serializeValue(arg) }, first: true },
      fn.toString(),
    );
    if (r.none) throw new Error(`elementHandle.$eval: Error: failed to find element matching selector "${selector}"`);
    return r.v as R;
  }

  async $$eval<R, A = unknown>(selector: string, fn: string | ((els: any[], arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    return this.locator(selector).evaluateAll(fn, arg);
  }

  override async evaluateHandle<A = unknown>(fn: string | ((v: any, arg: A) => unknown), arg?: A): Promise<JSHandle> {
    return new JSHandle(this.page(), this.handleId).evaluateHandle(fn, arg);
  }

  async jsonValue<T = unknown>(): Promise<T> {
    return {} as T;
  }

  /** @internal Set when the handle came from evaluateHandle. */
  previewText = '';

  async getProperty(name: string): Promise<JSHandle> {
    return new JSHandle(this.page(), this.handleId).getProperty(name);
  }

  async getProperties(): Promise<Map<string, JSHandle>> {
    return new JSHandle(this.page(), this.handleId).getProperties();
  }

  async dispose(): Promise<void> {
    await new JSHandle(this.page(), this.handleId).dispose();
  }

  /** The element matching `selector` inside this one, once it reaches `state` (visible by default). */
  async waitForSelector(
    selector: string,
    options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {},
  ): Promise<ElementHandle | null> {
    const l = this.locator(selector).first();
    await l.waitFor(options);
    return options.state === 'detached' || options.state === 'hidden' ? null : l.firstHandle();
  }

  /** Wait for the element to be visible, hidden, stable, enabled, disabled or editable. */
  async waitForElementState(
    state: 'visible' | 'hidden' | 'stable' | 'enabled' | 'disabled' | 'editable',
    options: { timeout?: number } = {},
  ): Promise<void> {
    const budget = options.timeout ?? this.page().timeouts.action;
    const deadline = Date.now() + budget;
    for (let i = 0; ; i++) {
      let ok = true;
      if (state === 'visible') ok = await this.isVisible();
      else if (state === 'hidden') ok = !(await this.isVisible());
      else if (state === 'enabled') ok = await this.isEnabled({ timeout: budget });
      else if (state === 'disabled') ok = await this.isDisabled({ timeout: budget });
      else if (state === 'editable') ok = await this.isEditable({ timeout: budget });
      if (ok) return;
      if (Date.now() >= deadline) throw new TimeoutError(`elementHandle.waitForElementState: Timeout ${budget}ms exceeded.`);
      await backoff(i);
    }
  }

  override toString(): string {
    return 'ElementHandle';
  }
}

registerElementHandle((page, id) => new ElementHandle(page, id));
