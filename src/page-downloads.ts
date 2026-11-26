/**
 * `download` events: vibesurfer captures every file a page saves; this
 * polls its capture list and reports each new entry once.
 */

import { Download, parseDownloadList, type DownloadEntry } from './download.ts';
import type { Page } from './page.ts';

/** How often the capture list is read while anyone watches downloads. */
const POLL_MS = 100;

/** What DownloadWatcher needs from its page. */
export interface DownloadHost {
  readonly page: Page;
  /** The page's capture list as vs_download --list body lines; null while the page has no web view. */
  list(): Promise<string[] | null>;
  /** Save capture `id` to `dest`; resolves the path it was written to. */
  save(id: number, dest: string): Promise<string>;
  emit(download: Download): void;
}

export class DownloadWatcher {
  private readonly host: DownloadHost;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly seen = new Set<number>();

  constructor(host: DownloadHost) {
    this.host = host;
  }

  /**
   * Start polling. Every captured download is reported once, from the
   * first time anyone watches: one that came just before the watcher
   * started (an action raced with waitForEvent) still counts.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    try {
      const body = await this.host.list();
      if (body) for (const e of parseDownloadList(body)) this.report(e);
    } catch {
      // The page is closing or the daemon is busy; the next poll catches up.
    }
  }

  private report(e: DownloadEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    this.host.emit(new Download(this.host.page, e, (id, dest) => this.host.save(id, dest)));
  }
}
