/**
 * Web-first assertions. Every matcher polls against fresh views until
 * it passes or the expect timeout elapses, so tests never race the
 * page. Negate with `.not`.
 */

import { matchesTemplate, parseTemplate, renderSnapshot } from './aria.ts';
import { TimeoutError } from './errors.ts';
import { Locator } from './locator.ts';
import { Page } from './page.ts';

export interface ExpectOptions {
  timeout?: number;
}

const POLL_MS = 10;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

function textMatches(actual: string, expected: string | RegExp, substring: boolean): boolean {
  const norm = normalize(actual);
  if (expected instanceof RegExp) return expected.test(norm);
  const want = normalize(expected);
  return substring ? norm.includes(want) : norm === want;
}

/**
 * Poll `check` until it returns true or the budget elapses. `describe`
 * renders the failure message with the last observed state.
 */
async function poll(
  budget: number,
  negated: boolean,
  check: () => Promise<{ pass: boolean; actual: string }>,
  describe: (actual: string) => string,
): Promise<void> {
  const deadline = Date.now() + budget;
  let lastActual = '<no observation>';
  let lastError: unknown = null;
  for (;;) {
    try {
      const { pass, actual } = await check();
      lastActual = actual;
      lastError = null;
      if (pass !== negated) return;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  if (lastError) throw lastError;
  throw new TimeoutError(`${describe(lastActual)} (waited ${budget}ms)`);
}

export class LocatorAssertions {
  private readonly locator: Locator;
  private readonly negated: boolean;
  private readonly defaultTimeout: number;

  constructor(locator: Locator, negated = false, defaultTimeout = 5_000) {
    this.locator = locator;
    this.negated = negated;
    this.defaultTimeout = defaultTimeout;
  }

  get not(): LocatorAssertions {
    return new LocatorAssertions(this.locator, !this.negated, this.defaultTimeout);
  }

  private budget(options?: ExpectOptions): number {
    return options?.timeout ?? this.defaultTimeout;
  }

  private msg(condition: string, actual: string): string {
    const wanted = this.negated ? `not to ${condition}` : `to ${condition}`;
    return `expected ${this.locator.toString()} ${wanted}, but ${actual}`;
  }

  /** At least one visible match. */
  async toBeVisible(options?: ExpectOptions): Promise<void> {
    await poll(
      this.budget(options),
      this.negated,
      async () => {
        const visible = await this.locator.resolveVisible();
        return {
          pass: visible.length > 0,
          actual: visible.length > 0 ? `found ${visible.length} visible` : 'found none visible',
        };
      },
      (actual) => this.msg('be visible', actual),
    );
  }

  /** No visible match. */
  async toBeHidden(options?: ExpectOptions): Promise<void> {
    await poll(
      this.budget(options),
      this.negated,
      async () => {
        const visible = await this.locator.resolveVisible();
        return {
          pass: visible.length === 0,
          actual: visible.length === 0 ? 'found none visible' : `found ${visible.length} visible`,
        };
      },
      (actual) => this.msg('be hidden', actual),
    );
  }

  /** The element's full text equals the expected string (or matches the RegExp). */
  async toHaveText(expected: string | RegExp, options?: ExpectOptions): Promise<void> {
    await this.textAssertion(expected, false, 'have text', options);
  }

  /** The element's full text contains the expected substring (or matches the RegExp). */
  async toContainText(expected: string | RegExp, options?: ExpectOptions): Promise<void> {
    await this.textAssertion(expected, true, 'contain text', options);
  }

  private async textAssertion(
    expected: string | RegExp,
    substring: boolean,
    condition: string,
    options?: ExpectOptions,
  ): Promise<void> {
    await poll(
      this.budget(options),
      this.negated,
      async () => {
        const matches = await this.locator.resolveAll();
        const node = matches[0];
        if (!node) return { pass: false, actual: 'no matching element' };
        const text = await this.locator.textContent({ timeout: 1_000 }).catch(() => node.label);
        return {
          pass: textMatches(text, expected, substring),
          actual: `text was ${JSON.stringify(normalize(text)).slice(0, 200)}`,
        };
      },
      (actual) => this.msg(`${condition} ${String(expected)}`, actual),
    );
  }

  /** A checked checkbox or radio (vibesurfer 0.2.12+). */
  async toBeChecked(options?: ExpectOptions): Promise<void> {
    await poll(
      this.budget(options),
      this.negated,
      async () => {
        const checked = await this.locator.isChecked({ timeout: 1_000 });
        return { pass: checked, actual: checked ? 'it was checked' : 'it was not checked' };
      },
      (actual) => this.msg('be checked', actual),
    );
  }

  /** A text field or select whose current value equals the string (or matches the RegExp). */
  async toHaveValue(expected: string | RegExp, options?: ExpectOptions): Promise<void> {
    await poll(
      this.budget(options),
      this.negated,
      async () => {
        const value = await this.locator.inputValue({ timeout: 1_000 });
        return {
          pass: textMatches(value, expected, false),
          actual: `value was ${JSON.stringify(value)}`,
        };
      },
      (actual) => this.msg(`have value ${String(expected)}`, actual),
    );
  }

  /**
   * The element's accessibility subtree matches a template. See
   * src/aria.ts for the format; `locator.ariaSnapshot()` prints the
   * current tree in it, ready to paste and trim.
   */
  async toMatchAriaSnapshot(template: string, options?: ExpectOptions): Promise<void> {
    const parsed = parseTemplate(template);
    await poll(
      this.budget(options),
      this.negated,
      async () => {
        const { snap, refs } = await this.locator.resolveScope();
        if (refs.length === 0) return { pass: false, actual: 'no matching element' };
        return {
          pass: matchesTemplate(snap, refs, parsed),
          actual: `the tree was:\n${renderSnapshot(snap, refs)}`,
        };
      },
      (actual) => this.msg(`match the aria snapshot\n${template.trim()}\n`, actual),
    );
  }

  /** Exactly `count` matches. */
  async toHaveCount(count: number, options?: ExpectOptions): Promise<void> {
    await poll(
      this.budget(options),
      this.negated,
      async () => {
        const n = await this.locator.count();
        return { pass: n === count, actual: `found ${n}` };
      },
      (actual) => this.msg(`have count ${count}`, actual),
    );
  }
}

export class PageAssertions {
  private readonly page: Page;
  private readonly negated: boolean;
  private readonly defaultTimeout: number;

  constructor(page: Page, negated = false, defaultTimeout = 5_000) {
    this.page = page;
    this.negated = negated;
    this.defaultTimeout = defaultTimeout;
  }

  get not(): PageAssertions {
    return new PageAssertions(this.page, !this.negated, this.defaultTimeout);
  }

  /** The page URL equals the string (or matches the RegExp). */
  async toHaveURL(expected: string | RegExp, options?: ExpectOptions): Promise<void> {
    await poll(
      options?.timeout ?? this.defaultTimeout,
      this.negated,
      async () => {
        const url = await this.page.url();
        return { pass: textMatches(url, expected, false), actual: `URL was ${JSON.stringify(url)}` };
      },
      (actual) => `expected page ${this.negated ? 'not ' : ''}to have URL ${String(expected)}, but ${actual}`,
    );
  }

  /** The whole page's accessibility tree matches a template (see LocatorAssertions.toMatchAriaSnapshot). */
  async toMatchAriaSnapshot(template: string, options?: ExpectOptions): Promise<void> {
    const parsed = parseTemplate(template);
    await poll(
      options?.timeout ?? this.defaultTimeout,
      this.negated,
      async () => {
        const snap = await this.page.view();
        return {
          pass: matchesTemplate(snap, snap.roots, parsed),
          actual: `the tree was:\n${renderSnapshot(snap, snap.roots)}`,
        };
      },
      (actual) =>
        `expected page ${this.negated ? 'not ' : ''}to match the aria snapshot\n${template.trim()}\nbut ${actual}`,
    );
  }

  /** The document title equals the string (or matches the RegExp). */
  async toHaveTitle(expected: string | RegExp, options?: ExpectOptions): Promise<void> {
    await poll(
      options?.timeout ?? this.defaultTimeout,
      this.negated,
      async () => {
        const title = await this.page.title();
        return {
          pass: textMatches(title, expected, false),
          actual: `title was ${JSON.stringify(title)}`,
        };
      },
      (actual) =>
        `expected page ${this.negated ? 'not ' : ''}to have title ${String(expected)}, but ${actual}`,
    );
  }
}

export function expect(target: Locator): LocatorAssertions;
export function expect(target: Page): PageAssertions;
export function expect(target: Locator | Page): LocatorAssertions | PageAssertions {
  if (target instanceof Locator) {
    return new LocatorAssertions(target, false, target.expectTimeout);
  }
  return new PageAssertions(target, false, target.timeouts.expect);
}
