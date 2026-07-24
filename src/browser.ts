/**
 * Browser: one vibesurfer session. Owns the wire client, opens pages,
 * and closes the session on shutdown.
 */

import { WireClient, type ClientOptions } from './client.ts';
import {
  Page,
  DEFAULT_TIMEOUTS,
  type ClickVia,
  type InputMode,
  type ProtocolOptions,
  type Timeouts,
} from './page.ts';

export interface LaunchOptions extends ClientOptions {
  timeouts?: Partial<Timeouts>;
  /** vs policy name passed to session-open. */
  policy?: string;
  /**
   * Cursor and keyboard cadence for trusted input. Defaults to
   * `robotic` (instant, right for tests). Set `human` when a flow sits
   * behind bot detection that scores cursor motion.
   */
  inputMode?: InputMode;
  /** How click() reaches visible targets. See ClickVia; default `click-at` for the 0.1.28 contract. */
  clickVia?: ClickVia;
  /** Wire-semantics options for newer daemons. See ProtocolOptions. */
  protocol?: ProtocolOptions;
}

export class Browser {
  private readonly client: WireClient;
  readonly sessionId: string;
  private readonly timeouts: Timeouts;
  private readonly inputMode: InputMode;
  private readonly clickVia: ClickVia;
  private readonly protocol: ProtocolOptions;

  private constructor(
    client: WireClient,
    sessionId: string,
    timeouts: Timeouts,
    inputMode: InputMode,
    clickVia: ClickVia,
    protocol: ProtocolOptions,
  ) {
    this.client = client;
    this.sessionId = sessionId;
    this.timeouts = timeouts;
    this.inputMode = inputMode;
    this.clickVia = clickVia;
    this.protocol = protocol;
  }

  /** Connect to the daemon (spawning it if needed) and open a session. */
  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const client = await WireClient.connect(options);
    const flags: Record<string, string> = {};
    if (options.policy) flags['policy'] = options.policy;
    const resp = await client.call('vs_session_open', [], flags);
    const sessionId = resp.body[0];
    if (!sessionId) {
      client.close();
      throw new Error('vs_session_open returned no session id');
    }
    return new Browser(
      client,
      sessionId,
      { ...DEFAULT_TIMEOUTS, ...options.timeouts },
      options.inputMode ?? 'robotic',
      options.clickVia ?? 'click-at',
      options.protocol ?? {},
    );
  }

  /** A new page in this session. Call page.goto(url) to load a URL. */
  newPage(): Page {
    return new Page(this.client, this.sessionId, this.timeouts, this.inputMode, this.clickVia, this.protocol);
  }

  /** Close the session and drop the connection. */
  async close(): Promise<void> {
    await this.client.call('vs_session_close', [this.sessionId], {}).catch(() => {});
    this.client.close();
  }
}
