/**
 * page.addLocatorHandler(): handlers for overlays (a cookie banner, a
 * newsletter dialog) that run whenever their locator is visible while
 * an action or assertion waits. The Page owns one.
 */

import type { Locator } from './locator.ts';

interface Entry {
  locator: Locator;
  handler: (l: Locator) => unknown;
  /** Runs left; null for unlimited. */
  times: number | null;
  noWaitAfter: boolean;
}

export class LocatorHandlers {
  /** Log lines from the last run that blocked a wait. */
  log: string[] = [];
  private entries: Entry[] = [];
  /** A handler's own actions must not trigger handlers again. */
  private running = false;

  add(locator: Locator, handler: (l: Locator) => unknown, options: { times?: number; noWaitAfter?: boolean }): void {
    this.entries.push({ locator, handler, times: options.times ?? null, noWaitAfter: options.noWaitAfter ?? false });
  }

  remove(locator: Locator): void {
    this.entries = this.entries.filter((h) => h.locator.toString() !== locator.toString());
  }

  /**
   * Run the handlers whose locator is visible now. Returns false while a
   * handled locator has not gone away yet: the caller keeps waiting, as
   * Playwright does, until it hides or `deadline` passes.
   */
  async run(deadline: number): Promise<boolean> {
    if (this.running || this.entries.length === 0) return true;
    this.running = true;
    try {
      for (const h of [...this.entries]) {
        if (!(await this.runOne(h, deadline))) return false;
      }
      return true;
    } finally {
      this.running = false;
    }
  }

  /** Run `h` if its locator is visible; false when it stayed visible past the deadline. */
  private async runOne(h: Entry, deadline: number): Promise<boolean> {
    const seen = await h.locator.peek<boolean>('locatorHandler', 'visible').catch(() => ({ found: false, v: false, preview: '' }));
    if (!seen.found || seen.v !== true) return true;
    this.log = [`found ${h.locator.toString()}, intercepting action to run the handler`, `locator resolved to visible ${seen.preview ?? ''}`];
    await h.handler(h.locator);
    if (h.times !== null && --h.times <= 0) this.entries = this.entries.filter((x) => x !== h);
    if (h.noWaitAfter) return true;
    this.log.push(`locator handler has finished, waiting for ${h.locator.toString()} to be hidden`);
    const left = Math.max(1, deadline - Date.now());
    const hidden = await h.locator.waitFor({ state: 'hidden', timeout: left }).then(() => true, () => false);
    if (!hidden) return false;
    this.log = [];
    return true;
  }
}
