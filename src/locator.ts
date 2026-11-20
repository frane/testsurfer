/**
 * Locators: lazy, re-resolving element queries.
 *
 * A locator stores a chain of queries, never an element. Every action
 * and read resolves the chain again, in the page, through the engine
 * in src/injected.ts, so locators survive re-renders and navigation.
 * Single-element operations are strict: more than one match is an
 * error unless first(), last() or nth() picks one. Actions wait until
 * the element is attached, visible, enabled and not covered, then
 * click with trusted native input at its center.
 */

import { parseSelector, type CssExtras } from './selector.ts';
import { StrictModeError, TimeoutError } from './errors.ts';
import { renderSnapshot } from './aria.ts';
import { serializeValue } from './serialize.ts';
import type { Snapshot } from './tree.ts';
import type { Page } from './page.ts';

export interface ByRoleOptions {
  /** Accessible name. String: case-insensitive substring (whole string and case-sensitive with exact). RegExp: tested as-is. */
  name?: string | RegExp;
  exact?: boolean;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  includeHidden?: boolean;
  /** Heading level, from h1-h6 or aria-level. */
  level?: number;
  pressed?: boolean;
  selected?: boolean;
}

export interface ByTextOptions {
  /** String matching is substring, case-insensitive; exact makes it whole-string, case-sensitive. */
  exact?: boolean;
}

export interface FilterOptions {
  /** Keep matches whose text contains this (substring, case-insensitive) or matches the RegExp. */
  hasText?: string | RegExp;
  /** Drop matches whose text contains this. */
  hasNotText?: string | RegExp;
  /** Keep matches that contain an element matching this locator. */
  has?: Locator;
  /** Drop matches that contain an element matching this locator. */
  hasNot?: Locator;
  /** Keep only visible (true) or only hidden (false) matches. */
  visible?: boolean;
}

/** page.locator() / locator.locator() options: the same filters, minus visible. */
export type LocatorOptions = Omit<FilterOptions, 'visible'>;

export type LocatorQuery =
  | { kind: 'role'; role: string; options: ByRoleOptions }
  | { kind: 'text'; text: string | RegExp; options: ByTextOptions }
  | { kind: 'label'; text: string | RegExp; options: ByTextOptions }
  | { kind: 'css'; selector: string; extras?: CssExtras }
  | { kind: 'xpath'; xpath: string }
  | { kind: 'attr'; method: string; attr: string; value: string | RegExp; exact: boolean }
  | { kind: 'and' | 'or'; left: Locator; right: Locator }
  | { kind: 'frame' }
  /** The previous step's matches themselves, so an index or filter can apply after an index. */
  | { kind: 'self' }
  /** A selector that failed to parse; resolving it throws `message`. */
  | { kind: 'invalid'; selector: string; message: string };

/** One link of a chain: a query, its filters, and an optional index. */
export interface Step {
  query: LocatorQuery;
  filters: FilterOptions[];
  /** nth() index; negative counts from the end (last() is -1). */
  index: number | null;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActionOptions {
  timeout?: number;
  force?: boolean;
  noWaitAfter?: boolean;
  trial?: boolean;
}

export interface ClickOptions extends ActionOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
  modifiers?: ('Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift')[];
  position?: { x: number; y: number };
}

export type SelectOptionValue = string | { value?: string; label?: string; index?: number };

export type InputFile = string | { name: string; mimeType: string; buffer: Buffer };

// --- describing ----------------------------------------------------------

/** A string in Playwright's locator notation: single quotes, escaped. */
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const lit = (v: string | RegExp) => (v instanceof RegExp ? String(v) : q(v));

function describeOptions(o: Record<string, unknown>): string {
  const parts = Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' || v instanceof RegExp ? lit(v) : String(v)}`);
  return parts.length ? `, { ${parts.join(', ')} }` : '';
}

export function describeQuery(query: LocatorQuery): string {
  switch (query.kind) {
    case 'role':
      return `getByRole(${q(query.role)}${describeOptions({ ...query.options })})`;
    case 'text':
      return `getByText(${lit(query.text)}${query.options.exact ? ', { exact: true }' : ''})`;
    case 'label':
      return `getByLabel(${lit(query.text)}${query.options.exact ? ', { exact: true }' : ''})`;
    case 'css':
      return `locator(${q(query.selector)})`;
    case 'xpath':
      return `locator(${q(`xpath=${query.xpath}`)})`;
    case 'attr':
      return query.method === 'locator'
        ? `locator(${q(`${query.attr}=${String(query.value)}`)})`
        : `${query.method}(${lit(query.value)}${!query.exact || query.method === 'getByTestId' ? '' : ', { exact: true }'})`;
    case 'and':
    case 'or':
      return `${query.left.toString()}.${query.kind}(${query.right.toString()})`;
    case 'frame':
      return 'contentFrame()';
    case 'self':
      return '';
    case 'invalid':
      return query.selector;
  }
}

function describeFilter(f: FilterOptions): string {
  const parts: string[] = [];
  if (f.hasText !== undefined) parts.push(`hasText: ${lit(f.hasText)}`);
  if (f.hasNotText !== undefined) parts.push(`hasNotText: ${lit(f.hasNotText)}`);
  if (f.has) parts.push(`has: ${f.has.toString()}`);
  if (f.hasNot) parts.push(`hasNot: ${f.hasNot.toString()}`);
  if (f.visible !== undefined) parts.push(`visible: ${f.visible}`);
  return `filter({ ${parts.join(', ')} })`;
}

// --- wire form -------------------------------------------------------------

type WireMatcher = { s: string; exact: boolean } | { re: [string, string] };

const wm = (v: string | RegExp, exact = false): WireMatcher =>
  v instanceof RegExp ? { re: [v.source, v.flags] } : { s: v, exact };

function wireQuery(query: LocatorQuery): Record<string, unknown> {
  switch (query.kind) {
    case 'role': {
      const { name, exact, ...rest } = query.options;
      return { k: 'role', role: query.role, o: { ...rest, ...(name !== undefined ? { name: wm(name, exact) } : {}) } };
    }
    case 'text':
      return { k: 'text', t: wm(query.text, query.options.exact) };
    case 'label':
      return { k: 'label', t: wm(query.text, query.options.exact) };
    case 'css':
      return { k: 'css', sel: query.selector, x: query.extras && Object.keys(query.extras).length ? query.extras : undefined };
    case 'xpath':
      return { k: 'xpath', xp: query.xpath };
    case 'attr':
      return { k: 'attr', a: query.attr, t: wm(query.value, query.exact), testid: query.method === 'getByTestId' || query.method === 'locator' };
    case 'and':
    case 'or':
      return { k: query.kind, l: query.left.wire(), r: query.right.wire() };
    case 'frame':
      return { k: 'frame' };
    case 'self':
      return { k: 'self' };
    case 'invalid':
      throw new Error(`Error: ${query.message}`);
  }
}

function wireFilter(f: FilterOptions): Record<string, unknown> {
  return {
    hasText: f.hasText !== undefined ? wm(f.hasText) : undefined,
    hasNotText: f.hasNotText !== undefined ? wm(f.hasNotText) : undefined,
    has: f.has ? f.has.wire() : undefined,
    hasNot: f.hasNot ? f.hasNot.wire() : undefined,
    visible: f.visible,
  };
}

// --- selectors -----------------------------------------------------------

export function byAttr(method: string, attr: string, value: string | RegExp, exact: boolean): LocatorQuery {
  return { kind: 'attr', method, attr, value, exact };
}

const step = (query: LocatorQuery): Step => ({ query, filters: [], index: null });

/** A Playwright selector string as chain steps. */
export function selectorSteps(selector: string): Step[] {
  try {
    return parseSteps(selector);
  } catch (e) {
    // Like Playwright, a bad selector fails when the locator is used, not when it is made.
    return [step({ kind: 'invalid', selector, message: e instanceof Error ? e.message : String(e) })];
  }
}

function parseSteps(selector: string): Step[] {
  const steps: Step[] = [];
  const last = (what: string): Step => {
    const s = steps[steps.length - 1];
    if (!s) throw new Error(`"${what}" cannot start a selector`);
    return s;
  };
  for (const p of parseSelector(selector)) {
    switch (p.kind) {
      case 'nth':
        last('nth=').index = p.index;
        break;
      case 'visible':
        last('visible=').filters.push({ visible: p.visible });
        break;
      case 'css':
        steps.push(step({ kind: 'css', selector: p.selector, extras: p.extras }));
        break;
      case 'xpath':
        steps.push(step(p));
        break;
      case 'text':
        steps.push(step({ kind: 'text', text: p.text, options: { exact: p.exact } }));
        break;
      case 'attr':
        steps.push(step(byAttr('locator', p.attr, p.value, true)));
        break;
      case 'role':
        steps.push(step({ kind: 'role', role: p.role, options: p.options }));
        break;
    }
  }
  if (steps.length === 0) throw new Error(`empty selector "${selector}"`);
  return steps;
}

// --- resolution ----------------------------------------------------------

interface RunResult<T> {
  v?: T;
  /** Preview of the element a one-element op ran on. */
  p?: string;
  n?: number;
  none?: boolean;
  strict?: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Retry cadence, as Playwright's: fast at first, then backing off. */
const BACKOFF = [0, 20, 50, 100, 100, 250];

const isRetry = (v: unknown): v is { retry: string } =>
  typeof v === 'object' && v !== null && 'retry' in v && typeof (v as { retry: unknown }).retry === 'string';

const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.webp': 'image/webp', '.csv': 'text/csv', '.zip': 'application/zip',
};

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
    return this.steps.map((s) => ({ q: wireQuery(s.query), f: s.filters.map(wireFilter), i: s.index }));
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
    // A filter after an index filters that one match.
    if (this.tail.index !== null) return this.extendWith([{ query: { kind: 'self' }, filters: [options], index: null }]);
    return this.withTail({ filters: [...this.tail.filters, options] });
  }

  and(other: Locator): Locator {
    return new Locator(this.owner, { kind: 'and', left: this, right: other });
  }

  or(other: Locator): Locator {
    return new Locator(this.owner, { kind: 'or', left: this, right: other });
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
      await sleep(BACKOFF[Math.min(i, BACKOFF.length - 1)]!);
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
      (options.clickCount ?? 1) > 1 ||
      this.owner.clickVia === 'act';
    if (synthetic) {
      await this.waitOne('locator.click', 'synthClick', options, options.timeout);
    } else {
      await this.owner.clickAt(pt.x, pt.y);
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
    const after = await this.peek<boolean>('locator.setChecked', 'checked');
    if (after.found && after.v !== checked) throw new Error('Clicking the checkbox did not change its state');
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
      await sleep(BACKOFF[Math.min(i, BACKOFF.length - 1)]!);
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
      await sleep(BACKOFF[Math.min(i, BACKOFF.length - 1)]!);
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

  /** Number of current matches (no waiting). */
  async count(): Promise<number> {
    return (await this.run<number>('count', {}, { many: true })).n ?? 0;
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

/** Locators inside an iframe (Playwright's FrameLocator). */
export class FrameLocator {
  private readonly frame: Locator;

  constructor(frame: Locator) {
    this.frame = frame;
  }

  /** The iframe element itself. */
  owner(): Locator {
    return this.frame;
  }

  private inside(): Locator {
    return this.frame.extendWith([step({ kind: 'frame' })]);
  }

  first(): FrameLocator {
    return new FrameLocator(this.frame.first());
  }
  last(): FrameLocator {
    return new FrameLocator(this.frame.last());
  }
  nth(index: number): FrameLocator {
    return new FrameLocator(this.frame.nth(index));
  }
  locator(selector: string | Locator, options?: LocatorOptions): Locator {
    return this.inside().locator(selector, options);
  }
  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this.inside().locator(selector));
  }
  getByRole(role: string, options: ByRoleOptions = {}): Locator {
    return this.inside().getByRole(role, options);
  }
  getByText(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.inside().getByText(text, options);
  }
  getByLabel(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.inside().getByLabel(text, options);
  }
  getByTestId(id: string | RegExp): Locator {
    return this.inside().getByTestId(id);
  }
  getByPlaceholder(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.inside().getByPlaceholder(text, options);
  }
  getByAltText(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.inside().getByAltText(text, options);
  }
  getByTitle(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return this.inside().getByTitle(text, options);
  }
}
