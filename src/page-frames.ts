/**
 * page.frames(): the frame tree as of the last read. The page engine
 * lists iframes (E.frames()); an iframe already known keeps its Frame
 * object, since Playwright compares frames by identity.
 */

import { Frame } from './frame.ts';
import { ElementHandle } from './locator.ts';
import type { Page } from './page.ts';
import { urlMatches } from './url.ts';

/** The frame-tree listing; its own reply never starts another refresh. */
export const FRAMES_CALL = 'E.frames()';

/** One E.frames() row: element id, parent element id (null under the main frame), name, URL, cross-origin flag. */
type FrameRow = [id: number, parent: number | null, name: string, url: string, crossOrigin?: number];

export type FrameMatch = string | { name?: string; url?: string | RegExp | ((u: URL) => boolean) };

/** What FrameTree needs from its page. */
export interface FramesHost {
  readonly page: Page;
  baseURL(): string | undefined;
  engineCall(body: string): Promise<unknown>;
}

export class FrameTree {
  private readonly host: FramesHost;
  private main: Frame | null = null;
  private children: Frame[] = [];
  /** The page's iframe count when the tree was last read. */
  private lastCount = 0;
  /** Reads run one after another, so an older listing never overwrites a newer one. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(host: FramesHost) {
    this.host = host;
  }

  mainFrame(): Frame {
    this.main ??= new Frame(this.host.page, null, null);
    return this.main;
  }

  /** The main frame, then every iframe, depth first. */
  all(): Frame[] {
    return [this.mainFrame(), ...this.children];
  }

  /** Re-read the tree. */
  refresh(): Promise<Frame[]> {
    const next = this.chain.then(() => this.read(), () => this.read());
    this.chain = next;
    return next;
  }

  /** An engine reply reported `count` iframes: re-read the tree when that changed. */
  async noteCount(count: number): Promise<void> {
    if (count === this.lastCount) return;
    this.lastCount = count;
    await this.refresh();
  }

  /** A frame by name, or by URL (string, RegExp or predicate). */
  find(match: FrameMatch): Frame | null {
    const m = typeof match === 'string' ? { name: match } : match;
    return (
      this.all().find((f) => {
        if (m.name !== undefined && f.name() !== m.name) return false;
        if (m.url === undefined) return true;
        const u = f === this.main ? '' : f.frameUrl;
        if (typeof m.url === 'string') return urlMatches(m.url, u, this.host.baseURL());
        if (m.url instanceof RegExp) return m.url.test(u);
        return !!u && m.url(new URL(u));
      }) ?? null
    );
  }

  private async read(): Promise<Frame[]> {
    const rows = ((await this.host.engineCall(FRAMES_CALL).catch(() => [])) ?? []) as FrameRow[];
    const byId = new Map<number, Frame>();
    const known = new Map(this.children.map((f) => [(f as unknown as { elementId(): number }).elementId(), f]));
    const out: Frame[] = [];
    for (const [id, parent, name, url, xo] of rows) {
      const parentFrame = parent === null ? this.mainFrame() : (byId.get(parent) ?? this.mainFrame());
      const f = known.get(id) ?? new Frame(this.host.page, new ElementHandle(this.host.page, id), parentFrame);
      f.frameName = name;
      f.frameUrl = url;
      f.crossOrigin = xo === 1;
      byId.set(id, f);
      out.push(f);
    }
    this.children = out;
    return this.all();
  }
}
