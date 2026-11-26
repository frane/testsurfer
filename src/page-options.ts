/** Per-page settings: timeouts, input cadence and the negotiated daemon protocol. */

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
 * How Locator.click reaches a visible target. `act` sends vs_act click
 * --mode directly (vibesurfer 0.2+, negotiated from the clickVia
 * flag). `click-at` resolves the rect and issues a coordinate click,
 * for 0.1.x daemons whose vs_act ignores --mode and always takes the
 * slow humanized path.
 */
export type ClickVia = 'click-at' | 'act';

/** Daemon capabilities negotiated at launch: what the page may ask vibesurfer for. */
export interface ProtocolOptions {
  /**
   * vibesurfer 0.2+ returns each mutation's tree delta inline (act and
   * cursor ops advance the delta baseline and emit their ViewForm).
   * When enabled the page applies those bodies and skips the re-read
   * after actions. Negotiated from the actDeltas flag; 0.1.x daemons
   * advance the baseline silently and must leave it off.
   */
  actDeltas?: boolean;
  /**
   * Navigate an existing page in place via vs_goto (protocol v1),
   * reusing the engine web view instead of paying page creation on
   * every goto. Falls back to close+open when the daemon rejects it.
   */
  navInPlace?: boolean;
  /** vibesurfer 0.2.19+: `vs_wheel`, a trusted native wheel turn. Negotiated from the wheel flag. */
  nativeWheel?: boolean;
  /** vibesurfer 0.2.19+: `vs_cookies`, the jar read and written host-side. Negotiated from the cookies flag. */
  cookies?: boolean;
  /** vibesurfer 0.2.19+: click-at takes a button, a click count and modifiers. Negotiated from the clickOptions flag. */
  clickOptions?: boolean;
  /** vibesurfer 0.2.19+: recordings in WebM (VP8), Playwright's video format. Negotiated from the webm flag. */
  webm?: boolean;
  /** vibesurfer 0.2.19+: `vs_drop`, a drop from another application as native OS input. Negotiated from the drop flag. */
  drop?: boolean;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  action: 10_000,
  expect: 5_000,
  navigation: 30_000,
};
