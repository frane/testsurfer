/**
 * Recording a page with vibesurfer's recorder: the page's video
 * (recordVideo) and page.screencast recordings. The Page owns one.
 */

import type { WireClient } from './client.ts';
import type { PageSession } from './page-session.ts';
import { Video } from './video.ts';

/** Frame rate for page.video() and screencast recordings, as Playwright records. */
const RECORD_FPS = '25';

/** What PageRecorder needs from its page. */
export interface RecorderHost {
  readonly client: WireClient;
  readonly sessionId: string;
  readonly session: PageSession;
  /** The daemon records WebM (vibesurfer 0.2.19+), Playwright's video format. */
  readonly webm: boolean;
  ensureOpen(): Promise<void>;
}

export class PageRecorder {
  private readonly host: RecorderHost;
  private videoValue: Video | null = null;

  constructor(host: RecorderHost) {
    this.host = host;
  }

  /** Start recording the page, `width` px wide (the page's own width when not given). */
  async start(width: number | undefined): Promise<void> {
    await this.host.ensureOpen();
    const flags: Record<string, string> = { session: this.host.sessionId, fps: RECORD_FPS };
    if (this.host.webm) flags['format'] = 'webm';
    if (width) flags['width'] = String(width);
    await this.host.client.call('vs_record', ['start', this.host.session.id], flags);
  }

  /** Stop recording `pageId`; resolves the recording's path, or null when there is none. */
  async stop(pageId: string = this.host.session.id): Promise<string | null> {
    const r = await this.host.client.call('vs_record', ['stop', pageId], { session: this.host.sessionId }).catch(() => null);
    const line = r?.body.find((l) => l.startsWith('path\t'));
    return line ? line.slice(5) : null;
  }

  video(): Video | null {
    return this.videoValue;
  }

  /** Record the page from now on into `dir` (the context's recordVideo); once per page. */
  async recordVideo(dir: string, size?: { width: number; height: number }): Promise<void> {
    if (this.videoValue) return;
    this.videoValue = new Video(dir);
    await this.start(size?.width);
  }

  /** The page is closing: stop its video recording and hand the file to the Video. */
  async finishVideo(): Promise<void> {
    const pageId = this.host.session.pageId;
    if (!this.videoValue || !pageId) return;
    const path = await this.stop(pageId);
    if (path) await this.videoValue.finish(path).catch(() => {});
  }
}
