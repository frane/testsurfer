/**
 * Playwright's page.screencast: frames to a callback or a video file,
 * and annotations drawn into the page (chapters, HTML overlays, a label
 * for each action) so they show in both.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { setActionAnnotator } from './tracing.ts';

type Position = 'top-left' | 'top' | 'top-right' | 'bottom-left' | 'bottom' | 'bottom-right';

/** What the screencast needs from its page. */
export interface ScreencastPage {
  evaluate<T = unknown>(fn: string, arg?: unknown): Promise<T>;
  screenshot(): Promise<Buffer>;
  viewportSize(): { width: number; height: number } | null;
  recordTo(width: number | undefined): Promise<() => Promise<string | null>>;
}

const disposable = (fn: () => Promise<void>) => ({
  dispose: fn,
  [Symbol.asyncDispose]: fn,
});

const LAYER = `(() => {
  let l = document.getElementById('__ts_overlays');
  if (!l) {
    l = document.createElement('div');
    l.id = '__ts_overlays';
    l.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    (document.body || document.documentElement).appendChild(l);
  }
  return l;
})()`;

const place = (pos: Position) =>
  ({
    'top-left': 'top:12px;left:12px;',
    top: 'top:12px;left:50%;transform:translateX(-50%);',
    'top-right': 'top:12px;right:12px;',
    'bottom-left': 'bottom:12px;left:12px;',
    bottom: 'bottom:12px;left:50%;transform:translateX(-50%);',
    'bottom-right': 'bottom:12px;right:12px;',
  })[pos];

export class Screencast {
  private readonly page: ScreencastPage;
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopRecording: (() => Promise<string | null>) | null = null;
  private videoPath: string | null = null;
  private actions: { duration: number; position: Position; fontSize: number } | null = null;

  /** @internal */
  constructor(page: ScreencastPage) {
    this.page = page;
  }

  /** Start: frames to `onFrame`, a video to `path`, action labels with `annotate`. */
  async start(
    options: {
      onFrame?: (frame: { data: Buffer; timestamp: number; viewportWidth: number; viewportHeight: number }) => unknown;
      path?: string;
      size?: { width: number; height: number };
      quality?: number;
      annotate?: { duration?: number; position?: Position; fontSize?: number };
    } = {},
  ) {
    if (options.path) {
      this.videoPath = options.path;
      this.stopRecording = await this.page.recordTo(options.size?.width);
    }
    if (options.onFrame) {
      const onFrame = options.onFrame;
      let busy = false;
      this.timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void (async () => {
          const data = await this.page.screenshot();
          const vp = this.page.viewportSize() ?? { width: 0, height: 0 };
          await onFrame({ data, timestamp: Date.now(), viewportWidth: vp.width, viewportHeight: vp.height });
        })()
          .catch(() => {})
          .finally(() => {
            busy = false;
          });
      }, 100);
      this.timer.unref();
    }
    if (options.annotate) await this.showActions(options.annotate);
    return disposable(() => this.stop());
  }

  /** Stop frames and the recording; the video is written to start's `path`. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const stop = this.stopRecording;
    this.stopRecording = null;
    if (stop) {
      const recorded = await stop();
      if (recorded && this.videoPath) {
        await fs.promises.mkdir(path.dirname(path.resolve(this.videoPath)), { recursive: true });
        await fs.promises.copyFile(recorded, this.videoPath);
      }
    }
    await this.hideActions();
  }

  /** Label each action on the page (its name and target) while it runs. */
  async showActions(options: { cursor?: 'none' | 'pointer'; duration?: number; fontSize?: number; position?: Position } = {}) {
    this.actions = { duration: options.duration ?? 1000, position: options.position ?? 'top-right', fontSize: options.fontSize ?? 16 };
    setActionAnnotator(this.page, (method, selector) => this.label(`${method}${selector ? ` ${selector}` : ''}`));
    return disposable(() => this.hideActions());
  }

  async hideActions(): Promise<void> {
    this.actions = null;
    setActionAnnotator(this.page, null);
  }

  private async label(text: string): Promise<void> {
    const a = this.actions;
    if (!a) return;
    const html = `<div style="background:rgba(0,0,0,.75);color:#fff;font:${a.fontSize}px system-ui;padding:6px 10px;border-radius:6px">${escapeHtml(text)}</div>`;
    await this.overlay(html, a.duration, place(a.position));
  }

  /** A full-page card with `title` (and `description`) for `duration` ms. */
  async showChapter(title: string, options: { description?: string; duration?: number } = {}): Promise<void> {
    const html = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,.6);color:#fff;font:600 32px system-ui">${escapeHtml(title)}${options.description ? `<div style="font:400 18px system-ui;margin-top:8px">${escapeHtml(options.description)}</div>` : ''}</div>`;
    const duration = options.duration ?? 2000;
    await this.overlay(html, duration, 'inset:0;');
    await new Promise((r) => setTimeout(r, duration));
  }

  /** Show `html` over the page (for `duration` ms when given); dispose to remove it. */
  async showOverlay(html: string, options: { duration?: number } = {}) {
    const id = await this.overlay(html, options.duration ?? 0, 'top:0;left:0;');
    return disposable(() => this.page.evaluate<void>(`(id) => { const n = document.getElementById(id); if (n) n.remove(); }`, id).catch(() => {}));
  }

  async hideOverlays(): Promise<void> {
    await this.page.evaluate<void>(`() => { const l = ${LAYER}; l.style.display = 'none'; }`).catch(() => {});
  }

  async showOverlays(): Promise<void> {
    await this.page.evaluate<void>(`() => { const l = ${LAYER}; l.style.display = ''; }`).catch(() => {});
  }

  private async overlay(html: string, duration: number, where: string): Promise<string> {
    const id = `__ts_overlay_${++this.seq}`;
    await this.page.evaluate<void>(
      `([id, html, duration, where]) => {
        const l = ${LAYER};
        const d = document.createElement('div');
        d.id = id;
        d.style.cssText = 'position:absolute;' + where;
        d.innerHTML = html;
        l.appendChild(d);
        if (duration > 0) setTimeout(() => d.remove(), duration);
      }`,
      [id, html, duration, where],
    );
    return id;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
