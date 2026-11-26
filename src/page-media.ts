/**
 * page.emulateMedia(): the media script for this and later documents
 * (src/media.ts), plus copies of cross-origin stylesheets so their
 * @media rules can be rewritten too. The Page owns one.
 */

import type { APIRequestContext } from './request.ts';
import { absolutizeCss, cssImports, mediaScript, type MediaOptions } from './media.ts';

/** Batch stylesheet responses that arrive together into one adoption pass. */
const ADOPT_DEBOUNCE_MS = 30;
/** How deep @import chains are inlined; deeper ones are dropped, as a cycle guard. */
const MAX_IMPORT_DEPTH = 4;

/** What MediaEmulation needs from its page. */
export interface MediaHost {
  hasDocument(): boolean;
  addInitSource(source: string): Promise<void>;
  /** Evaluate an expression (no function wrapper). */
  rawEval(expr: string): Promise<unknown>;
  evaluate(fn: string, arg?: unknown): Promise<unknown>;
  /** HTTP from the test process with the context's cookies. */
  request(): APIRequestContext;
  /** Call `listener` for every stylesheet response from now on. */
  onStylesheet(listener: () => void): void;
}

const MEDIA_KEYS = ['media', 'colorScheme', 'reducedMotion', 'forcedColors', 'contrast'] as const;

export class MediaEmulation {
  private readonly host: MediaHost;
  private readonly media: MediaOptions = {};
  private watchingSheets = false;
  private adoptTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: MediaHost) {
    this.host = host;
  }

  /** Merge `options` into the emulated features (null resets one) and apply them. */
  async emulate(options: MediaOptions): Promise<void> {
    for (const k of MEDIA_KEYS) {
      if (k in options) (this.media as Record<string, string | null>)[k] = options[k] ?? null;
    }
    const src = mediaScript(this.media);
    await this.host.addInitSource(src);
    if (this.host.hasDocument()) await this.host.rawEval(`(${src.replace(/;\s*$/, '')}, 0)`).catch(() => {});
    // Cross-origin stylesheets: now, and whenever one loads later.
    if (!this.watchingSheets) {
      this.watchingSheets = true;
      this.host.onStylesheet(() => this.scheduleAdopt());
    }
    if (this.host.hasDocument()) await this.adoptSheets().catch(() => {});
  }

  private scheduleAdopt(): void {
    if (this.adoptTimer) return;
    this.adoptTimer = setTimeout(() => {
      this.adoptTimer = null;
      void this.adoptSheets().catch(() => {});
    }, ADOPT_DEBOUNCE_MS);
  }

  /**
   * Stylesheets the page cannot read (cross-origin, so their @media
   * rules cannot be rewritten in place): fetch each with the context's
   * cookies, inline its @imports, make its url()s absolute, and put the
   * copy in a <style> right after the original, which is disabled. The
   * media script then rewrites the copy like any other sheet.
   */
  private async adoptSheets(): Promise<void> {
    const hrefs = (await this.host.evaluate(`() => {
      const out = [];
      for (const s of document.styleSheets) {
        try { void s.cssRules; } catch (e) {
          if (s.href && s.ownerNode && !s.ownerNode.__tsAdopted) out.push(s.href);
        }
      }
      return out;
    }`)) as string[];
    for (const href of [...new Set(hrefs)]) {
      const css = await this.fetchSheet(href, 0).catch(() => null);
      if (css === null) continue;
      await this.host.evaluate(
        `([href, css]) => {
          for (const s of document.styleSheets) {
            const n = s.ownerNode;
            if (s.href !== href || !n || n.__tsAdopted) continue;
            n.__tsAdopted = true;
            const st = document.createElement('style');
            st.setAttribute('data-testsurfer-sheet', href);
            if (n.media && n.media.mediaText) st.media = n.media.mediaText;
            st.textContent = css;
            n.after(st);
            s.disabled = true;
          }
          if (window.__tsMediaApply) window.__tsMediaApply();
        }`,
        [href, css],
      );
    }
  }

  private async fetchSheet(href: string, depth: number): Promise<string> {
    const res = await this.host.request().get(href);
    if (!res.ok()) throw new Error(`stylesheet ${href}: ${res.status()}`);
    let css = absolutizeCss(await res.text(), href);
    if (depth < MAX_IMPORT_DEPTH) {
      for (const imp of cssImports(css, href)) {
        const inner = await this.fetchSheet(imp.url, depth + 1).catch(() => '');
        css = css.replace(imp.rule, imp.media ? `@media ${imp.media} {\n${inner}\n}` : inner);
      }
    }
    return css;
  }
}
