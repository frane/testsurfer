/**
 * Locator queries: the option types, the chain of steps a locator stores,
 * how a chain reads in error messages (Playwright's notation) and the
 * wire form the page engine (src/injected/) resolves.
 */

import { parseSelector, type CssExtras } from './selector.ts';
import { Locator } from './locator.ts';
import type { Page } from './page.ts';

export interface ByRoleOptions {
  /** Accessible name. String: case-insensitive substring (whole string and case-sensitive with exact). RegExp: tested as-is. */
  name?: string | RegExp;
  exact?: boolean;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  includeHidden?: boolean;
  /** Heading level, from h1-h6 or aria-level. */
  level?: number;
  pressed?: boolean | 'mixed';
  selected?: boolean;
  /** @internal role= selector `[name="x"]`: whole string, case-insensitive. */
  nameFull?: boolean;
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
  | { kind: 'text'; text: string | RegExp; options: ByTextOptions; light?: boolean; legacy?: boolean }
  | { kind: 'label'; text: string | RegExp; options: ByTextOptions }
  | { kind: 'css'; selector: string; extras?: CssExtras; light?: boolean }
  | { kind: 'xpath'; xpath: string }
  | { kind: 'attr'; method: string; attr: string; value: string | RegExp; exact: boolean }
  | { kind: 'and' | 'or'; left: Locator; right: Locator }
  | { kind: 'frame' }
  /** The previous step's matches themselves, so an index or filter can apply after an index. */
  | { kind: 'self' }
  /** A held element (ElementHandle). */
  | { kind: 'handle'; id: number }
  /** A selector that failed to parse; resolving it throws `message`. */
  | { kind: 'invalid'; selector: string; message: string };

/** One link of a chain: a query, its filters, and an optional index. */
export interface Step {
  query: LocatorQuery;
  filters: FilterOptions[];
  /** nth() index; negative counts from the end (last() is -1). */
  index: number | null;
  /** The marked part of a `*css=` capture selector. */
  capture?: boolean;
}

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
    case 'handle':
      return 'ElementHandle';
  }
}

export function describeFilter(f: FilterOptions): string {
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

export function wireQuery(query: LocatorQuery): Record<string, unknown> {
  switch (query.kind) {
    case 'role': {
      const { name, exact, nameFull, ...rest } = query.options;
      const nm = name === undefined ? undefined : nameFull && typeof name === 'string' ? { s: name, full: true } : wm(name, exact);
      return { k: 'role', role: query.role, o: { ...rest, ...(nm ? { name: nm } : {}) } };
    }
    case 'text':
      return { k: 'text', t: wm(query.text, query.options.exact), light: query.light, legacy: query.legacy };
    case 'label':
      return { k: 'label', t: wm(query.text, query.options.exact) };
    case 'css':
      return { k: 'css', sel: query.selector, light: query.light };
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
    case 'handle':
      return { k: 'handle', id: query.id };
  }
}

export function wireFilter(f: FilterOptions): Record<string, unknown> {
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

export const step = (query: LocatorQuery): Step => ({ query, filters: [], index: null });

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
  const parts = parseSelector(selector);
  const at = parts.findIndex((p) => p.capture);
  if (at < 0 || at === parts.length - 1) return stepsOf(parts);
  // A capture: keep the marked part's matches that contain the rest.
  const head = stepsOf(parts.slice(0, at + 1));
  const rest = stepsOf(parts.slice(at + 1));
  const tail = head[head.length - 1]!;
  tail.filters.push({ has: new Locator(null as unknown as Page, rest) });
  tail.capture = true;
  return head;
}

function stepsOf(parts: ReturnType<typeof parseSelector>): Step[] {
  const steps: Step[] = [];
  const last = (what: string): Step => {
    const s = steps[steps.length - 1];
    if (!s) throw new Error(`"${what}" cannot start a selector`);
    return s;
  };
  for (const p of parts) {
    switch (p.kind) {
      case 'nth':
        last('nth=').index = p.index;
        break;
      case 'visible':
        last('visible=').filters.push({ visible: p.visible });
        break;
      case 'css':
        steps.push(step({ kind: 'css', selector: p.selector, ...(p.light ? { light: true } : {}) }));
        break;
      case 'xpath':
        steps.push(step(p));
        break;
      case 'text':
        steps.push(
          step({ kind: 'text', text: p.text, options: { exact: p.exact }, ...(p.light ? { light: true } : {}), ...(p.legacy ? { legacy: true } : {}) }),
        );
        break;
      case 'attr':
        steps.push(step(byAttr('locator', p.attr, p.value, true)));
        break;
      case 'role':
        steps.push(step({ kind: 'role', role: p.role, options: p.options }));
        break;
    }
  }
  if (steps.length === 0) throw new Error('empty selector');
  return steps;
}

// --- resolution ----------------------------------------------------------
