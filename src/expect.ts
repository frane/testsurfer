/**
 * Web-first assertions. Every matcher polls the page until it passes
 * or the expect timeout elapses, so tests never race the page. Negate
 * with `.not`. Failure messages follow Playwright's layout.
 */

import { isDeepStrictEqual } from 'node:util';
import { matchesTemplate, parseTemplate, renderSnapshot } from './aria.ts';
import { StrictModeError } from './errors.ts';
import { APIResponse } from './events.ts';
import { Locator } from './locator.ts';
import { Page } from './page.ts';
import { asymmetric, pollAssertions, ValueAssertions } from './values.ts';
import { assertScreenshot, type ScreenshotOptions } from './screenshot.ts';
import { currentTestInfo } from './testinfo.ts';

export interface ExpectOptions {
  timeout?: number;
}

interface TextOptions extends ExpectOptions {
  ignoreCase?: boolean;
  useInnerText?: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const BACKOFF = [0, 20, 50, 100, 100, 250];

const normalize = (s: string) => s.replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');
const show = (v: unknown): string =>
  v instanceof RegExp ? String(v) : typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'undefined' : JSON.stringify(v);

/** Playwright's text match: strings compare whitespace-normalized, RegExps test the raw text. */
function textMatch(actual: string, expected: string | RegExp, o: { substring?: boolean | undefined; ignoreCase?: boolean | undefined; normalize?: boolean | undefined }): boolean {
  if (expected instanceof RegExp) {
    // ignoreCase overrides the RegExp's own i flag either way.
    const flags =
      o.ignoreCase === true ? expected.flags.replace('i', '') + 'i' : o.ignoreCase === false ? expected.flags.replace('i', '') : expected.flags;
    return new RegExp(expected.source, flags).test(actual);
  }
  let a = o.normalize === false ? actual : normalize(actual);
  let e = o.normalize === false ? expected : normalize(expected);
  if (o.ignoreCase) {
    a = a.toLowerCase();
    e = e.toLowerCase();
  }
  return o.substring ? a.includes(e) : a === e;
}

/** One observation of the page for a matcher. */
interface Sample {
  pass: boolean;
  /** False when the locator matched nothing; the message then says so. */
  found: boolean;
  /** Received value, printed. */
  received?: string;
  /** A missing element still counts (visibility matchers): not found is hidden. */
  missingOk?: boolean;
  /** Replaces the Expected/Received lines (array matchers). */
  diff?: string;
  log?: string[];
}

interface Spec {
  /** Matcher name, e.g. toHaveText. */
  name: string;
  /** What goes in the parentheses of the header: `expected` or nothing. */
  arg: string;
  expectedLabel?: string;
  receivedLabel?: string;
  expected: string;
}

/** The first stack frame outside testsurfer and Node internals: the test's own call. */
function callerFrame(): string | undefined {
  const own = import.meta.url.replace(/\/[^/]*$/, '/').replace(/^file:\/\//, '');
  return (new Error().stack ?? '')
    .split('\n')
    .slice(1)
    .find((l) => l.trim().startsWith('at ') && !l.includes(own) && !l.includes('node:'));
}

/** An assertion failure, carrying Playwright's matcherResult. Its stack points at the test line only. */
export class ExpectError extends Error {
  matcherResult: { message: string; name: string; pass: boolean; log: string[]; timeout: number };
  constructor(message: string, name: string, pass: boolean, log: string[], timeout: number, frame?: string) {
    super(message);
    this.name = 'Error';
    this.matcherResult = { message, name, pass, log, timeout };
    if (frame) this.stack = `Error: ${message}\n${frame}`;
  }
}

function render(
  subject: string,
  locator: string | null,
  spec: Spec,
  negated: boolean,
  timeout: number,
  last: Sample | null,
  error: string | null,
  custom: string | undefined,
): { message: string; log: string[] } {
  const not = negated ? 'not.' : '';
  const out: string[] = [];
  if (custom) out.push(custom, '');
  out.push(`expect(${subject}).${not}${spec.name}(${spec.arg}) failed`, '');
  const expected = `${negated && !spec.expected.startsWith('predicate to') ? 'not ' : ''}${spec.expected}`;
  const loc = locator ? [['Locator', locator] as const] : [];
  if (error) {
    for (const [k, v] of loc) out.push(`${k}: ${v}`);
    out.push(`Expected: ${expected}`, error);
  } else if (!last || !last.found) {
    for (const [k, v] of loc) out.push(`${k}: ${v}`);
    out.push(`Expected: ${expected}`, `Timeout: ${timeout}ms`, 'Error: element(s) not found');
  } else if (last.diff !== undefined) {
    for (const [k, v] of loc) out.push(`${k}: ${v}`);
    out.push(`Timeout: ${timeout}ms`, last.diff);
  } else {
    const el = spec.expectedLabel ?? 'Expected';
    const rl = spec.receivedLabel ?? 'Received';
    if (el === 'Expected' && rl === 'Received') {
      for (const [k, v] of loc) out.push(`${k}:  ${v}`);
      out.push(`Expected: ${expected}`, `Received: ${last.received ?? ''}`, `Timeout:  ${timeout}ms`);
    } else {
      const w = Math.max(el.length, rl.length) + 2;
      for (const [k, v] of loc) out.push(`${k}: ${v}`);
      out.push(`${`${el}:`.padEnd(w)}${expected}`, `${`${rl}:`.padEnd(w)}${last.received ?? ''}`, `Timeout: ${timeout}ms`);
    }
  }
  const log = [`Expect "${negated ? 'not ' : ''}${spec.name}" with timeout ${timeout}ms`];
  if (locator) log.push(`waiting for ${locator}`);
  for (const l of last?.log ?? []) log.push(l);
  if (last?.found && last.received !== undefined && last.diff === undefined && !error) {
    const v = /^["\[{]/.test(last.received) ? last.received : JSON.stringify(last.received);
    log.push(`  - unexpected value ${v}`);
  }
  out.push('', 'Call log:', ...log.map((l) => (l.startsWith('  ') ? `  ${l}` : `  - ${l}`)), '');
  return { message: out.join('\n'), log };
}

/**
 * Poll `sample` until its pass flag differs from `negated`. A strict
 * mode violation, or an engine error about the element's type, fails
 * at once; other errors are retried until the timeout.
 */
async function poll(
  subject: string,
  locator: string | null,
  spec: Spec,
  negated: boolean,
  timeout: number,
  custom: string | undefined,
  sample: () => Promise<Sample>,
): Promise<void> {
  const frame = callerFrame();
  const deadline = Date.now() + timeout;
  let last: Sample | null = null;
  let error: string | null = null;
  for (let i = 0; ; i++) {
    try {
      last = await sample();
      error = null;
      if (last.pass !== negated && (last.found || last.missingOk)) return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const fatal = e instanceof StrictModeError || /^Error: /.test(msg);
      error = /^Error: /.test(msg) ? msg : `Error: ${msg.replace(/^[\w.]+: /, '')}`;
      if (fatal) {
        const { message, log } = render(subject, locator, spec, negated, timeout, last, error, custom);
        throw new ExpectError(message, spec.name, !negated, log, timeout, frame);
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(BACKOFF[Math.min(i, BACKOFF.length - 1)]!);
  }
  const { message, log } = render(subject, locator, spec, negated, timeout, last, error, custom);
  throw new ExpectError(message, spec.name, !negated, log, timeout, frame);
}

/** jest-style diff of two string lists, as Playwright prints array mismatches. */
function arrayDiff(expected: (string | RegExp)[], received: string[], negated: boolean): string | undefined {
  // Negated, Playwright prints plain Expected/Received lines.
  if (negated) return undefined;
  const lines: string[] = [];
  let minus = 0;
  let plus = 0;
  const n = Math.max(expected.length, received.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const r = received[i];
    const es = e === undefined ? undefined : show(e);
    const rs = r === undefined ? undefined : show(r);
    if (e !== undefined && r !== undefined && textMatch(r, e, { normalize: true })) {
      lines.push(`    ${rs},`);
      continue;
    }
    if (es !== undefined) {
      lines.push(`-   ${es},`);
      minus++;
    }
    if (rs !== undefined) {
      lines.push(`+   ${rs},`);
      plus++;
    }
  }
  return [`- Expected  - ${minus}`, `+ Received  + ${plus}`, '', '  Array [', ...lines, '  ]'].join('\n');
}

/** Options in a matcher header, as Playwright prints them: `{ checked: false }`, timeout left out. */
function optArg(o: object | undefined): string {
  const parts = Object.entries(o ?? {})
    .filter(([k, v]) => k !== 'timeout' && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : String(v)}`);
  return parts.length ? `{ ${parts.join(', ')} }` : '';
}

/** An array matcher's printed result: a diff, or plain lines when negated. */
function arrayOut(expected: (string | RegExp)[], received: string[], negated: boolean): { diff: string } | { received: string } {
  const diff = arrayDiff(expected, received, negated);
  return diff === undefined ? { received: JSON.stringify(received) } : { diff };
}

const resolvedLog = (n: number) => [`locator resolved to ${n} element${n === 1 ? '' : 's'}`];

export class LocatorAssertions {
  private readonly locator: Locator;
  private readonly negated: boolean;
  private readonly defaultTimeout: number;
  private readonly custom: string | undefined;

  constructor(locator: Locator, negated = false, defaultTimeout = 5_000, custom?: string) {
    this.locator = locator;
    this.negated = negated;
    this.defaultTimeout = defaultTimeout;
    this.custom = custom;
  }

  get not(): LocatorAssertions {
    return new LocatorAssertions(this.locator, !this.negated, this.defaultTimeout, this.custom);
  }

  private lastPreview: string | undefined;

  /** locator.peek, remembering the element for the call log. */
  private async peekEl<T>(apiName: string, op: string, args?: unknown): Promise<{ found: boolean; v?: T }> {
    const r = await this.locator.peek<T>(apiName, op, args);
    this.lastPreview = r.preview;
    return r;
  }

  private run(spec: Spec, options: ExpectOptions | undefined, sample: () => Promise<Sample>): Promise<void> {
    return poll('locator', this.locator.toString(), spec, this.negated, options?.timeout ?? this.defaultTimeout, this.custom, async () => {
      this.lastPreview = undefined;
      const s = await sample();
      if (!s.log && this.lastPreview) s.log = [`locator resolved to ${this.lastPreview}`];
      return s;
    });
  }

  /** A boolean element state: pass when `read` returns true. */
  private state(name: string, yes: string, no: string, op: string, want: boolean, options?: ExpectOptions, args?: unknown): Promise<void> {
    const expected = want ? yes : no;
    return this.run({ name, arg: optArg(options), expected }, options, async () => {
      const r = await this.peekEl<boolean>(`expect.${name}`, op, args);
      if (!r.found) return { pass: false, found: false };
      return { pass: r.v === want, found: true, received: r.v ? yes : no };
    });
  }

  async toBeVisible(options: ExpectOptions & { visible?: boolean } = {}): Promise<void> {
    const want = options.visible ?? true;
    await this.run({ name: 'toBeVisible', arg: optArg(options), expected: want ? 'visible' : 'hidden' }, options, async () => {
      const r = await this.peekEl<boolean>('expect.toBeVisible', 'visible');
      const visible = r.found && r.v === true;
      return { pass: visible === want, found: r.found, missingOk: !want !== this.negated, received: visible ? 'visible' : 'hidden' };
    });
  }

  async toBeHidden(options: ExpectOptions = {}): Promise<void> {
    await this.run({ name: 'toBeHidden', arg: '', expected: 'hidden' }, options, async () => {
      const r = await this.peekEl<boolean>('expect.toBeHidden', 'visible');
      const visible = r.found && r.v === true;
      return { pass: !visible, found: r.found, missingOk: !this.negated, received: visible ? 'visible' : 'hidden' };
    });
  }

  async toBeAttached(options: ExpectOptions & { attached?: boolean } = {}): Promise<void> {
    const want = options.attached ?? true;
    await this.run({ name: 'toBeAttached', arg: optArg(options), expected: want ? 'attached' : 'detached' }, options, async () => {
      const list = await this.locator.many<string[]>('describe');
      const n = list.length;
      const log = n === 1 ? [`locator resolved to ${list[0]}`] : undefined;
      return { pass: n > 0 === want, found: true, received: n > 0 ? 'attached' : 'detached', ...(log ? { log } : {}) };
    });
  }

  async toBeChecked(options: ExpectOptions & { checked?: boolean; indeterminate?: boolean } = {}): Promise<void> {
    if (options.indeterminate && options.checked !== undefined) {
      throw new Error("Can't assert indeterminate and checked at the same time");
    }
    const want: boolean | 'mixed' = options.indeterminate ? 'mixed' : (options.checked ?? true);
    const word = (v: unknown) => (v === 'mixed' ? 'indeterminate' : v ? 'checked' : 'unchecked');
    await this.run({ name: 'toBeChecked', arg: optArg(options), expected: word(want) }, options, async () => {
      const r = await this.peekEl<boolean | 'mixed'>('expect.toBeChecked', 'checkedMixed');
      if (!r.found) return { pass: false, found: false };
      return { pass: r.v === want, found: true, received: word(r.v) };
    });
  }

  async toBeDisabled(options: ExpectOptions = {}): Promise<void> {
    await this.state('toBeDisabled', 'disabled', 'enabled', 'disabled', true, options);
  }

  async toBeEnabled(options: ExpectOptions & { enabled?: boolean } = {}): Promise<void> {
    await this.state('toBeEnabled', 'disabled', 'enabled', 'disabled', !(options.enabled ?? true), options);
  }

  async toBeEditable(options: ExpectOptions & { editable?: boolean } = {}): Promise<void> {
    await this.state('toBeEditable', 'editable', 'readOnly', 'editable', options.editable ?? true, options);
  }

  async toBeFocused(options: ExpectOptions = {}): Promise<void> {
    await this.state('toBeFocused', 'focused', 'inactive', 'focused', true, options);
  }

  async toBeEmpty(options: ExpectOptions = {}): Promise<void> {
    await this.state('toBeEmpty', 'empty', 'notEmpty', 'empty', true, options);
  }

  async toBeInViewport(options: ExpectOptions & { ratio?: number } = {}): Promise<void> {
    await this.run({ name: 'toBeInViewport', arg: optArg(options), expected: 'in viewport' }, options, async () => {
      const r = await this.peekEl<number>('expect.toBeInViewport', 'inViewport');
      if (!r.found) return { pass: false, found: false };
      const ratio = r.v ?? 0;
      const pass = options.ratio !== undefined ? ratio >= options.ratio && ratio > 0 : ratio > 0;
      return { pass, found: true, received: `viewport ratio ${ratio}` };
    });
  }

  /** The element's text equals the string (whitespace-normalized) or matches the RegExp; an array checks each match. */
  async toHaveText(expected: string | RegExp | (string | RegExp)[], options: TextOptions = {}): Promise<void> {
    await this.text('toHaveText', expected, false, options);
  }

  /** The element's text contains the string or matches the RegExp; an array checks matches in order. */
  async toContainText(expected: string | RegExp | (string | RegExp)[], options: TextOptions = {}): Promise<void> {
    await this.text('toContainText', expected, true, options);
  }

  private async text(name: string, expected: string | RegExp | (string | RegExp)[], substring: boolean, options: TextOptions): Promise<void> {
    const op = options.useInnerText ? 'innerText' : 'elText';
    if (Array.isArray(expected)) {
      await this.run({ name, arg: 'expected', expected: JSON.stringify(expected.map(String)) }, options, async () => {
        const texts = await this.locator.many<string[]>(op === 'elText' ? 'elTexts' : 'innerTexts');
        const ok = (t: string, e: string | RegExp) => textMatch(t, e, { substring, ignoreCase: options.ignoreCase });
        let pass: boolean;
        if (substring) {
          let j = 0;
          for (const t of texts) if (j < expected.length && ok(t, expected[j]!)) j++;
          pass = j === expected.length;
        } else {
          pass = texts.length === expected.length && texts.every((t, i) => ok(t, expected[i]!));
        }
        return { pass, found: true, ...arrayOut(expected, texts, this.negated), log: resolvedLog(texts.length) };
      });
      return;
    }
    const labels =
      expected instanceof RegExp
        ? { expectedLabel: 'Expected pattern', receivedLabel: 'Received string' }
        : substring
          ? { expectedLabel: 'Expected substring', receivedLabel: 'Received string' }
          : {};
    await this.run({ name, arg: 'expected', expected: show(expected), ...labels }, options, async () => {
      const r = await this.peekEl<string>(`expect.${name}`, op);
      if (!r.found) return { pass: false, found: false };
      const t = r.v ?? '';
      return {
        pass: textMatch(t, expected, { substring, ignoreCase: options.ignoreCase }),
        found: true,
        received: show(expected instanceof RegExp ? t : normalize(t)),
      };
    });
  }

  /** The field's current value equals the string (exactly) or matches the RegExp. */
  async toHaveValue(expected: string | RegExp, options: ExpectOptions = {}): Promise<void> {
    await this.run({ name: 'toHaveValue', arg: 'expected', expected: show(expected) }, options, async () => {
      const r = await this.peekEl<string>('expect.toHaveValue', 'value');
      if (!r.found) return { pass: false, found: false };
      return { pass: textMatch(r.v ?? '', expected, { normalize: false }), found: true, received: show(r.v) };
    });
  }

  /** A multi-select's selected values. */
  async toHaveValues(expected: (string | RegExp)[], options: ExpectOptions = {}): Promise<void> {
    await this.run({ name: 'toHaveValues', arg: 'expected', expected: JSON.stringify(expected.map(String)) }, options, async () => {
      const r = await this.peekEl<string[]>('expect.toHaveValues', 'values');
      if (!r.found) return { pass: false, found: false };
      const v = r.v ?? [];
      const pass = v.length === expected.length && v.every((x, i) => textMatch(x, expected[i]!, { normalize: false }));
      return { pass, found: true, ...arrayOut(expected, v, this.negated) };
    });
  }

  /** The attribute is present, and with `value`, equals it (or matches the RegExp). */
  async toHaveAttribute(name: string, value?: string | RegExp | ExpectOptions, options: ExpectOptions & { ignoreCase?: boolean } = {}): Promise<void> {
    if (typeof value === 'object' && !(value instanceof RegExp)) {
      options = value;
      value = undefined;
    }
    const want = value;
    const spec: Spec =
      want === undefined
        ? { name: 'toHaveAttribute', arg: 'expected', expected: 'have attribute' }
        : { name: 'toHaveAttribute', arg: 'expected', expected: show(want) };
    await this.run(spec, options, async () => {
      const r = await this.peekEl<string | null>('expect.toHaveAttribute', 'attr', { name });
      if (!r.found) return { pass: false, found: false };
      const v = r.v ?? null;
      if (want === undefined) return { pass: v !== null, found: true, received: v !== null ? 'have attribute' : 'not have attribute' };
      if (v === null) return { pass: false, found: true, received: 'null' };
      return { pass: textMatch(v, want, { normalize: false, ignoreCase: options.ignoreCase }), found: true, received: show(v) };
    });
  }

  /** The class attribute equals the string (whitespace-normalized) or matches the RegExp; an array checks each match. */
  async toHaveClass(expected: string | RegExp | (string | RegExp)[], options: ExpectOptions = {}): Promise<void> {
    if (Array.isArray(expected)) {
      await this.run({ name: 'toHaveClass', arg: 'expected', expected: JSON.stringify(expected.map(String)) }, options, async () => {
        const list = await this.locator.evaluateAll((els: { getAttribute(n: string): string | null }[]) => els.map((e) => e.getAttribute('class') ?? ''));
        const pass = list.length === expected.length && list.every((c, i) => textMatch(c, expected[i]!, {}));
        return { pass, found: true, ...arrayOut(expected, list, this.negated), log: resolvedLog(list.length) };
      });
      return;
    }
    await this.run({ name: 'toHaveClass', arg: 'expected', expected: show(expected), ...(expected instanceof RegExp ? { expectedLabel: 'Expected pattern', receivedLabel: 'Received string' } : {}) }, options, async () => {
      const r = await this.peekEl<string | null>('expect.toHaveClass', 'attr', { name: 'class' });
      if (!r.found) return { pass: false, found: false };
      const v = r.v ?? '';
      return { pass: textMatch(v, expected, {}), found: true, received: show(v) };
    });
  }

  /** Every class in the expected string is present; an array checks each match. */
  toContainClass(expected: string | string[], options: ExpectOptions = {}): Promise<void> {
    if ((expected as unknown) instanceof RegExp) throw new Error('"expected" argument in toContainClass cannot be a RegExp value');
    if (Array.isArray(expected) && expected.some((e) => (e as unknown) instanceof RegExp)) {
      throw new Error('"expected" argument in toContainClass cannot contain RegExp values');
    }
    return this.containClass(expected, options);
  }

  private async containClass(expected: string | string[], options: ExpectOptions): Promise<void> {
    const has = (actual: string, want: string) => {
      const set = new Set(actual.split(/\s+/).filter(Boolean));
      return want.split(/\s+/).filter(Boolean).every((c) => set.has(c));
    };
    if (Array.isArray(expected)) {
      await this.run({ name: 'toContainClass', arg: 'expected', expected: JSON.stringify(expected) }, options, async () => {
        const list = await this.locator.evaluateAll((els: { getAttribute(n: string): string | null }[]) => els.map((e) => e.getAttribute('class') ?? ''));
        const pass = list.length === expected.length && list.every((c, i) => has(c, expected[i]!));
        return { pass, found: true, ...arrayOut(expected, list, this.negated), log: resolvedLog(list.length) };
      });
      return;
    }
    await this.run({ name: 'toContainClass', arg: 'expected', expected: show(expected), expectedLabel: 'Expected', receivedLabel: 'Received' }, options, async () => {
      const r = await this.peekEl<string | null>('expect.toContainClass', 'attr', { name: 'class' });
      if (!r.found) return { pass: false, found: false };
      return { pass: has(r.v ?? '', expected), found: true, received: show(r.v ?? '') };
    });
  }

  async toHaveId(expected: string | RegExp, options: ExpectOptions = {}): Promise<void> {
    await this.run({ name: 'toHaveId', arg: 'expected', expected: show(expected) }, options, async () => {
      const r = await this.peekEl<string | null>('expect.toHaveId', 'attr', { name: 'id' });
      if (!r.found) return { pass: false, found: false };
      return { pass: textMatch(r.v ?? '', expected, { normalize: false }), found: true, received: show(r.v ?? '') };
    });
  }

  async toHaveCSS(name: string, value: string | RegExp, options: ExpectOptions = {}): Promise<void> {
    await this.run({ name: 'toHaveCSS', arg: 'expected', expected: show(value) }, options, async () => {
      const r = await this.peekEl<string>('expect.toHaveCSS', 'css', { name });
      if (!r.found) return { pass: false, found: false };
      return { pass: textMatch(r.v ?? '', value, { normalize: false }), found: true, received: show(r.v) };
    });
  }

  async toHaveJSProperty(name: string, value: unknown, options: ExpectOptions = {}): Promise<void> {
    await this.run({ name: 'toHaveJSProperty', arg: 'expected', expected: show(value) }, options, async () => {
      const r = await this.peekEl<unknown>('expect.toHaveJSProperty', 'prop', { name });
      if (!r.found) return { pass: false, found: false };
      return { pass: isDeepStrictEqual(r.v, value), found: true, received: show(r.v) };
    });
  }

  async toHaveRole(role: string, options: ExpectOptions = {}): Promise<void> {
    await this.run({ name: 'toHaveRole', arg: 'expected', expected: show(role) }, options, async () => {
      const r = await this.peekEl<string>('expect.toHaveRole', 'role');
      if (!r.found) return { pass: false, found: false };
      return { pass: r.v === role, found: true, received: show(r.v) };
    });
  }

  async toHaveAccessibleName(name: string | RegExp, options: ExpectOptions & { ignoreCase?: boolean } = {}): Promise<void> {
    await this.run({ name: 'toHaveAccessibleName', arg: 'expected', expected: show(name) }, options, async () => {
      const r = await this.peekEl<string>('expect.toHaveAccessibleName', 'name');
      if (!r.found) return { pass: false, found: false };
      return { pass: textMatch(r.v ?? '', name, { ignoreCase: options.ignoreCase }), found: true, received: show(r.v) };
    });
  }

  async toHaveAccessibleDescription(description: string | RegExp, options: ExpectOptions & { ignoreCase?: boolean } = {}): Promise<void> {
    await this.run({ name: 'toHaveAccessibleDescription', arg: 'expected', expected: show(description) }, options, async () => {
      const r = await this.peekEl<string>('expect.toHaveAccessibleDescription', 'description');
      if (!r.found) return { pass: false, found: false };
      return { pass: textMatch(r.v ?? '', description, { ignoreCase: options.ignoreCase }), found: true, received: show(r.v) };
    });
  }

  async toHaveCount(count: number, options: ExpectOptions = {}): Promise<void> {
    await this.run({ name: 'toHaveCount', arg: 'expected', expected: String(count) }, options, async () => {
      const n = await this.locator.count();
      return { pass: n === count, found: true, received: String(n), log: resolvedLog(n) };
    });
  }

  /**
   * The element's accessibility subtree matches a template. See
   * src/aria.ts for the format; `locator.ariaSnapshot()` prints the
   * current tree in it, ready to paste and trim.
   */
  async toMatchAriaSnapshot(template: string, options: ExpectOptions = {}): Promise<void> {
    const parsed = parseTemplate(template);
    await this.run({ name: 'toMatchAriaSnapshot', arg: 'expected', expected: `\n${template.trim()}\n` }, options, async () => {
      const { snap, refs } = await this.locator.resolveScope(1_000);
      if (refs.length === 0) return { pass: false, found: false };
      return { pass: matchesTemplate(snap, refs, parsed), found: true, received: `\n${renderSnapshot(snap, refs)}` };
    });
  }

  /**
   * The element looks like its stored baseline. See src/screenshot.ts
   * for where baselines live and how they are created.
   */
  async toHaveScreenshot(nameOrOptions?: string | ScreenshotOptions, options: ScreenshotOptions = {}): Promise<void> {
    if (this.negated) throw new Error('toHaveScreenshot cannot be negated');
    const name = typeof nameOrOptions === 'string' ? nameOrOptions : undefined;
    const opts = typeof nameOrOptions === 'object' ? nameOrOptions : options;
    await assertScreenshot(
      () => this.locator.screenshot({ timeout: 2_000 }),
      name,
      opts,
      opts.timeout ?? this.defaultTimeout,
      this.locator.toString(),
    );
  }
}

const notAResponse = async (): Promise<never> => {
  throw new Error('toBeOK can be only used with APIResponse object');
};

export class PageAssertions {
  /** Only APIResponse has toBeOK; Playwright says so for anything else. */
  toBeOK = notAResponse;

  private readonly page: Page;
  private readonly negated: boolean;
  private readonly defaultTimeout: number;
  private readonly custom: string | undefined;

  constructor(page: Page, negated = false, defaultTimeout = 5_000, custom?: string) {
    this.page = page;
    this.negated = negated;
    this.defaultTimeout = defaultTimeout;
    this.custom = custom;
  }

  get not(): PageAssertions {
    return new PageAssertions(this.page, !this.negated, this.defaultTimeout, this.custom);
  }

  private run(spec: Spec, options: ExpectOptions | undefined, sample: () => Promise<Sample>): Promise<void> {
    return poll('page', null, spec, this.negated, options?.timeout ?? this.defaultTimeout, this.custom, sample);
  }

  /** The page URL equals the string (resolved against baseURL), matches the RegExp, or satisfies the predicate. */
  async toHaveURL(
    expected: string | RegExp | ((url: URL) => boolean) | { test(url: string): boolean },
    options: ExpectOptions & { ignoreCase?: boolean } = {},
  ): Promise<void> {
    const pattern = typeof expected === 'object' && !(expected instanceof RegExp) && typeof (expected as { test?: unknown }).test === 'function';
    if (typeof expected !== 'string' && typeof expected !== 'function' && !(expected instanceof RegExp) && !pattern) {
      const not = this.negated ? 'not.' : '';
      throw new ExpectError(
        `expect(page).${not}toHaveURL(expected) failed\n\nError: expected value must be a string or regular expression\nExpected has type:  ${typeof expected}\nExpected has value: ${JSON.stringify(expected)}\n`,
        'toHaveURL',
        !this.negated,
        [],
        0,
      );
    }
    const want =
      typeof expected === 'string' && this.page.baseURL ? new URL(expected, this.page.baseURL).href : expected;
    const label =
      typeof want === 'function' ? (this.negated ? 'predicate to fail' : 'predicate to succeed') : pattern ? 'URLPattern' : show(want);
    const spec: Spec = { name: 'toHaveURL', arg: 'expected', expected: label };
    await this.run(spec, options, async () => {
      const url = await this.page.url();
      const pass =
        typeof want === 'function'
          ? !!(await want(new URL(url)))
          : pattern
            ? (want as { test(u: string): boolean }).test(url)
            : textMatch(url, want as string | RegExp, { normalize: false, ignoreCase: options.ignoreCase });
      return { pass, found: true, received: show(url) };
    });
  }

  /** The document title equals the string (whitespace-normalized) or matches the RegExp. */
  async toHaveTitle(expected: string | RegExp, options: ExpectOptions = {}): Promise<void> {
    await this.run({ name: 'toHaveTitle', arg: 'expected', expected: show(expected) }, options, async () => {
      const title = await this.page.title();
      return { pass: textMatch(title, expected, {}), found: true, received: show(title) };
    });
  }

  /** The whole page's accessibility tree matches a template (see LocatorAssertions.toMatchAriaSnapshot). */
  async toMatchAriaSnapshot(template: string, options: ExpectOptions = {}): Promise<void> {
    const parsed = parseTemplate(template);
    await this.run({ name: 'toMatchAriaSnapshot', arg: 'expected', expected: `\n${template.trim()}\n` }, options, async () => {
      const snap = await this.page.view();
      return { pass: matchesTemplate(snap, snap.roots, parsed), found: true, received: `\n${renderSnapshot(snap, snap.roots)}` };
    });
  }

  /** The page looks like its stored baseline (see LocatorAssertions.toHaveScreenshot). */
  async toHaveScreenshot(nameOrOptions?: string | ScreenshotOptions, options: ScreenshotOptions = {}): Promise<void> {
    if (this.negated) throw new Error('toHaveScreenshot cannot be negated');
    const name = typeof nameOrOptions === 'string' ? nameOrOptions : undefined;
    const opts = typeof nameOrOptions === 'object' ? nameOrOptions : options;
    await assertScreenshot(
      () => this.page.screenshot(opts.fullPage ? { fullPage: true } : {}),
      name,
      opts,
      opts.timeout ?? this.defaultTimeout,
      'page',
    );
  }
}

export class ResponseAssertions {
  private readonly response: APIResponse;
  private readonly negated: boolean;

  constructor(response: APIResponse, negated = false) {
    this.response = response;
    this.negated = negated;
  }

  get not(): ResponseAssertions {
    return new ResponseAssertions(this.response, !this.negated);
  }

  /** Status in the 2xx range. */
  async toBeOK(): Promise<void> {
    const ok = this.response.ok();
    if (ok !== this.negated) return;
    const not = this.negated ? 'not.' : '';
    let text = '';
    if (!ok) {
      const type = this.response.headers()['content-type'] ?? '';
      if (/text|json|xml|javascript/.test(type)) text = await this.response.text().catch(() => '');
    }
    const lines = [
      `expect(response).${not}toBeOK() failed`,
      '',
      `→ GET ${this.response.url()}`,
      `← ${this.response.status()} ${this.response.statusText()}`,
    ];
    if (text) lines.push('', `Response text:\n${text.slice(0, 1000)}`);
    throw new ExpectError(lines.join('\n'), 'toBeOK', ok, [], 0);
  }
}

type AnyAssertions = LocatorAssertions | PageAssertions | ResponseAssertions | ValueAssertions;

interface ExpectConfig {
  timeout?: number;
  soft?: boolean;
  message?: string;
}

/** Record a soft failure on the running test, or throw when there is none. */
function softly<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, recv) {
      const v = Reflect.get(obj, prop, recv);
      if (prop === 'not') return softly(v as object);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        const record = (e: unknown) => {
          const info = currentTestInfo();
          if (!info) throw e;
          info.softErrors.push(e);
        };
        try {
          const r = (v as (...a: unknown[]) => unknown).apply(obj, args);
          return r instanceof Promise ? r.catch(record) : r;
        } catch (e) {
          record(e);
          return undefined;
        }
      };
    },
  });
}

export interface Expect {
  (target: Locator, message?: string): LocatorAssertions;
  (target: Page, message?: string): PageAssertions;
  (target: APIResponse, message?: string): ResponseAssertions;
  (target: unknown, message?: string): ValueAssertions;
  poll: (fn: () => unknown, options?: { timeout?: number; intervals?: number[]; message?: string }) => ValueAssertions;
  soft: Expect;
  configure: (config: ExpectConfig) => Expect;
  any: typeof asymmetric.any;
  anything: typeof asymmetric.anything;
  stringContaining: typeof asymmetric.stringContaining;
  stringMatching: typeof asymmetric.stringMatching;
  objectContaining: typeof asymmetric.objectContaining;
  arrayContaining: typeof asymmetric.arrayContaining;
}

function makeExpect(config: ExpectConfig): Expect {
  const fn = ((target: unknown, message?: string | { message?: string }): AnyAssertions => {
    const custom = (typeof message === 'string' ? message : message?.message) ?? config.message;
    let a: AnyAssertions;
    if (target instanceof Locator) {
      a = new LocatorAssertions(target, false, config.timeout ?? target.expectTimeout, custom);
    } else if (target instanceof Page) {
      a = new PageAssertions(target, false, config.timeout ?? target.timeouts.expect, custom);
    } else if (target instanceof APIResponse) {
      a = new ResponseAssertions(target);
    } else {
      a = new ValueAssertions(target);
    }
    return config.soft ? softly(a) : a;
  }) as Expect;
  fn.poll = (pollFn, options = {}) =>
    pollAssertions(pollFn, options.timeout ?? config.timeout ?? 5_000, options.intervals ?? [100, 250, 500, 1000]) as ValueAssertions;
  Object.defineProperty(fn, 'soft', { get: () => makeExpect({ ...config, soft: true }) });
  fn.configure = (more) => makeExpect({ ...config, ...more });
  fn.any = asymmetric.any;
  fn.anything = asymmetric.anything;
  fn.stringContaining = asymmetric.stringContaining;
  fn.stringMatching = asymmetric.stringMatching;
  fn.objectContaining = asymmetric.objectContaining;
  fn.arrayContaining = asymmetric.arrayContaining;
  return fn;
}

export const expect: Expect = makeExpect({});
