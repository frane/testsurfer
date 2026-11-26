/**
 * Locators: lazy, re-resolving element queries.
 *
 * A locator stores a chain of queries, never an element. Every action
 * and read resolves the chain again, in the page, through the engine
 * in src/injected/, so locators survive re-renders and navigation.
 * Single-element operations are strict: more than one match is an
 * error unless first(), last() or nth() picks one. Actions wait until
 * the element is attached, visible, enabled and not covered, then
 * click with trusted native input at its center.
 */

import { filesOnDisk, MIME, type DropFile } from './files.ts';
import type { ActionOptions, BoundingBox, ClickOptions, InputFile, SelectOptionValue } from './locator-options.ts';
import { newElementHandle } from './element-factory.ts';
import type { ElementHandle } from './element-handle.ts';
import { FrameLocator } from './frame-locator.ts';
import { JSHandle } from './handle.ts';
import {
  byAttr,
  describeFilter,
  describeQuery,
  selectorSteps,
  step,
  wireFilter,
  wireQuery,
  type ByRoleOptions,
  type ByTextOptions,
  type FilterOptions,
  type LocatorOptions,
  type LocatorQuery,
  type Step,
} from './query.ts';
import { StrictModeError, TimeoutError } from './errors.ts';
import { renderSnapshot } from './aria.ts';
import { serializeValue } from './serialize.ts';
import type { Snapshot } from './tree.ts';
import type { Page } from './page.ts';
import { backoff, sleep } from './retry.ts';

interface RunResult<T> {
  v?: T;
  /** Preview of the element a one-element op ran on. */
  p?: string;
  n?: number;
  none?: boolean;
  strict?: string[];
}

const isRetry = (v: unknown): v is { retry: string } =>
  typeof v === 'object' && v !== null && 'retry' in v && typeof (v as { retry: unknown }).retry === 'string';

export class Locator {
  private readonly owner: Page;
  private readonly steps: Step[];
  private readonly desc: string | undefined;

  constructor(page: Page, steps: Step[] | LocatorQuery, description?: string) {
    this.owner = page;
    this.steps = Array.isArray(steps) ? steps : [step(steps)];
    this.desc = description;
  }

  /** The owning page's expect timeout, used as the assertion default. */
  get expectTimeout(): number {
    return this.owner.timeouts.expect;
  }

  /** The page this locator belongs to. */
  page(): Page {
    return this.owner;
  }

  /** The chain in the engine's wire form. */
  wire(): unknown[] {
    return this.steps.map((s, i) => {
      if (s.capture && s.index !== null) throw new Error("Error: Can't query n-th element in a request with the capture.");
      const q = wireQuery(s.query);
      // A frame hop names its <iframe> locator in errors.
      if (s.query.kind === 'frame') q['d'] = Locator.stepsText(this.owner, this.steps.slice(0, i));
      return { q, f: s.filters.map(wireFilter), i: s.index };
    });
  }

  /** Steps up to and including the last frame hop, and the rest. */
  private frameSplit(): { prefix: Step[]; rest: Step[] } | null {
    let at = -1;
    this.steps.forEach((s, i) => {
      if (s.query.kind === 'frame') at = i;
    });
    return at < 0 ? null : { prefix: this.steps.slice(0, at + 1), rest: this.steps.slice(at + 1) };
  }

  private static stepsText(owner: Page, steps: Step[]): string {
    return new Locator(owner, steps).toString();
  }

  /**
   * and()/or(): both sides inside the same frame compose inside it;
   * frame locators on different frames cannot be combined.
   */
  private composite(kind: 'and' | 'or', other: Locator): Locator {
    const a = this.frameSplit();
    const b = other.frameSplit();
    if (!a && !b) return new Locator(this.owner, { kind, left: this, right: other });
    const text = `${this.toString()}.${kind}(${other.toString()})`;
    if (a && b && Locator.stepsText(this.owner, a.prefix) === Locator.stepsText(this.owner, b.prefix) && a.rest.length && b.rest.length) {
      const inner = new Locator(this.owner, { kind, left: new Locator(this.owner, a.rest), right: new Locator(other.owner, b.rest) });
      return new Locator(this.owner, [...a.prefix, ...inner.steps], text);
    }
    return new Locator(
      this.owner,
      {
        kind: 'invalid',
        selector: text,
        message: `Frame locators are not allowed inside composite locators, while querying "${text}"`,
      },
      text,
    );
  }

  private get tail(): Step {
    const s = this.steps[this.steps.length - 1];
    if (!s) throw new Error('empty locator');
    return s;
  }

  private withTail(change: Partial<Step>): Locator {
    return new Locator(this.owner, [...this.steps.slice(0, -1), { ...this.tail, ...change }]);
  }

  /** This chain followed by `more`. */
  extendWith(more: Step[]): Locator {
    return new Locator(this.owner, [...this.steps, ...more]);
  }

  private chain(query: LocatorQuery): Locator {
    return this.extendWith([step(query)]);
  }

  // --- building -------------------------------------------------------

  first(): Locator {
    return this.nth(0);
  }

  last(): Locator {
    return this.nth(-1);
  }

  /** The i-th match (0-based; negative counts from the end). */
  nth(index: number): Locator {
    // An index after an index picks among that one match.
    if (this.tail.index !== null) return this.extendWith([{ query: { kind: 'self' }, filters: [], index }]);
    return this.withTail({ index });
  }

  filter(options: FilterOptions): Locator {
    for (const [key, inner] of [['has', options.has], ['hasNot', options.hasNot]] as const) {
      // An inner locator searches inside this one's matches, so it cannot hop into another frame.
      if (inner && inner.frameSplit() && !this.frameSplit()) throw new Error(`Inner "${key}" locator must belong to the same frame.`);
    }
    // A filter after an index filters that one match.
    if (this.tail.index !== null) return this.extendWith([{ query: { kind: 'self' }, filters: [options], index: null }]);
    return this.withTail({ filters: [...this.tail.filters, options] });
  }

  and(other: Locator): Locator {
    return this.composite('and', other);
  }

  or(other: Locator): Locator {
    return this.composite('or', other);
  }

  /** A selector (or another locator) searched inside this locator's matches. */
  locator(selector: string | Locator, options?: LocatorOptions): Locator {
    const l = typeof selector !== 'string' ? this.extendWith(selector.steps) : this.extendWith(selectorSteps(selector));
    return options && Object.keys(options).length ? l.filter(options) : l;
  }

  getByRole(role: string, options: ByRoleOptions = {}): Locator {
    return this.chain({ kind: 'role', role, options });
  }

  getByText(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.chain({ kind: 'text', text, options });
  }

  getByLabel(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.chain({ kind: 'label', text, options });
  }

  getByTestId(id: string | RegExp): Locator {
    return this.chain(byAttr('getByTestId', this.owner.testIdAttribute, id, true));
  }

  getByPlaceholder(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.chain(byAttr('getByPlaceholder', 'placeholder', text, options.exact ?? false));
  }

  getByAltText(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.chain(byAttr('getByAltText', 'alt', text, options.exact ?? false));
  }

  getByTitle(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.chain(byAttr('getByTitle', 'title', text, options.exact ?? false));
  }

  /** `fn(element, arg)` in the page, keeping the result there as a handle. */
  async evaluateHandle<A = unknown>(fn: string | ((el: any, arg: A) => unknown), arg?: A, options: { timeout?: number } = {}): Promise<JSHandle> {
    const h = await this.elementHandle(options);
    return h.evaluateHandle(fn, arg);
  }

  /** The matched element as an ElementHandle (waits for it, strict). */
  async elementHandle(options: { timeout?: number } = {}): Promise<ElementHandle> {
    const id = await this.waitOne<number>('locator.elementHandle', 'adopt', {}, options.timeout);
    return newElementHandle(this.owner, id);
  }

  /** Every current match as an ElementHandle. */
  async elementHandles(): Promise<ElementHandle[]> {
    const ids = await this.many<number[]>('adoptAll');
    return ids.map((id) => newElementHandle(this.owner, id));
  }

  /** The first match as an ElementHandle, or null (no waiting, not strict). */
  async firstHandle(): Promise<ElementHandle | null> {
    const r = await this.run<number>('adopt', {}, { first: true });
    return r.none ? null : newElementHandle(this.owner, r.v as number);
  }

  /** The content of the iframe this locator matches. */
  contentFrame(): FrameLocator {
    return new FrameLocator(this);
  }

  /** The iframe matching `selector` inside this locator's matches. */
  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this.locator(selector));
  }

  /** The same locator, shown as `description` in errors and toString(). */
  /** The text given to describe(), or null. */
  description(): string | null {
    return this.desc ?? null;
  }

  describe(description: string): Locator {
    return new Locator(this.owner, this.steps, description);
  }

  toString(): string {
    if (this.desc) return this.desc;
    const out: string[] = [];
    for (const s of this.steps) {
      let part = describeQuery(s.query);
      for (const f of s.filters) part += `.${describeFilter(f)}`;
      if (s.index !== null) part += s.index === 0 ? '.first()' : s.index === -1 ? '.last()' : `.nth(${s.index})`;
      out.push(part);
    }
    return out.reduce((acc, p) => (acc === '' ? p : p.startsWith('.') ? acc + p : `${acc}.${p}`), '');
  }

  // --- engine calls ---------------------------------------------------

  private run<T>(op: string, args?: unknown, opts: { many?: boolean; first?: boolean } = {}, fn?: string): Promise<RunResult<T>> {
    return this.owner.engineRun<RunResult<T>>({ steps: this.wire(), op, args, ...opts }, fn);
  }

  private strictError(apiName: string, r: RunResult<unknown>): StrictModeError {
    const list = (r.strict ?? []).map((p, i) => `    ${i + 1}) ${p}`).join('\n');
    return new StrictModeError(
      `${apiName}: Error: strict mode violation: ${this.toString()} resolved to ${r.n} elements:\n${list}\n`,
    );
  }

  /**
   * Run a one-element op, waiting until something matches and the op
   * stops asking to retry. Strict-mode violations fail at once.
   */
  private async waitOne<T>(apiName: string, op: string, args: unknown, timeout?: number, fn?: string): Promise<T> {
    const budget = timeout ?? this.owner.timeouts.action;
    const deadline = Date.now() + budget;
    let why = '';
    for (let i = 0; ; i++) {
      await this.owner.runLocatorHandlers();
      const r = await this.run<T>(op, args, {}, fn);
      if (r.strict) throw this.strictError(apiName, r);
      if (!r.none) {
        if (!isRetry(r.v)) return r.v as T;
        why = r.v.retry;
      }
      if (budget > 0 && Date.now() >= deadline) {
        throw new TimeoutError(
          `${apiName}: Timeout ${budget}ms exceeded.\nCall log:\n  - waiting for ${this.toString()}` +
            (why ? `\n  - ${why}` : ''),
        );
      }
      await backoff(i);
    }
  }

  /** One-element op with no waiting: undefined when nothing matches. */
  async peek<T>(apiName: string, op: string, args?: unknown): Promise<{ found: boolean; v?: T; preview?: string }> {
    const r = await this.run<T>(op, args);
    if (r.strict) throw this.strictError(apiName, r);
    if (r.none) return { found: false };
    return { found: true, v: r.v as T, preview: r.p ?? '' };
  }

  /** A multi-element op over the current matches. */
  async many<T>(op: string, args?: unknown, fn?: string): Promise<T> {
    return (await this.run<T>(op, args, { many: true }, fn)).v as T;
  }

  // --- actions --------------------------------------------------------

  /**
   * Click the element. A left click without modifiers is a trusted
   * native click at the element's center; other buttons, modifiers and
   * multi-clicks are dispatched in the page.
   */
  async click(options: ClickOptions = {}): Promise<void> {
    const pt = await this.waitOne<{ x: number; y: number }>(
      'locator.click',
      'clickPoint',
      { position: options.position, force: options.force },
      options.timeout,
    );
    if (options.trial) return;
    if (options.delay) await sleep(options.delay);
    const synthetic =
      (options.button && options.button !== 'left') ||
      (options.modifiers && options.modifiers.length > 0) ||
      (options.clickCount ?? 1) > 1;
    if (synthetic && this.owner.nativeClickOptions) {
      // Native button, count and modifiers (vibesurfer 0.2.19+): trusted, like any other click.
      await this.owner.clickAt(pt.x, pt.y, undefined, {
        count: options.clickCount,
        button: options.button,
        modifiers: options.modifiers,
      });
      await this.run('settleFocus', {}, { first: true }).catch(() => {});
    } else if (synthetic) {
      await this.waitOne('locator.click', 'synthClick', options, options.timeout);
    } else {
      let at = pt;
      for (let attempt = 0; ; attempt++) {
        await this.owner.clickAt(at.x, at.y);
        await this.run('settleFocus', {}, { first: true }).catch(() => {});
        if (attempt === 2 || !(await this.clickWasLost())) break;
        // The page re-rendered between press and release, so the two
        // landed on different elements and no click fired: click the
        // element again while it is there.
        const again = await this.run<{ x: number; y: number }>(
          'clickPoint',
          { position: options.position, force: options.force },
          { first: true },
        ).catch(() => null);
        if (!again || again.none || isRetry(again.v)) break;
        at = again.v as { x: number; y: number };
      }
    }
  }

  /**
   * Whether the last native click's release reached the page without a
   * click event. The page can answer before the mouse events arrive
   * (WebKit sends each once the last is acknowledged), so this waits
   * for the release first; click follows mouseup in the same dispatch.
   */
  private async clickWasLost(): Promise<boolean> {
    const deadline = Date.now() + 500;
    for (;;) {
      const r = await this.run<{ up: boolean; click: boolean }>('clickSeen', {}, { first: true }).catch(() => null);
      if (!r || r.none || !r.v) return false;
      if (r.v.click) return false;
      if (r.v.up) return true;
      if (Date.now() >= deadline) return false;
      await sleep(10);
    }
  }

  async dblclick(options: Omit<ClickOptions, 'clickCount'> = {}): Promise<void> {
    await this.click({ ...options, clickCount: 2 });
  }

  async tap(options: ClickOptions = {}): Promise<void> {
    await this.click(options);
  }

  /** Move the pointer over the element with trusted input. */
  async hover(options: ActionOptions & { position?: { x: number; y: number } } = {}): Promise<void> {
    const pt = await this.waitOne<{ x: number; y: number }>(
      'locator.hover',
      'clickPoint',
      { position: options.position, force: options.force, enabled: false },
      options.timeout,
    );
    if (options.trial) return;
    await this.owner.mouse.move(pt.x, pt.y);
  }

  /** Replace the field's value (inputs, textareas, contenteditable). */
  async fill(value: string, options: ActionOptions = {}): Promise<void> {
    await this.waitOne('locator.fill', 'fill', { value, force: options.force }, options.timeout);
  }

  async clear(options: ActionOptions = {}): Promise<void> {
    await this.fill('', options);
  }

  /**
   * Focus the element, then type with trusted per-character key events
   * (isTrusted=true), for editors that ignore fill().
   */
  async pressSequentially(text: string, options: { delay?: number; timeout?: number } = {}): Promise<void> {
    await this.waitOne('locator.pressSequentially', 'focus', {}, options.timeout);
    await this.owner.typeTrusted(text);
  }

  /** Same as pressSequentially(). */
  async type(text: string, options: { delay?: number; timeout?: number } = {}): Promise<void> {
    await this.pressSequentially(text, options);
  }

  /** Focus the element and press a key or chord, e.g. `Enter` or `Control+A`. */
  async press(key: string, options: { delay?: number; timeout?: number } = {}): Promise<void> {
    await this.waitOne('locator.press', 'press', { key }, options.timeout);
  }

  async focus(options: { timeout?: number } = {}): Promise<void> {
    await this.waitOne('locator.focus', 'focus', {}, options.timeout);
  }

  async blur(options: { timeout?: number } = {}): Promise<void> {
    await this.waitOne('locator.blur', 'blur', {}, options.timeout);
  }

  async setChecked(checked: boolean, options: ClickOptions = {}): Promise<void> {
    const state = await this.waitOne<boolean>('locator.setChecked', 'checked', {}, options.timeout);
    if (state === checked) return;
    await this.click(options);
    if (options.trial) return;
    // The click's events can still be on their way to the page (WebKitGTK
    // sends a mouse event once the last one is acknowledged), so give
    // the state a moment to change before calling the click a failure.
    const deadline = Date.now() + 1000;
    for (;;) {
      const after = await this.peek<boolean>('locator.setChecked', 'checked');
      if (!after.found || after.v === checked) return;
      if (Date.now() >= deadline) throw new Error('Clicking the checkbox did not change its state');
      await sleep(10);
    }
  }

  async check(options: ClickOptions = {}): Promise<void> {
    await this.setChecked(true, options);
  }

  async uncheck(options: ClickOptions = {}): Promise<void> {
    await this.setChecked(false, options);
  }

  /** Select options by value or label (or `{ value, label, index }`). Returns the selected values. */
  async selectOption(
    values: SelectOptionValue | SelectOptionValue[] | null,
    options: ActionOptions = {},
  ): Promise<string[]> {
    const list = values === null ? [] : Array.isArray(values) ? values : [values];
    const wanted = list.map((v) => (typeof v === 'string' ? { valueOrLabel: v } : v));
    const budget = options.timeout ?? this.owner.timeouts.action;
    const deadline = Date.now() + budget;
    for (let i = 0; ; i++) {
      const r = await this.waitOne<{ values?: string[]; missing?: boolean }>(
        'locator.selectOption',
        'selectOption',
        { values: wanted },
        Math.max(1, deadline - Date.now()),
      );
      if (r.values) return r.values;
      if (Date.now() >= deadline) {
        throw new TimeoutError(`locator.selectOption: Timeout ${budget}ms exceeded.\n  - did not find some options`);
      }
      await backoff(i);
    }
  }

  async selectText(options: ActionOptions = {}): Promise<void> {
    await this.waitOne('locator.selectText', 'selectText', {}, options.timeout);
  }

  /** Set the files of an `<input type=file>`: paths, or `{ name, mimeType, buffer }`. */
  async setInputFiles(files: InputFile | InputFile[], options: ActionOptions = {}): Promise<void> {
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const list = Array.isArray(files) ? files : [files];
    const payload = await Promise.all(
      list.map(async (f) => {
        if (typeof f === 'string') {
          const buf = await fs.readFile(f);
          return {
            name: nodePath.basename(f),
            mimeType: MIME[nodePath.extname(f).toLowerCase()] ?? 'application/octet-stream',
            b64: buf.toString('base64'),
          };
        }
        return { name: f.name, mimeType: f.mimeType, b64: f.buffer.toString('base64') };
      }),
    );
    await this.waitOne('locator.setInputFiles', 'setFiles', { files: payload }, options.timeout);
  }

  async dispatchEvent(type: string, eventInit: Record<string, unknown> = {}, options: { timeout?: number } = {}): Promise<void> {
    await this.waitOne('locator.dispatchEvent', 'dispatch', { type, init: eventInit }, options.timeout);
  }

  async scrollIntoViewIfNeeded(options: { timeout?: number } = {}): Promise<void> {
    await this.waitOne('locator.scrollIntoViewIfNeeded', 'scroll', {}, options.timeout);
  }

  /** Accepted for compatibility; there is no headed browser to highlight in. */
  async highlight(): Promise<void> {}

  /**
   * Drag this element onto `target` with a trusted press, move and
   * release from center to center. vibesurfer also fires the HTML5
   * drag events, so native draggable and react-dnd lists see the drop.
   */
  /**
   * A locator for the same element written the recommended way: by
   * test id, else by role and accessible name, else by exact text;
   * this locator when none of those picks it alone.
   */
  async normalize(): Promise<Locator> {
    const page = this.owner as unknown as {
      getByTestId(id: string): Locator;
      getByRole(role: string, o: { name: string; exact: boolean }): Locator;
      getByText(t: string, o: { exact: boolean }): Locator;
      testIdAttribute?: string | null;
    };
    const attr = page.testIdAttribute || 'data-testid';
    const id = await this.getAttribute(attr).catch(() => null);
    const unique = async (l: Locator) => (await l.count().catch(() => 0)) === 1;
    if (id) {
      const l = page.getByTestId(id);
      if (await unique(l)) return l;
    }
    const first = (await this.ariaSnapshot().catch(() => '')).split('\n')[0] ?? '';
    const m = /^- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(first);
    if (m && m[2] !== undefined && m[1] !== 'text') {
      const l = page.getByRole(m[1]!, { name: m[2].replace(/\\(.)/g, '$1'), exact: true });
      if (await unique(l)) return l;
    }
    const text = (await this.textContent().catch(() => '') ?? '').trim();
    if (text) {
      const l = page.getByText(text, { exact: true });
      if (await unique(l)) return l;
    }
    return this;
  }

  /**
   * Drop external data (files, or mime type to string) onto the element's
   * center, as a drag from another application: native, trusted
   * dragenter, dragover and drop.
   */
  async drop(
    payload: { files?: string | string[] | DropFile | DropFile[]; data?: Record<string, string> },
    options: { timeout?: number } = {},
  ): Promise<void> {
    const list = payload.files === undefined ? [] : Array.isArray(payload.files) ? payload.files : [payload.files];
    const box = await this.boundingBox(options);
    if (!box) throw new TimeoutError(`locator.drop: ${this.toString()} is not rendered`);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const { paths, cleanup } = await filesOnDisk(list);
    try {
      const native = await this.owner.nativeDrop(x, y, paths, payload.data ?? {});
      if (native !== null) return;
      await this.scriptDrop(paths, payload.data ?? {});
    } finally {
      await cleanup();
    }
  }

  /** The drop as script events, where the daemon has no native drop. */
  private async scriptDrop(paths: string[], data: Record<string, string>): Promise<void> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const files = await Promise.all(
      paths.map(async (p) => ({ name: path.basename(p), mimeType: '', b64: (await fs.readFile(p)).toString('base64') })),
    );
    await this.evaluate(
      `(el, p) => {
        const dt = new DataTransfer();
        for (const [k, v] of Object.entries(p.data || {})) dt.setData(k, v);
        for (const f of p.files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.mimeType }));
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }));
      }`,
      { files, data },
    );
  }

  async dragTo(target: Locator, options: { timeout?: number } = {}): Promise<void> {
    const from = await this.boundingBox(options);
    if (!from) throw new TimeoutError(`locator.dragTo: ${this.toString()} is not rendered`);
    const to = await target.boundingBox(options);
    if (!to) throw new TimeoutError(`locator.dragTo: ${target.toString()} is not rendered`);
    await this.owner.mouse.drag(
      from.x + from.width / 2,
      from.y + from.height / 2,
      to.x + to.width / 2,
      to.y + to.height / 2,
    );
  }

  /** Wait for the locator to reach a state: attached, detached, visible (default) or hidden. */
  async waitFor(options: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number } = {}): Promise<void> {
    const state = options.state ?? 'visible';
    const budget = options.timeout ?? this.owner.timeouts.action;
    const deadline = Date.now() + budget;
    for (let i = 0; ; i++) {
      let ok: boolean;
      if (state === 'attached' || state === 'detached') {
        const n = await this.count();
        ok = state === 'attached' ? n > 0 : n === 0;
      } else {
        const r = await this.peek<boolean>('locator.waitFor', 'visible');
        const visible = r.found && r.v === true;
        ok = state === 'visible' ? visible : !visible;
      }
      if (ok) return;
      if (Date.now() >= deadline) {
        throw new TimeoutError(
          `locator.waitFor: Timeout ${budget}ms exceeded.\nCall log:\n  - waiting for ${this.toString()} to be ${state}`,
        );
      }
      await backoff(i);
    }
  }

  // --- reading --------------------------------------------------------

  async textContent(options: { timeout?: number } = {}): Promise<string> {
    return this.waitOne('locator.textContent', 'text', {}, options.timeout);
  }

  async innerText(options: { timeout?: number } = {}): Promise<string> {
    return this.waitOne('locator.innerText', 'innerText', {}, options.timeout);
  }

  async innerHTML(options: { timeout?: number } = {}): Promise<string> {
    return this.waitOne('locator.innerHTML', 'innerHTML', {}, options.timeout);
  }

  /** An attribute's value, or null when absent. */
  async getAttribute(name: string, options: { timeout?: number } = {}): Promise<string | null> {
    return this.waitOne('locator.getAttribute', 'attr', { name }, options.timeout);
  }

  /** Current value of an input, textarea or select. */
  async inputValue(options: { timeout?: number } = {}): Promise<string> {
    return this.waitOne('locator.inputValue', 'value', {}, options.timeout);
  }

  async isChecked(options: { timeout?: number } = {}): Promise<boolean> {
    return this.waitOne('locator.isChecked', 'checked', {}, options.timeout);
  }

  /** Disabled natively (`disabled`, a disabled fieldset) or with `aria-disabled="true"`. */
  async isDisabled(options: { timeout?: number } = {}): Promise<boolean> {
    return this.waitOne('locator.isDisabled', 'disabled', {}, options.timeout);
  }

  async isEnabled(options: { timeout?: number } = {}): Promise<boolean> {
    return !(await this.isDisabled(options));
  }

  async isEditable(options: { timeout?: number } = {}): Promise<boolean> {
    return this.waitOne('locator.isEditable', 'editable', {}, options.timeout);
  }

  async isFocused(options: { timeout?: number } = {}): Promise<boolean> {
    return this.waitOne('locator.isFocused', 'focused', {}, options.timeout);
  }

  /** True if the locator's element is visible right now (no waiting). */
  async isVisible(): Promise<boolean> {
    const r = await this.peek<boolean>('locator.isVisible', 'visible');
    return r.found && r.v === true;
  }

  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }

  /** Number of current matches (no waiting). A navigation mid-query counts as no matches. */
  async count(options: { __testHookBeforeQuery?: () => Promise<unknown> } = {}): Promise<number> {
    // The query belongs to the document it started in; if a navigation
    // replaces that document before the result is read, nothing matched.
    const hookFn = options.__testHookBeforeQuery;
    const doc = hookFn ? await this.owner.engineCall('E.doc').catch(() => null) : null;
    const hook = hookFn ? hookFn().catch(() => {}) : null;
    try {
      if (hook) await hook;
      const n = (await this.run<number>('count', {}, { many: true })).n ?? 0;
      if (!hookFn) return n;
      const after = await this.owner.engineCall('E.doc').catch(() => null);
      return doc !== null && after !== doc ? 0 : n;
    } catch (e) {
      if (e instanceof Error && /Execution context was destroyed/.test(e.message)) return 0;
      throw e;
    } finally {
      await hook;
    }
  }

  /** One locator per current match, in document order (no waiting). */
  async all(): Promise<Locator[]> {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  async allTextContents(): Promise<string[]> {
    return this.many('texts');
  }

  async allInnerTexts(): Promise<string[]> {
    return this.many('innerTexts');
  }

  /** Rect in CSS px relative to the main frame's viewport, or null when not rendered. */
  async boundingBox(options: { timeout?: number } = {}): Promise<BoundingBox | null> {
    return this.waitOne('locator.boundingBox', 'box', {}, options.timeout);
  }

  /** Call `fn(element, arg)` in the page and return its result. */
  async evaluate<R, A = unknown>(
    fn: string | ((el: any, arg: A) => R | Promise<R>),
    arg?: A,
    options: { timeout?: number } = {},
  ): Promise<R> {
    return this.waitOne('locator.evaluate', 'eval', { arg: serializeValue(arg) }, options.timeout, fn.toString());
  }

  /** Call `fn(elements, arg)` with every match and return its result. */
  async evaluateAll<R, A = unknown>(fn: string | ((els: any[], arg: A) => R | Promise<R>), arg?: A): Promise<R> {
    return this.many('evalAll', { arg: serializeValue(arg) }, fn.toString());
  }

  /** PNG of the element. Returns the bytes; with `path`, also writes the file. */
  async screenshot(options: { path?: string; timeout?: number } = {}): Promise<Buffer> {
    await this.scrollIntoViewIfNeeded(options);
    const box = await this.boundingBox(options);
    if (!box) throw new Error(`locator.screenshot: ${this.toString()} is not visible`);
    return this.owner.screenshotClip(box, options.path);
  }

  /** The matched element's accessibility subtree as template text (see toMatchAriaSnapshot). */
  async ariaSnapshot(options: { timeout?: number } = {}): Promise<string> {
    const { snap, refs } = await this.resolveScope(options.timeout);
    return renderSnapshot(snap, refs);
  }

  /** Tree refs of the strict-mode match, for scoping a snapshot match. */
  async resolveScope(timeout?: number): Promise<{ snap: Snapshot; refs: number[] }> {
    const refs = await this.waitOne<number[]>('locator.ariaSnapshot', 'refs', {}, timeout);
    const snap = await this.owner.view();
    return { snap, refs };
  }
}

