/**
 * The vibesurfer page a Page drives: its wire id, the latest state
 * token, the cached accessibility-tree snapshot and whether that
 * snapshot is still the daemon's delta baseline (`synced`) and still
 * the page's reality (`fresh`), plus the wire calls that move them:
 * views, acts and native input. Authors never see tokens; every
 * mutation carries the cached one.
 */

import type { WireClient } from './client.ts';
import { WireError } from './errors.ts';
import { parseLayoutLines, type LayoutRect } from './layout.ts';
import type { InputMode } from './page-options.ts';
import { applyDelta, isDeltaBody, parseFullTree, type Snapshot } from './tree.ts';
import type { WireResponse } from './wire.ts';

/** vs_wait gets this long on the wire beyond its own timeout. */
const WAIT_WIRE_SLACK_MS = 10_000;
/** vibesurfer counts at most a triple click. */
const MAX_CLICK_COUNT = 3;

export type Button = 'left' | 'right' | 'middle';

/** What PageSession needs from its page. */
export interface SessionHost {
  readonly client: WireClient;
  readonly sessionId: string;
  /** vibesurfer 0.2+: mutations return their tree delta inline (ProtocolOptions.actDeltas). */
  readonly actDeltas: boolean;
  inputMode(): InputMode;
  navigationTimeout(): number;
  /** Open the page's web view if it has none yet. */
  ensureOpen(): Promise<void>;
  /** View px per CSS px for input at CSS coordinates (isMobile zoom). */
  zoom(): Promise<number>;
  /** `e` came from the page closing itself under the call (a popup's Close button). */
  closedByItself(e: unknown): Promise<boolean>;
}

export class PageSession {
  pageId: string | null = null;
  token: string | null = null;
  /** Last known tree, kept in sync via full views and deltas. */
  snapshot: Snapshot | null = null;
  /**
   * True while `snapshot` equals the daemon's delta baseline (our last
   * applied view, with no act in between). The daemon advances its
   * baseline on every act and discards that delta, so after an act the
   * next view must be requested `--full`; between plain views, deltas
   * are sound. Cursor ops (click-at) do not touch the baseline, so
   * they leave this flag alone.
   */
  synced = false;
  /**
   * True while `snapshot` also reflects current page reality, so an
   * action can resolve against it without a read. Any mutation clears
   * it. Distinct from `synced`: a click-at leaves the baseline (and
   * the daemon's last token) untouched, so the token check would not
   * catch acting on the pre-click tree; this flag forces the re-read.
   */
  fresh = false;

  private readonly host: SessionHost;

  constructor(host: SessionHost) {
    this.host = host;
  }

  get id(): string {
    if (!this.pageId) throw new Error('page has no URL yet; call page.goto(url) first');
    return this.pageId;
  }

  /** A new document (or an unknown change): the cached tree is gone. */
  invalidate(): void {
    this.snapshot = null;
    this.synced = false;
    this.fresh = false;
  }

  /** The page has no web view any more (closed, or about to be reopened). */
  detach(): void {
    this.pageId = null;
    this.token = null;
    this.invalidate();
  }

  /**
   * Refresh the snapshot from the daemon and return it. Sends a plain
   * (delta) view when our snapshot matches the daemon's baseline and a
   * `--full` view otherwise; the body shape decides how it is applied,
   * so a surprise full tree (navigation, daemon restart) is handled
   * either way.
   */
  async view(): Promise<Snapshot> {
    await this.host.ensureOpen();
    const canDelta = this.synced && this.snapshot !== null;
    const flags: Record<string, string | true> = { session: this.host.sessionId };
    if (!canDelta) flags['full'] = true;
    const resp = await this.host.client.call('vs_view', [this.id], flags);
    return this.applyViewResponse(resp, canDelta);
  }

  /**
   * One round trip for view + layout via the `--layout=` composite:
   * the daemon appends rect lines for the requested refs as an extra
   * body section. Refs no longer in the tree come back as inline
   * NOT_FOUND lines and are simply absent from the map.
   */
  async viewWithLayout(refs: number[]): Promise<{ snap: Snapshot; rects: Map<number, LayoutRect> }> {
    if (refs.length === 0) {
      return { snap: await this.view(), rects: new Map() };
    }
    const canDelta = this.synced && this.snapshot !== null;
    const flags: Record<string, string | true> = {
      session: this.host.sessionId,
      layout: refs.join(','),
    };
    if (!canDelta) flags['full'] = true;
    const resp = await this.host.client.call('vs_view', [this.id], flags, { extraSections: 1 });
    const snap = this.applyViewResponse(resp, canDelta);
    return { snap, rects: parseLayoutLines(resp.sections[0] ?? []) };
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
      const resp = await this.host.client.call('vs_act', args, {
        ...extraFlags,
        session: this.host.sessionId,
        token: this.token ?? '',
      });
      this.token = resp.token;
      if (this.host.actDeltas) {
        this.applyMutationBody(resp);
      } else {
        // 0.1.x: the act advanced the daemon's delta baseline without
        // showing us the delta; the cached tree cannot be patched.
        this.synced = false;
        this.fresh = false;
      }
    } catch (e) {
      if (await this.host.closedByItself(e)) return;
      this.mutationFailed(e);
      throw e;
    }
  }

  /**
   * Trusted native click at viewport coordinates via vs_click_at. The
   * cursor op leaves the daemon's delta baseline and last token
   * untouched, so `synced` survives (the next delta view picks up the
   * click's effects) but `fresh` does not.
   */
  async clickAt(
    x: number,
    y: number,
    mode?: InputMode,
    opts: { count?: number | undefined; button?: Button | undefined; modifiers?: string[] | undefined } = {},
  ): Promise<void> {
    await this.host.ensureOpen();
    const z = await this.host.zoom();
    x *= z;
    y *= z;
    const flags: Record<string, string> = { session: this.host.sessionId, token: this.token ?? '0', mode: mode ?? this.host.inputMode() };
    if (opts.button && opts.button !== 'left') flags['button'] = opts.button;
    if (opts.count && opts.count > 1) flags['count'] = String(Math.min(MAX_CLICK_COUNT, opts.count));
    const mods = (opts.modifiers ?? []).map(wireModifier);
    if (mods.length) flags['modifiers'] = mods.join(',');
    try {
      const resp = await this.host.client.call(
        'vs_click_at',
        [this.id, String(Math.round(x * 100) / 100), String(Math.round(y * 100) / 100)],
        flags,
      );
      this.token = resp.token;
      if (this.host.actDeltas) {
        this.applyMutationBody(resp);
      } else {
        // 0.1.x cursor ops leave the baseline (and token) untouched;
        // the snapshot just needs a re-read before the next action.
        this.fresh = false;
      }
    } catch (e) {
      if (await this.host.closedByItself(e)) return;
      this.mutationFailed(e);
      throw e;
    }
  }

  /** A cursor op (move, drag, wheel) at viewport coordinates; `mutates` ops carry the state token. */
  async cursorOp(op: string, coords: number[], mode: InputMode | undefined, mutates: boolean): Promise<void> {
    await this.host.ensureOpen();
    const z = await this.host.zoom();
    // A wheel's deltas are CSS px of scrolling, not points on the screen.
    if (z !== 1) coords = coords.map((c, i) => (op === 'vs_wheel' && i >= 2 ? c : c * z));
    const flags: Record<string, string> = { session: this.host.sessionId, mode: mode ?? this.host.inputMode() };
    if (mutates) flags['token'] = this.token ?? '0';
    try {
      const resp = await this.host.client.call(op, [this.id, ...coords.map((c) => String(Math.round(c)))], flags);
      if (resp.token && !/^0+$/.test(resp.token)) this.token = resp.token;
      if (mutates && this.host.actDeltas) this.applyMutationBody(resp);
      else this.fresh = false;
    } catch (e) {
      this.mutationFailed(e);
      throw e;
    }
  }

  /** Trusted per-character typing into the focused element. */
  async typeTrusted(text: string, options?: { secret?: boolean; mode?: InputMode }): Promise<void> {
    await this.host.ensureOpen();
    const flags: Record<string, string | true> = {
      session: this.host.sessionId,
      token: this.token ?? '',
      mode: options?.mode ?? this.host.inputMode(),
    };
    if (options?.secret) flags['secret'] = true;
    try {
      const resp = await this.host.client.call('vs_type', [this.id, text], flags);
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
   * Text of one ref and its subtree via vs_read. The body renders each
   * node as `[ref] role: label`, indented; the labels are the text.
   */
  async readRef(ref: number): Promise<string> {
    const resp = await this.host.client.call('vs_read', [this.id, String(ref)], {
      session: this.host.sessionId,
    });
    this.token = resp.token;
    return resp.body
      .map((l) => l.replace(/^\s*\[\d+\] [^:]*: ?/, ''))
      .filter((l) => l.trim() !== '')
      .join(' ');
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
    const budget = timeoutMs ?? this.host.navigationTimeout();
    const resp = await this.host.client.call(
      'vs_wait',
      args,
      { session: this.host.sessionId, timeout: String(budget) },
      { timeoutMs: budget + WAIT_WIRE_SLACK_MS },
    );
    if (this.host.actDeltas) {
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
    if (refs.length === 0) return new Map();
    const resp = await this.host.client.call('vs_layout', [this.id, ...refs.map(String)], {
      session: this.host.sessionId,
    });
    this.token = resp.token;
    return parseLayoutLines(resp.body);
  }

  /** A mutation failed: take the daemon's current token from a STALE_TOKEN, and re-read before trusting the tree. */
  private mutationFailed(e: unknown): void {
    if (e instanceof WireError && e.code === 'STALE_TOKEN' && e.args[0]) {
      this.token = e.args[0];
    }
    this.synced = false;
    this.fresh = false;
  }

  private applyViewResponse(resp: WireResponse, canDelta: boolean): Snapshot {
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
}

/** A Playwright modifier name as vibesurfer's click-at takes it; ControlOrMeta is Meta on macOS. */
function wireModifier(m: string): string {
  if (m === 'ControlOrMeta') return process.platform === 'darwin' ? 'meta' : 'ctrl';
  return m === 'Control' ? 'ctrl' : m.toLowerCase();
}
