/**
 * A Page wraps one vibesurfer page: navigation, fresh views, token
 * management, and locator factories. Authors never see state tokens;
 * the page caches the latest one and every mutation uses it.
 */

import type { WireClient } from './client.ts';
import { WireError } from './errors.ts';
import { parseFullTree, walk, type Snapshot } from './tree.ts';
import { Locator, type ByRoleOptions, type ByTextOptions } from './locator.ts';

export interface Timeouts {
  /** Budget for actions (click, fill, ...) including auto-waiting. */
  action: number;
  /** Budget for expect() assertions. */
  expect: number;
  /** Budget for goto(). */
  navigation: number;
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

  private readonly client: WireClient;
  private readonly sessionId: string;
  readonly timeouts: Timeouts;

  constructor(client: WireClient, sessionId: string, timeouts: Timeouts) {
    this.client = client;
    this.sessionId = sessionId;
    this.timeouts = timeouts;
  }

  private get id(): string {
    if (!this.pageId) throw new Error('page has no URL yet; call page.goto(url) first');
    return this.pageId;
  }

  /**
   * Navigate to a URL. vibesurfer models navigation as opening a page,
   * so a second goto closes the old page and opens a new one. Waits
   * for the a11y tree to settle before returning.
   */
  async goto(url: string): Promise<void> {
    if (this.pageId) {
      await this.client
        .call('vs_close', [this.pageId], { session: this.sessionId })
        .catch(() => {});
      this.pageId = null;
      this.token = null;
    }
    const resp = await this.client.call('vs_open', [url], { session: this.sessionId });
    const id = resp.body[0];
    if (!id) throw new Error(`vs_open returned no page id for ${url}`);
    this.pageId = id;
    this.token = resp.token;
    await this.waitFor('stable', undefined, this.timeouts.navigation).catch(() => {
      // A tree that never settles is not fatal; assertions will poll.
    });
  }

  /** Fresh full view of the page. Updates the cached token. */
  async view(): Promise<Snapshot> {
    const resp = await this.client.call('vs_view', [this.id], {
      session: this.sessionId,
      full: true,
    });
    this.token = resp.token;
    return parseFullTree(resp.body);
  }

  /**
   * Run one act primitive against a ref with the cached token. On
   * STALE_TOKEN the cached token is refreshed before rethrowing, so
   * the caller can re-resolve and retry.
   */
  async act(ref: number, op: string, value?: string): Promise<void> {
    if (this.token === null) await this.view();
    const args = value === undefined ? [this.id, String(ref), op] : [this.id, String(ref), op, value];
    try {
      const resp = await this.client.call('vs_act', args, {
        session: this.sessionId,
        token: this.token ?? '',
      });
      this.token = resp.token;
    } catch (e) {
      if (e instanceof WireError && e.code === 'STALE_TOKEN' && e.args[0]) {
        this.token = e.args[0];
      }
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
  async typeTrusted(text: string, options?: { secret?: boolean }): Promise<void> {
    const flags: Record<string, string | true> = { session: this.sessionId, token: this.token ?? '' };
    if (options?.secret) flags['secret'] = true;
    const resp = await this.client.call('vs_type', [this.id, text], flags);
    this.token = resp.token;
  }

  /** Block until a daemon-side wait condition holds. */
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
    this.token = resp.token;
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
  }
}
