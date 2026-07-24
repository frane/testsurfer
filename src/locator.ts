/**
 * Locators: lazy, re-resolving element handles over the a11y tree.
 *
 * A locator stores a query (role + name, text, or label), not a ref.
 * Every action and assertion re-resolves the query against a fresh
 * view, so locators survive re-renders and navigation. Actions retry
 * on STALE_TOKEN and NOT_FOUND until the action timeout elapses.
 */

import { StrictModeError, TimeoutError, WireError } from './errors.ts';
import { isHidden, walk, type Snapshot, type TreeNode } from './tree.ts';
import type { Page } from './page.ts';

/** ARIA role names accepted by getByRole, mapped to wire role codes. */
const ROLE_TO_CODES: Record<string, string[]> = {
  document: ['doc'],
  button: ['btn'],
  link: ['lnk'],
  textbox: ['tf', 'ta'],
  combobox: ['sel'],
  checkbox: ['chk'],
  radio: ['rad'],
  img: ['img'],
  image: ['img'],
  heading: ['hd'],
  paragraph: ['p'],
  listitem: ['li'],
  list: ['lst'],
  table: ['tbl'],
  row: ['row'],
  cell: ['cell'],
  columnheader: ['hdr'],
  navigation: ['nav'],
  form: ['frm'],
  dialog: ['dlg'],
  menuitem: ['itm'],
  tab: ['itm'],
  option: ['itm'],
  region: ['sec'],
  article: ['art'],
  menu: ['mn'],
};

const FIELD_CODES = new Set(['tf', 'ta', 'sel', 'chk', 'rad']);

export interface ByRoleOptions {
  /** Accessible name. String: whole-string, case-insensitive (case-sensitive with exact). RegExp: tested as-is. */
  name?: string | RegExp;
  exact?: boolean;
  /** Heading level, matched against the node's level attribute. */
  level?: number;
}

export interface ByTextOptions {
  /** String matching is substring, case-insensitive; exact makes it whole-string, case-sensitive. */
  exact?: boolean;
}

export type LocatorQuery =
  | { kind: 'role'; role: string; options: ByRoleOptions }
  | { kind: 'text'; text: string | RegExp; options: ByTextOptions }
  | { kind: 'label'; text: string | RegExp; options: ByTextOptions };

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

function matchesName(label: string, expected: string | RegExp, exact: boolean): boolean {
  const norm = normalize(label);
  if (expected instanceof RegExp) return expected.test(norm);
  const want = normalize(expected);
  return exact ? norm === want : norm.toLowerCase() === want.toLowerCase();
}

function matchesText(label: string, expected: string | RegExp, exact: boolean): boolean {
  const norm = normalize(label);
  if (expected instanceof RegExp) return expected.test(norm);
  const want = normalize(expected);
  return exact ? norm === want : norm.toLowerCase().includes(want.toLowerCase());
}

function matchesQuery(node: TreeNode, query: LocatorQuery): boolean {
  switch (query.kind) {
    case 'role': {
      const codes = ROLE_TO_CODES[query.role] ?? [query.role];
      if (!codes.includes(node.role)) return false;
      const { name, exact = false, level } = query.options;
      if (level !== undefined && node.attrs['level'] !== String(level)) return false;
      if (name !== undefined && !matchesName(node.label, name, exact)) return false;
      return true;
    }
    case 'text':
      return node.label !== '' && matchesText(node.label, query.text, query.options.exact ?? false);
    case 'label':
      return (
        FIELD_CODES.has(node.role) &&
        matchesText(node.label, query.text, query.options.exact ?? false)
      );
  }
}

export function describeQuery(query: LocatorQuery): string {
  switch (query.kind) {
    case 'role':
      return `getByRole(${JSON.stringify(query.role)}${
        query.options.name !== undefined ? `, { name: ${String(query.options.name)} }` : ''
      })`;
    case 'text':
      return `getByText(${String(query.text)})`;
    case 'label':
      return `getByLabel(${String(query.text)})`;
  }
}

export function findMatches(snap: Snapshot, query: LocatorQuery): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of walk(snap)) {
    if (matchesQuery(node, query)) out.push(node);
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const POLL_MS = 30;

/** Drop hid-marked matches when at least one unmarked match exists. */
function preferVisible(snap: Snapshot, all: TreeNode[]): TreeNode[] {
  const visible = all.filter((n) => !isHidden(snap, n));
  return visible.length > 0 ? visible : all;
}

export class Locator {
  private readonly page: Page;
  private readonly query: LocatorQuery;
  private readonly index: number | null;

  constructor(page: Page, query: LocatorQuery, index: number | null = null) {
    this.page = page;
    this.query = query;
    this.index = index;
  }

  /** The owning page's expect timeout, used as the assertion default. */
  get expectTimeout(): number {
    return this.page.timeouts.expect;
  }

  /** Pick the first match instead of failing on multiple matches. */
  first(): Locator {
    return this.nth(0);
  }

  /** Pick the i-th match (0-based) instead of failing on multiple matches. */
  nth(index: number): Locator {
    return new Locator(this.page, this.query, index);
  }

  toString(): string {
    const base = describeQuery(this.query);
    return this.index === null ? base : `${base}.nth(${this.index})`;
  }

  /**
   * All current matches against a fresh view. Visible matches are
   * preferred, judged from the tree alone (hid=1 on self or ancestor):
   * hidden duplicates of interactive elements are dropped when a
   * visible one exists. No layout round trip.
   */
  async resolveAll(): Promise<TreeNode[]> {
    const snap = await this.page.view();
    return preferVisible(snap, findMatches(snap, this.query));
  }

  /**
   * Matches that are currently visible. Interactive refs carry hid=1
   * in the tree, but hidden non-interactive elements (a heading inside
   * a `hidden` container) do not, so survivors are verified against
   * vs_layout's per-ref visible flag.
   */
  async resolveVisible(): Promise<TreeNode[]> {
    const snap = await this.page.view();
    const candidates = findMatches(snap, this.query).filter((n) => !isHidden(snap, n));
    if (candidates.length === 0) return [];
    const rects = await this.page.layout(candidates.map((n) => n.ref));
    return candidates.filter((n) => rects.get(n.ref)?.visible === true);
  }

  /** Strict-mode selection: exactly one node, nth() overrides, null when none. */
  private pickOne(matches: TreeNode[]): TreeNode | null {
    if (this.index !== null) return matches[this.index] ?? null;
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      const list = matches
        .slice(0, 5)
        .map((m) => `  ref=${m.ref} ${m.role} ${JSON.stringify(m.label)}`)
        .join('\n');
      throw new StrictModeError(
        `${this.toString()} matched ${matches.length} elements:\n${list}\nNarrow the query or use .first() / .nth(i).`,
      );
    }
    return matches[0] ?? null;
  }

  /**
   * Resolve an action target against the cached snapshot when it is
   * still baseline-synced. Optimistic concurrency covers the race: if
   * the page changed since, the act fails with STALE_TOKEN, the retry
   * loop refreshes, and we re-resolve.
   */
  private async resolveForAction(): Promise<TreeNode | null> {
    const snap = await this.page.actionSnapshot();
    return this.pickOne(preferVisible(snap, findMatches(snap, this.query)));
  }

  /** Wait until the locator resolves to one node, then run the action, retrying on staleness. */
  private async withResolved<T>(
    actionName: string,
    action: (node: TreeNode) => Promise<T>,
    timeout?: number,
  ): Promise<T> {
    const budget = timeout ?? this.page.timeouts.action;
    const deadline = Date.now() + budget;
    let lastNote = 'no matching element';
    for (;;) {
      let stale = false;
      try {
        const node = await this.resolveForAction();
        if (node) return await action(node);
      } catch (e) {
        if (e instanceof WireError && (e.code === 'STALE_TOKEN' || e.code === 'NOT_FOUND')) {
          lastNote = `retrying after ${e.code}`;
          stale = true;
        } else {
          throw e;
        }
      }
      if (Date.now() >= deadline) {
        throw new TimeoutError(`${actionName} on ${this.toString()} timed out after ${budget}ms (${lastNote})`);
      }
      // A staleness rejection means the page just changed; retry
      // immediately against a fresh view. Only a missing element earns
      // a poll-tick sleep.
      if (!stale) await sleep(POLL_MS);
    }
  }

  /**
   * Click the element. Visible targets get a trusted native click at
   * their rect center via vs_click_at, which honors the page's input
   * mode (robotic by default; the humanized path behind plain
   * `vs_act click` costs seconds per click). Zero-size or hidden
   * targets cannot be hit by coordinates and fall back to vs_act,
   * whose JS path dispatches regardless of geometry.
   */
  async click(options?: { timeout?: number }): Promise<void> {
    await this.withResolved(
      'click',
      async (n) => {
        const rects = await this.page.layout([n.ref]);
        const r = rects.get(n.ref);
        if (r && r.visible && r.w > 1 && r.h > 1) {
          await this.page.clickAt(r.x + r.w / 2, r.y + r.h / 2);
        } else {
          await this.page.act(n.ref, 'click');
        }
      },
      options?.timeout,
    );
  }

  /** Replace the field's text via the engine's fill path. */
  async fill(value: string, options?: { timeout?: number }): Promise<void> {
    await this.withResolved('fill', (n) => this.page.act(n.ref, 'fill', value), options?.timeout);
  }

  /**
   * Focus the element, then send real per-character key events
   * (isTrusted=true). Needs vibesurfer's trusted typing support (macOS
   * today); rejects with ENGINE_UNSUPPORTED elsewhere. Use fill() for
   * plain inputs.
   */
  async type(text: string, options?: { timeout?: number }): Promise<void> {
    await this.withResolved(
      'type',
      async (n) => {
        await this.page.act(n.ref, 'focus');
        await this.page.typeTrusted(text);
      },
      options?.timeout,
    );
  }

  /** Send a key chord to the element, e.g. `Enter` or `Ctrl+K`. */
  async press(key: string, options?: { timeout?: number }): Promise<void> {
    await this.withResolved('press', (n) => this.page.act(n.ref, 'key', key), options?.timeout);
  }

  async hover(options?: { timeout?: number }): Promise<void> {
    await this.withResolved('hover', (n) => this.page.act(n.ref, 'hover'), options?.timeout);
  }

  async focus(options?: { timeout?: number }): Promise<void> {
    await this.withResolved('focus', (n) => this.page.act(n.ref, 'focus'), options?.timeout);
  }

  /** Full text content of the element via vs_read. */
  async textContent(options?: { timeout?: number }): Promise<string> {
    return this.withResolved('textContent', (n) => this.page.readRef(n.ref), options?.timeout);
  }

  /** Number of current matches (no waiting). */
  async count(): Promise<number> {
    return (await this.resolveAll()).length;
  }
}
