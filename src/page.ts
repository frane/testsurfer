/**
 * A Page wraps one vibesurfer page: navigation, fresh views, token
 * management, and locator factories. Authors never see state tokens;
 * the page caches the latest one and every mutation uses it.
 */

import type { WireClient } from './client.ts';
import type { WireResponse } from './wire.ts';
import { WireError } from './errors.ts';
import { applyDelta, isDeltaBody, parseFullTree, walk, type Snapshot } from './tree.ts';
import { Locator, type ByRoleOptions, type ByTextOptions } from './locator.ts';

export interface Timeouts {
  /** Budget for actions (click, fill, ...) including auto-waiting. */
  action: number;
  /** Budget for expect() assertions. */
  expect: number;
  /** Budget for goto(). */
  navigation: number;
}

/**
 * Cursor and keyboard cadence for trusted input. `robotic` teleports
 * (fast, right for tests); `human` synthesizes a Bezier path with
 * human arrival timing (slow, right for anti-bot flows); `careful` is
 * a single-shot move in between.
 */
export type InputMode = 'human' | 'careful' | 'robotic';

/**
 * How Locator.click reaches a visible target. `click-at` resolves the
 * rect and issues a coordinate click (works against the pinned
 * vibesurfer 0.1.28, whose vs_act ignores --mode and hardcodes the
 * slow humanized path). `act` sends vs_act click --mode directly,
 * one round trip fewer; needs a 0.2+ daemon.
 */
export type ClickVia = 'click-at' | 'act';

/** Options for how the page tracks daemon state across mutations. */
export interface ProtocolOptions {
  /**
   * vibesurfer 0.2+ returns each mutation's tree delta inline (act and
   * cursor ops advance the delta baseline and emit their ViewForm).
   * When enabled the page applies those bodies and skips the re-read
   * after actions. Leave off against the pinned 0.1.28 contract, whose
   * mutations advance the baseline silently.
   */
  actDeltas?: boolean;
}

export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  action: 10_000,
  expect: 5_000,
  navigation: 30_000,
};

export class Page {
  private pageId: string | null = null;
  private token: string | null = null;
  /** Last known tree, kept in sync via full views and deltas. */
  private snapshot: Snapshot | null = null;
  /**
   * True while `snapshot` equals the daemon's delta baseline (our last
   * applied view, with no act in between). The daemon advances its
   * baseline on every act and discards that delta, so after an act the
   * next view must be requested `--full`; between plain views, deltas
   * are sound. Cursor ops (click-at) do not touch the baseline, so
   * they leave this flag alone.
   */
  private synced = false;
  /**
   * True while `snapshot` also reflects current page reality, so an
   * action can resolve against it without a read. Any mutation clears
   * it. Distinct from `synced`: a click-at leaves the baseline (and
   * the daemon's last token) untouched, so the token check would not
   * catch acting on the pre-click tree; this flag forces the re-read.
   */
  private fresh = false;

  private readonly client: WireClient;
  private readonly sessionId: string;
  readonly timeouts: Timeouts;
  readonly inputMode: InputMode;
  readonly clickVia: ClickVia;
  readonly actDeltas: boolean;

  constructor(
    client: WireClient,
    sessionId: string,
    timeouts: Timeouts,
    inputMode: InputMode = 'robotic',
    clickVia: ClickVia = 'click-at',
    protocol: ProtocolOptions = {},
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.timeouts = timeouts;
    this.inputMode = inputMode;
    this.clickVia = clickVia;
    this.actDeltas = protocol.actDeltas ?? false;
  }

  /**
   * Fold a 0.2 mutation response body (the ViewForm the daemon emitted
   * while advancing its baseline) into the snapshot. Empty body means
   * NoChange; a full tree replaces; a delta applies when we hold the
   * pre-mutation baseline, otherwise the snapshot is unusable until
   * the next full view.
   */
  private applyMutationBody(resp: WireResponse): void {
    const first = resp.body[0];
    if (first === undefined) return;
    if (!isDeltaBody(first)) {
      this.snapshot = parseFullTree(resp.body);
      this.synced = true;
      this.fresh = true;
      return;
    }
    if (this.synced && this.snapshot) {
      applyDelta(this.snapshot, resp.body);
      this.fresh = true;
    } else {
      this.synced = false;
      this.fresh = false;
    }
  }

  private get id(): string {
    if (!this.pageId) throw new Error('page has no URL yet; call page.goto(url) first');
    return this.pageId;
  }

  /**
   * Navigate to a URL. vibesurfer models navigation as opening a page,
   * so a second goto closes the old page and opens a new one.
   */
  async goto(url: string): Promise<void> {
    if (this.pageId) {
      await this.client
        .call('vs_close', [this.pageId], { session: this.sessionId })
        .catch(() => {});
      this.pageId = null;
    }
    this.token = null;
    this.snapshot = null;
    this.synced = false;
    this.fresh = false;
    const resp = await this.client.call('vs_open', [url], { session: this.sessionId });
    const id = resp.body[0];
    if (!id) throw new Error(`vs_open returned no page id for ${url}`);
    this.pageId = id;
    this.token = resp.token;
    // No settle wait here: locators auto-wait and assertions poll, so
    // a still-loading tree just resolves a poll tick later.
  }

  /**
   * Refresh the snapshot from the daemon and return it. Sends a plain
   * (delta) view when our snapshot matches the daemon's baseline and a
   * `--full` view otherwise; the body shape decides how it is applied,
   * so a surprise full tree (navigation, daemon restart) is handled
   * either way.
   */
  async view(): Promise<Snapshot> {
    const flags: Record<string, string | true> = { session: this.sessionId };
    const canDelta = this.synced && this.snapshot !== null;
    if (!canDelta) flags['full'] = true;
    const resp = await this.client.call('vs_view', [this.id], flags);
    this.token = resp.token;
    const first = resp.body[0];
    if (first === undefined) {
      // No change since our baseline (or a genuinely empty page).
      this.snapshot ??= { nodes: new Map(), roots: [] };
    } else if (canDelta && this.snapshot && isDeltaBody(first)) {
      applyDelta(this.snapshot, resp.body);
    } else {
      this.snapshot = parseFullTree(resp.body);
    }
    this.synced = true;
    this.fresh = true;
    return this.snapshot;
  }

  /**
   * Snapshot for resolving an action target: the cached tree when it
   * is still baseline-synced, otherwise a fresh view. Acting on a
   * cached tree is safe because every mutation carries our token; if
   * the page moved on, the daemon answers STALE_TOKEN and the action
   * loop re-resolves against a fresh view.
   */
  async actionSnapshot(): Promise<Snapshot> {
    if (this.fresh && this.snapshot) return this.snapshot;
    return this.view();
  }

  /**
   * Run one act primitive against a ref with the cached token. On
   * STALE_TOKEN the cached token is refreshed before rethrowing, so
   * the caller can re-resolve and retry.
   */
  async act(ref: number, op: string, value?: string, extraFlags?: Record<string, string>): Promise<void> {
    if (this.token === null) await this.view();
    const args = value === undefined ? [this.id, String(ref), op] : [this.id, String(ref), op, value];
    try {
      const resp = await this.client.call('vs_act', args, {
        ...extraFlags,
        session: this.sessionId,
        token: this.token ?? '',
      });
      this.token = resp.token;
      if (this.actDeltas) {
        this.applyMutationBody(resp);
      } else {
        // 0.1.x: the act advanced the daemon's delta baseline without
        // showing us the delta; the cached tree cannot be patched.
        this.synced = false;
        this.fresh = false;
      }
    } catch (e) {
      if (e instanceof WireError && e.code === 'STALE_TOKEN' && e.args[0]) {
        this.token = e.args[0];
      }
      this.synced = false;
      this.fresh = false;
      throw e;
    }
  }

  /**
   * Trusted native click at viewport coordinates via vs_click_at. The
   * cursor op leaves the daemon's delta baseline and last token
   * untouched, so `synced` survives (the next delta view picks up the
   * click's effects) but `fresh` does not.
   */
  async clickAt(x: number, y: number, mode?: InputMode): Promise<void> {
    if (this.token === null) await this.view();
    try {
      const resp = await this.client.call(
        'vs_click_at',
        [this.id, String(Math.round(x)), String(Math.round(y))],
        { session: this.sessionId, token: this.token ?? '', mode: mode ?? this.inputMode },
      );
      this.token = resp.token;
      if (this.actDeltas) {
        this.applyMutationBody(resp);
      } else {
        // 0.1.x cursor ops leave the baseline (and token) untouched;
        // the snapshot just needs a re-read before the next action.
        this.fresh = false;
      }
    } catch (e) {
      if (e instanceof WireError && e.code === 'STALE_TOKEN' && e.args[0]) {
        this.token = e.args[0];
      }
      this.synced = false;
      this.fresh = false;
      throw e;
    }
  }

  /** Full text of one ref via vs_read. */
  async readRef(ref: number): Promise<string> {
    const resp = await this.client.call('vs_read', [this.id, String(ref)], {
      session: this.sessionId,
    });
    this.token = resp.token;
    return resp.body.join('\n');
  }

  /** Trusted per-character typing into the focused element (macOS today). */
  async typeTrusted(text: string, options?: { secret?: boolean; mode?: InputMode }): Promise<void> {
    const flags: Record<string, string | true> = {
      session: this.sessionId,
      token: this.token ?? '',
      mode: options?.mode ?? this.inputMode,
    };
    if (options?.secret) flags['secret'] = true;
    try {
      const resp = await this.client.call('vs_type', [this.id, text], flags);
      this.token = resp.token;
      // vs_type advances neither baseline nor token on any released
      // engine; the snapshot stays delta-patchable but not fresh.
      this.fresh = false;
    } catch (e) {
      this.synced = false;
      this.fresh = false;
      throw e;
    }
  }

  /**
   * Block until a daemon-side wait condition holds. The returned wait
   * token is deliberately not cached: vs_wait computes it from a raw
   * engine snapshot without advancing the page's last-emitted token,
   * so it is not valid as an act pre-image.
   */
  async waitFor(
    cond: 'stable' | 'net-idle' | 'token-change' | 'text' | 'ref' | 'gone',
    value?: string,
    timeoutMs?: number,
  ): Promise<void> {
    const args = value === undefined ? [this.id, cond] : [this.id, cond, value];
    const budget = timeoutMs ?? this.timeouts.navigation;
    const resp = await this.client.call(
      'vs_wait',
      args,
      { session: this.sessionId, timeout: String(budget) },
      budget + 10_000,
    );
    if (this.actDeltas) {
      // 0.2 wait advances the baseline without emitting the tree; the
      // token is a valid pre-image but the snapshot must be re-read.
      this.token = resp.token;
      this.synced = false;
      this.fresh = false;
    }
  }

  /**
   * Bounding rects for refs via vs_layout. Body lines look like
   * `<ref> x=0 y=0 w=0 h=0 visible=false z=0`.
   */
  async layout(refs: number[]): Promise<Map<number, LayoutRect>> {
    const out = new Map<number, LayoutRect>();
    if (refs.length === 0) return out;
    const resp = await this.client.call('vs_layout', [this.id, ...refs.map(String)], {
      session: this.sessionId,
    });
    this.token = resp.token;
    for (const line of resp.body) {
      const tokens = line.trim().split(/\s+/);
      const ref = Number(tokens[0]);
      if (!Number.isInteger(ref)) continue;
      const rect: LayoutRect = { x: 0, y: 0, w: 0, h: 0, visible: false };
      for (const tok of tokens.slice(1)) {
        const eq = tok.indexOf('=');
        if (eq <= 0) continue;
        const k = tok.slice(0, eq);
        const v = tok.slice(eq + 1);
        if (k === 'visible') rect.visible = v === 'true';
        else if (k === 'x') rect.x = Number(v);
        else if (k === 'y') rect.y = Number(v);
        else if (k === 'w') rect.w = Number(v);
        else if (k === 'h') rect.h = Number(v);
      }
      out.set(ref, rect);
    }
    return out;
  }

  /** The document title (the doc node's label). */
  async title(): Promise<string> {
    const snap = await this.view();
    for (const node of walk(snap)) {
      if (node.role === 'doc') return node.label;
    }
    return '';
  }

  getByRole(role: string, options: ByRoleOptions = {}): Locator {
    return new Locator(this, { kind: 'role', role, options });
  }

  getByText(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return new Locator(this, { kind: 'text', text, options });
  }

  getByLabel(text: string | RegExp, options: ByTextOptions = {}): Locator {
    return new Locator(this, { kind: 'label', text, options });
  }

  async close(): Promise<void> {
    if (!this.pageId) return;
    await this.client
      .call('vs_close', [this.pageId], { session: this.sessionId })
      .catch(() => {});
    this.pageId = null;
    this.token = null;
    this.snapshot = null;
    this.synced = false;
    this.fresh = false;
  }
}
