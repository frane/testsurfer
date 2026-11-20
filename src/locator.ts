/**
 * Locators: lazy, re-resolving element handles over the a11y tree.
 *
 * A locator stores a chain of queries, not a ref. Every action and
 * assertion re-resolves the chain against a fresh view, so locators
 * survive re-renders and navigation. Actions retry on STALE_TOKEN and
 * NOT_FOUND until the action timeout elapses.
 *
 * Role, text and label queries match the tree directly. CSS and
 * attribute queries (locator(), getByTestId, getByPlaceholder,
 * getByAltText, getByTitle) run in the page and map each element to
 * its tree node through the `data-vs-ref` attribute vibesurfer puts on
 * every element it reports. An element the tree does not report
 * resolves to the first reported element inside it (a wrapper div),
 * or, with nothing reported inside, to its nearest reported ancestor
 * (a span whose text the tree folded into its parent).
 */

import { StrictModeError, TimeoutError, WireError } from './errors.ts';
import { isHidden, walk, type Snapshot, type TreeNode } from './tree.ts';
import { renderSnapshot } from './aria.ts';
import { ROLE_TO_CODES } from './roles.ts';
import type { LayoutRect, Page } from './page.ts';

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

export interface FilterOptions {
  /** Keep matches whose subtree text contains this (substring, case-insensitive) or matches the RegExp. */
  hasText?: string | RegExp;
  /** Drop matches whose subtree text contains this. */
  hasNotText?: string | RegExp;
  /** Keep matches that contain an element matching this locator. */
  has?: Locator;
  /** Drop matches that contain an element matching this locator. */
  hasNot?: Locator;
  /** Keep only visible (true) or only hidden (false) matches. */
  visible?: boolean;
}

export type LocatorQuery =
  | { kind: 'role'; role: string; options: ByRoleOptions }
  | { kind: 'text'; text: string | RegExp; options: ByTextOptions }
  | { kind: 'label'; text: string | RegExp; options: ByTextOptions }
  | { kind: 'css'; selector: string }
  | { kind: 'attr'; method: string; attr: string; value: string | RegExp; exact: boolean }
  | { kind: 'and' | 'or'; left: Locator; right: Locator };

/** One link of a chain: a query, its filters, and an optional index. */
interface Step {
  query: LocatorQuery;
  filters: FilterOptions[];
  /** nth() index; negative counts from the end (last() is -1). */
  index: number | null;
}

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

/** A node's label plus, for a labelled form field, its <label> text. */
function names(node: TreeNode): string[] {
  const lbl = node.attrs['lbl'];
  return lbl ? [node.label, lbl] : [node.label];
}

export type TreeQuery = Extract<LocatorQuery, { kind: 'role' | 'text' | 'label' }>;

function matchesQuery(node: TreeNode, query: TreeQuery): boolean {
  switch (query.kind) {
    case 'role': {
      const codes = ROLE_TO_CODES[query.role] ?? [query.role];
      if (!codes.includes(node.role)) return false;
      const { name, exact = false, level } = query.options;
      if (level !== undefined && node.attrs['level'] !== String(level)) return false;
      if (name !== undefined && !names(node).some((n) => matchesName(n, name, exact))) return false;
      return true;
    }
    case 'text':
      return node.label !== '' && matchesText(node.label, query.text, query.options.exact ?? false);
    case 'label': {
      // The field's <label> text (lbl=, vibesurfer 0.2.12+) is the
      // label; aria-label lands in the node label itself.
      if (!FIELD_CODES.has(node.role)) return false;
      const exact = query.options.exact ?? false;
      return names(node).some((n) => matchesText(n, query.text, exact));
    }
  }
}

const str = (v: string | RegExp) => (v instanceof RegExp ? String(v) : JSON.stringify(v));

export function describeQuery(query: LocatorQuery): string {
  switch (query.kind) {
    case 'role':
      return `getByRole(${JSON.stringify(query.role)}${
        query.options.name !== undefined ? `, { name: ${str(query.options.name)} }` : ''
      })`;
    case 'text':
      return `getByText(${str(query.text)})`;
    case 'label':
      return `getByLabel(${str(query.text)})`;
    case 'css':
      return `locator(${JSON.stringify(query.selector)})`;
    case 'attr':
      return `${query.method}(${str(query.value)})`;
    case 'and':
    case 'or':
      return `${query.left.toString()}.${query.kind}(${query.right.toString()})`;
  }
}

function describeFilter(f: FilterOptions): string {
  const parts: string[] = [];
  if (f.hasText !== undefined) parts.push(`hasText: ${str(f.hasText)}`);
  if (f.hasNotText !== undefined) parts.push(`hasNotText: ${str(f.hasNotText)}`);
  if (f.has) parts.push(`has: ${f.has.toString()}`);
  if (f.hasNot) parts.push(`hasNot: ${f.hasNot.toString()}`);
  if (f.visible !== undefined) parts.push(`visible: ${f.visible}`);
  return `filter({ ${parts.join(', ')} })`;
}

/** Tree-query matches over the whole snapshot, in document order. */
export function findMatches(snap: Snapshot, query: TreeQuery): TreeNode[] {
  const out: TreeNode[] = [];
  for (const node of walk(snap)) {
    if (matchesQuery(node, query)) out.push(node);
  }
  return out;
}

/** Refs strictly below `node` in the tree. */
function treeDescendants(snap: Snapshot, node: TreeNode, into: Set<number>): void {
  for (const c of node.children) {
    into.add(c);
    const child = snap.nodes.get(c);
    if (child) treeDescendants(snap, child, into);
  }
}

const orderCache = new WeakMap<Snapshot, Map<number, number>>();
function docOrder(snap: Snapshot): Map<number, number> {
  let m = orderCache.get(snap);
  if (!m) {
    m = new Map();
    let i = 0;
    for (const n of walk(snap)) m.set(n.ref, i++);
    orderCache.set(snap, m);
  }
  return m;
}

/**
 * Matches of one resolution pass. `inner` holds, for a match found by
 * a DOM query, the refs inside its element: that is the scope a chained
 * query searches.
 */
interface Found {
  nodes: TreeNode[];
  inner: Map<number, number[]>;
}

/** Page-side collector: element -> [target ref, refs inside]. */
const COLLECT_JS =
  `function(els){var out=[];for(var i=0;i<els.length;i++){var el=els[i];` +
  `var inner=[].map.call(el.querySelectorAll('[data-vs-ref]'),function(e){return +e.getAttribute('data-vs-ref')});` +
  `var t=el.getAttribute('data-vs-ref');var up=0;if(t!==null){t=+t;}else if(inner.length){t=inner[0];}` +
  `else{var a=el.parentElement;while(a&&!a.hasAttribute('data-vs-ref'))a=a.parentElement;if(!a)continue;t=+a.getAttribute('data-vs-ref');up=1;}` +
  `out.push([t,inner,up]);}return out;}`;

function domQueryJs(query: Extract<LocatorQuery, { kind: 'css' | 'attr' }>): string {
  if (query.kind === 'css') {
    return `(function(){var c=${COLLECT_JS};return c(document.querySelectorAll(${JSON.stringify(query.selector)}));})()`;
  }
  const v = query.value;
  const test =
    v instanceof RegExp
      ? `var re=new RegExp(${JSON.stringify(v.source)},${JSON.stringify(v.flags.replace('g', ''))});var ok=function(s){return re.test(n(s));};`
      : query.exact
        ? `var w=n(${JSON.stringify(v)});var ok=function(s){return n(s)===w;};`
        : `var w=n(${JSON.stringify(v)}).toLowerCase();var ok=function(s){return n(s).toLowerCase().indexOf(w)>=0;};`;
  return (
    `(function(){var c=${COLLECT_JS};var n=function(s){return String(s).replace(/\\s+/g,' ').trim();};${test}` +
    `var a=${JSON.stringify(query.attr)};var all=document.querySelectorAll('['+CSS.escape(a)+']');var els=[];` +
    `for(var i=0;i<all.length;i++){if(ok(all[i].getAttribute(a)))els.push(all[i]);}return c(els);})()`
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const POLL_MS = 10;

/** Drop hid-marked matches when at least one unmarked match exists. */
function preferVisible(snap: Snapshot, all: TreeNode[]): TreeNode[] {
  const visible = all.filter((n) => !isHidden(snap, n));
  return visible.length > 0 ? visible : all;
}

function pickIndex<T>(items: T[], index: number): T[] {
  const item = index < 0 ? items[items.length + index] : items[index];
  return item === undefined ? [] : [item];
}

interface DomState {
  disabled: boolean;
  editable: boolean;
  focused: boolean;
}

export function byAttr(method: string, attr: string, value: string | RegExp, exact: boolean): LocatorQuery {
  return { kind: 'attr', method, attr, value, exact };
}

export class Locator {
  private readonly page: Page;
  private readonly steps: Step[];
  /** Refs from the previous visibility resolve, used as the composite layout hint. */
  private layoutHint: number[] = [];

  constructor(page: Page, steps: Step[] | LocatorQuery) {
    this.page = page;
    this.steps = Array.isArray(steps) ? steps : [{ query: steps, filters: [], index: null }];
  }

  /** The owning page's expect timeout, used as the assertion default. */
  get expectTimeout(): number {
    return this.page.timeouts.expect;
  }

  private get tail(): Step {
    const s = this.steps[this.steps.length - 1];
    if (!s) throw new Error('empty locator');
    return s;
  }

  private get index(): number | null {
    return this.tail.index;
  }

  private withTail(change: Partial<Step>): Locator {
    return new Locator(this.page, [...this.steps.slice(0, -1), { ...this.tail, ...change }]);
  }

  private chain(query: LocatorQuery): Locator {
    return new Locator(this.page, [...this.steps, { query, filters: [], index: null }]);
  }

  // --- building -------------------------------------------------------

  /** Pick the first match instead of failing on multiple matches. */
  first(): Locator {
    return this.nth(0);
  }

  /** Pick the last match. */
  last(): Locator {
    return this.nth(-1);
  }

  /** Pick the i-th match (0-based; negative counts from the end). */
  nth(index: number): Locator {
    return this.withTail({ index });
  }

  /** Narrow the matches by text, by a contained element, or by visibility. */
  filter(options: FilterOptions): Locator {
    return this.withTail({ filters: [...this.tail.filters, options] });
  }

  /** Elements matching both this locator and `other`. */
  and(other: Locator): Locator {
    return new Locator(this.page, { kind: 'and', left: this, right: other });
  }

  /** Elements matching either this locator or `other`, in document order. */
  or(other: Locator): Locator {
    return new Locator(this.page, { kind: 'or', left: this, right: other });
  }

  /** A CSS selector (or another locator) searched inside this locator's matches. */
  locator(selector: string | Locator): Locator {
    if (typeof selector !== 'string') return new Locator(this.page, [...this.steps, ...selector.steps]);
    return this.chain({ kind: 'css', selector });
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

  /** Exact match on the test-id attribute (`data-testid` unless configured otherwise). */
  getByTestId(id: string | RegExp): Locator {
    return this.chain(byAttr('getByTestId', this.page.testIdAttribute, id, true));
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

  toString(): string {
    return this.steps
      .map((s) => {
        let out = describeQuery(s.query);
        for (const f of s.filters) out += `.${describeFilter(f)}`;
        if (s.index !== null) out += s.index === -1 ? '.last()' : `.nth(${s.index})`;
        return out;
      })
      .join('.');
  }

  // --- resolving ------------------------------------------------------

  /** Candidates for one query inside `scope` (null: the whole page). */
  private async candidates(
    snap: Snapshot,
    query: LocatorQuery,
    scope: Set<number> | null,
    owners: Set<number>,
  ): Promise<Found> {
    const inScope = (n: TreeNode) => scope === null || scope.has(n.ref);
    switch (query.kind) {
      case 'role':
      case 'text':
      case 'label':
        return { nodes: findMatches(snap, query).filter(inScope), inner: new Map() };
      case 'css':
      case 'attr': {
        const rows = await this.page.evaluate<[number, number[], number][] | null>(domQueryJs(query));
        const nodes: TreeNode[] = [];
        const inner = new Map<number, number[]>();
        for (const [ref, refs, up] of rows ?? []) {
          const node = snap.nodes.get(ref);
          // An element mapped up to its ancestor may land on the
          // element the chain is searching inside.
          const ok = node !== undefined && (inScope(node) || (up === 1 && owners.has(ref)));
          if (!node || !ok || inner.has(ref)) continue;
          nodes.push(node);
          inner.set(ref, refs);
        }
        return { nodes, inner };
      }
      case 'and': {
        const a = await query.left.matchIn(snap, scope);
        const b = new Set((await query.right.matchIn(snap, scope)).nodes.map((n) => n.ref));
        return { nodes: a.nodes.filter((n) => b.has(n.ref)), inner: a.inner };
      }
      case 'or': {
        const a = await query.left.matchIn(snap, scope);
        const b = await query.right.matchIn(snap, scope);
        const seen = new Map<number, TreeNode>();
        for (const n of [...a.nodes, ...b.nodes]) seen.set(n.ref, n);
        const order = docOrder(snap);
        const nodes = [...seen.values()].sort((x, y) => (order.get(x.ref) ?? 0) - (order.get(y.ref) ?? 0));
        return { nodes, inner: new Map([...b.inner, ...a.inner]) };
      }
    }
  }

  /** What a chained query searches inside `nodes`. */
  private static scopeOf(snap: Snapshot, found: Found, nodes: TreeNode[]): Set<number> {
    const scope = new Set<number>();
    for (const n of nodes) {
      treeDescendants(snap, n, scope);
      for (const r of found.inner.get(n.ref) ?? []) {
        if (r === n.ref) continue;
        scope.add(r);
        const node = snap.nodes.get(r);
        if (node) treeDescendants(snap, node, scope);
      }
    }
    return scope;
  }

  private async applyFilter(snap: Snapshot, found: Found, f: FilterOptions): Promise<TreeNode[]> {
    let nodes = found.nodes;
    const subtree = (n: TreeNode) => Locator.scopeOf(snap, found, [n]);
    const text = (n: TreeNode) =>
      [n.label, ...[...subtree(n)].map((r) => snap.nodes.get(r)?.label ?? '')].filter(Boolean).join(' ');
    if (f.hasText !== undefined) {
      const want = f.hasText;
      nodes = nodes.filter((n) => matchesText(text(n), want, false));
    }
    if (f.hasNotText !== undefined) {
      const want = f.hasNotText;
      nodes = nodes.filter((n) => !matchesText(text(n), want, false));
    }
    if (f.has || f.hasNot) {
      const kept: TreeNode[] = [];
      for (const n of nodes) {
        const scope = subtree(n);
        if (f.has && (await f.has.matchIn(snap, scope)).nodes.length === 0) continue;
        if (f.hasNot && (await f.hasNot.matchIn(snap, scope)).nodes.length > 0) continue;
        kept.push(n);
      }
      nodes = kept;
    }
    if (f.visible !== undefined) {
      const shown = nodes.filter((n) => !isHidden(snap, n));
      const rects: Map<number, LayoutRect> =
        shown.length > 0 ? await this.page.layout(shown.map((n) => n.ref)) : new Map();
      const isShown = (n: TreeNode) => !isHidden(snap, n) && rects.get(n.ref)?.visible === true;
      nodes = nodes.filter((n) => isShown(n) === f.visible);
    }
    return nodes;
  }

  /**
   * Matches of the whole chain inside `scope`. Each step searches the
   * previous step's matches. The outermost locator's own index is left
   * to the caller (strict mode or count); inside a nested locator
   * (has:, and/or) it applies here.
   */
  async matchIn(snap: Snapshot, scope: Set<number> | null): Promise<Found> {
    let current = scope;
    let owners = new Set<number>();
    let found: Found = { nodes: [], inner: new Map() };
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i];
      if (!step) break;
      found = await this.candidates(snap, step.query, current, owners);
      for (const f of step.filters) found = { ...found, nodes: await this.applyFilter(snap, found, f) };
      if (i === this.steps.length - 1) {
        if (scope !== null && step.index !== null) found = { ...found, nodes: pickIndex(found.nodes, step.index) };
        break;
      }
      const picked = step.index === null ? found.nodes : pickIndex(found.nodes, step.index);
      current = Locator.scopeOf(snap, found, picked);
      owners = new Set(picked.map((n) => n.ref));
    }
    return found;
  }

  /**
   * All current matches against a fresh view. Visible matches are
   * preferred, judged from the tree alone (hid=1 on self or ancestor):
   * hidden duplicates of interactive elements are dropped when a
   * visible one exists. No layout round trip.
   */
  async resolveAll(): Promise<TreeNode[]> {
    const snap = await this.page.view();
    return preferVisible(snap, (await this.matchIn(snap, null)).nodes);
  }

  /**
   * Matches that are currently visible. Interactive refs carry hid=1
   * in the tree, but hidden non-interactive elements (a heading inside
   * a `hidden` container) do not, so survivors are verified against
   * vs_layout's per-ref visible flag.
   */
  async resolveVisible(): Promise<TreeNode[]> {
    // Polling assertions resolve the same query repeatedly; the ref
    // set from the previous poll rides along as a --layout composite
    // hint, making the steady-state poll a single round trip. Refs
    // that changed since last time are fetched separately.
    const { snap, rects } = await this.page.viewWithLayout(this.layoutHint);
    const candidates = (await this.matchIn(snap, null)).nodes.filter((n) => !isHidden(snap, n));
    this.layoutHint = candidates.map((n) => n.ref);
    if (candidates.length === 0) return [];
    const missing = candidates.filter((n) => !rects.has(n.ref));
    if (missing.length > 0) {
      const more = await this.page.layout(missing.map((n) => n.ref));
      for (const [ref, rect] of more) rects.set(ref, rect);
    }
    return candidates.filter((n) => rects.get(n.ref)?.visible === true);
  }

  /** Strict-mode selection: exactly one node, nth() overrides, null when none. */
  private pickOne(matches: TreeNode[]): TreeNode | null {
    if (this.index !== null) return pickIndex(matches, this.index)[0] ?? null;
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
    return this.pickOne(preferVisible(snap, (await this.matchIn(snap, null)).nodes));
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

  // --- actions --------------------------------------------------------

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
        if (this.page.clickVia === 'act') {
          await this.page.act(n.ref, 'click', undefined, { mode: this.page.inputMode });
          return;
        }
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
   * (isTrusted=true), for rich-text editors and inputs that ignore a
   * programmatic fill. Use fill() for plain inputs.
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

  /** Click a checkbox or radio unless it is already checked. */
  async check(options?: { timeout?: number }): Promise<void> {
    if (!(await this.isChecked(options))) await this.click(options);
  }

  /** Click a checkbox unless it is already unchecked. */
  async uncheck(options?: { timeout?: number }): Promise<void> {
    if (await this.isChecked(options)) await this.click(options);
  }

  /**
   * Drag this element onto `target` with a trusted press, move and
   * release from center to center. vibesurfer also fires the HTML5
   * drag events, so native draggable and react-dnd lists see the drop.
   */
  async dragTo(target: Locator, options?: { timeout?: number }): Promise<void> {
    const from = await this.boundingBox(options);
    if (!from) throw new TimeoutError(`dragTo: ${this.toString()} is not rendered`);
    const to = await target.boundingBox(options);
    if (!to) throw new TimeoutError(`dragTo: ${target.toString()} is not rendered`);
    await this.page.mouse.drag(from.x + from.w / 2, from.y + from.h / 2, to.x + to.w / 2, to.y + to.h / 2);
  }

  // --- reading --------------------------------------------------------

  /** Full text content of the element via vs_read. */
  async textContent(options?: { timeout?: number }): Promise<string> {
    return this.withResolved('textContent', (n) => this.page.readRef(n.ref), options?.timeout);
  }

  /** Same as textContent(): the tree carries rendered text only. */
  async innerText(options?: { timeout?: number }): Promise<string> {
    return this.textContent(options);
  }

  /** Number of current matches (no waiting). */
  async count(): Promise<number> {
    return (await this.resolveAll()).length;
  }

  /** One locator per current match, in document order (no waiting). */
  async all(): Promise<Locator[]> {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  /** True if the locator has a visible match right now (no waiting). */
  async isVisible(): Promise<boolean> {
    const visible = await this.resolveVisible();
    return this.index === null ? visible.length > 0 : pickIndex(visible, this.index).length > 0;
  }

  /** True if the locator has no visible match right now (no waiting). */
  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }

  /** Checked state of a checkbox or radio, from the tree (vibesurfer 0.2.12+). */
  async isChecked(options?: { timeout?: number }): Promise<boolean> {
    return this.withResolved('isChecked', async (n) => n.attrs['checked'] === '1', options?.timeout);
  }

  /** Disabled natively (`disabled`, a disabled fieldset) or with `aria-disabled="true"`. */
  async isDisabled(options?: { timeout?: number }): Promise<boolean> {
    return (await this.domState('isDisabled', options)).disabled;
  }

  async isEnabled(options?: { timeout?: number }): Promise<boolean> {
    return !(await this.isDisabled(options));
  }

  /** An enabled, writable text control or contenteditable element. */
  async isEditable(options?: { timeout?: number }): Promise<boolean> {
    return (await this.domState('isEditable', options)).editable;
  }

  /** Whether the element has focus. */
  async isFocused(options?: { timeout?: number }): Promise<boolean> {
    return (await this.domState('isFocused', options)).focused;
  }

  /** An attribute's value, or null when absent. */
  async getAttribute(name: string, options?: { timeout?: number }): Promise<string | null> {
    return this.withResolved(
      'getAttribute',
      async (n) => {
        const got = await this.page.evaluate<{ v: string | null } | null>(
          `(function(){var e=document.querySelector('[data-vs-ref="${n.ref}"]');return e?{v:e.getAttribute(${JSON.stringify(name)})}:null;})()`,
        );
        if (!got) throw new WireError('NOT_FOUND', [`ref=${n.ref} is gone`]);
        return got.v;
      },
      options?.timeout,
    );
  }

  /** DOM state the tree does not carry. */
  private async domState(actionName: string, options?: { timeout?: number }): Promise<DomState> {
    return this.withResolved(
      actionName,
      async (n) => {
        const state = await this.page.evaluate<DomState | null>(
          `(function(){var e=document.querySelector('[data-vs-ref="${n.ref}"]');if(!e)return null;` +
            `var dis=!!(e.matches(':disabled')||e.closest('[aria-disabled="true"]'));` +
            `var tag=e.tagName;var t=(e.getAttribute('type')||'').toLowerCase();` +
            `var text=tag==='TEXTAREA'||tag==='SELECT'||(tag==='INPUT'&&['button','checkbox','radio','submit','reset','image','file','hidden','range','color'].indexOf(t)<0);` +
            `var ro=e.readOnly===true||e.getAttribute('aria-readonly')==='true';` +
            `return {disabled:dis,editable:!dis&&!ro&&(text||e.isContentEditable),focused:document.activeElement===e};})()`,
        );
        if (!state) throw new WireError('NOT_FOUND', [`ref=${n.ref} is gone`]);
        return state;
      },
      options?.timeout,
    );
  }

  /**
   * Current value of a text field or select. The tree labels a field
   * with its value; a password field reads `***` once filled.
   */
  async inputValue(options?: { timeout?: number }): Promise<string> {
    return this.withResolved('inputValue', async (n) => n.label, options?.timeout);
  }

  /** Viewport rect in CSS px, or null when the element is not rendered. */
  async boundingBox(options?: { timeout?: number }): Promise<LayoutRect | null> {
    return this.withResolved(
      'boundingBox',
      async (n) => {
        const r = (await this.page.layout([n.ref])).get(n.ref);
        return r && r.w > 0 && r.h > 0 ? r : null;
      },
      options?.timeout,
    );
  }

  /** The matched element's subtree as template text (see toMatchAriaSnapshot). */
  async ariaSnapshot(options?: { timeout?: number }): Promise<string> {
    return this.withResolved(
      'ariaSnapshot',
      async (n) => renderSnapshot(await this.page.actionSnapshot(), [n.ref]),
      options?.timeout,
    );
  }

  /** Refs of the strict-mode match, for scoping a snapshot match. */
  async resolveScope(): Promise<{ snap: Snapshot; refs: number[] }> {
    const snap = await this.page.view();
    const node = this.pickOne(preferVisible(snap, (await this.matchIn(snap, null)).nodes));
    return { snap, refs: node ? [node.ref] : [] };
  }
}
