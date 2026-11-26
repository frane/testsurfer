/**
 * isMobile: honor the page's viewport meta tag as a mobile browser does.
 * The page is laid out as wide as the tag asks and zoomed to fit the
 * screen. Inputs at CSS coordinates scale by the zoom.
 */

/** Layout width of a page without a viewport meta tag, as in mobile Safari. */
const DEFAULT_LAYOUT_WIDTH = 980;
/** Zoom bounds, as mobile browsers clamp them. */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;

/** Identifies the document and its viewport tag: the zoom is worked out again when this changes. */
const DOC_KEY_EXPR = `location.href + '#' + performance.timeOrigin + '#' + ((document.querySelector('meta[name="viewport" i]') || {}).content || '')`;

/** What MobileZoom needs from its page. */
export interface ZoomHost {
  hasDocument(): boolean;
  /** The viewport width in CSS px, when one is set. */
  screenWidth(): number | undefined;
  evaluate(fn: string, arg?: unknown): Promise<unknown>;
  /** Apply a page zoom, keeping the viewport size. */
  setZoom(zoom: number): Promise<void>;
  onDomContentLoaded(listener: () => void): void;
}

export class MobileZoom {
  private readonly host: ZoomHost;
  private enabled = false;
  /** View px per CSS px: 1, or below 1 for a mobile page laid out wider than the screen. */
  private zoom = 1;
  /** The document (DOC_KEY_EXPR) the zoom was worked out for. */
  private zoomFor = '';

  constructor(host: ZoomHost) {
    this.host = host;
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.host.onDomContentLoaded(() => void this.update().catch(() => {}));
  }

  /**
   * Lay the page out as wide as its viewport meta tag asks (980 CSS px
   * without one), scaled to fit the screen: a page zoom of
   * screen width / layout width. Does nothing unless enabled.
   */
  async update(): Promise<void> {
    if (!this.enabled || !this.host.hasDocument()) return;
    const screen = this.host.screenWidth() ?? DEFAULT_LAYOUT_WIDTH;
    const got = (await this.host.evaluate(`(screen) => {
      const m = document.querySelector('meta[name="viewport" i]');
      const c = m ? (m.getAttribute('content') || '') : null;
      const v = {};
      if (c !== null) for (const part of c.split(/[,;]/)) { const [k, val] = part.split('=').map((x) => (x || '').trim().toLowerCase()); if (k) v[k] = val; }
      let width = c === null ? ${DEFAULT_LAYOUT_WIDTH} : v.width === 'device-width' || v.width === undefined ? screen : Number(v.width) || screen;
      const scale = Number(v['initial-scale']);
      if (c !== null && isFinite(scale) && scale > 0 && v.width === undefined) width = screen / scale;
      return { width: Math.max(1, width), href: ${DOC_KEY_EXPR} };
    }`, screen)) as { width: number; href: string };
    this.zoomFor = got.href;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, screen / got.width));
    if (Math.abs(zoom - this.zoom) < 1e-6) return;
    this.zoom = zoom;
    await this.host.setZoom(zoom);
  }

  /** Before an input at CSS coordinates: the zoom for the current document. */
  async ready(): Promise<number> {
    if (!this.enabled) return 1;
    const key = await this.host.evaluate(`() => ${DOC_KEY_EXPR}`).catch(() => '');
    if (key !== this.zoomFor) await this.update().catch(() => {});
    return this.zoom;
  }
}
