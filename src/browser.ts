/**
 * Browser: one vibesurfer session. Owns the wire client, opens pages,
 * and closes the session on shutdown.
 */

import { WireClient, type ClientOptions } from './client.ts';
import { Page, DEFAULT_TIMEOUTS, type InputMode, type Timeouts } from './page.ts';

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
}

export class Browser {
  private readonly client: WireClient;
  readonly sessionId: string;
  private readonly timeouts: Timeouts;
  private readonly inputMode: InputMode;

  private constructor(client: WireClient, sessionId: string, timeouts: Timeouts, inputMode: InputMode) {
    this.client = client;
    this.sessionId = sessionId;
    this.timeouts = timeouts;
    this.inputMode = inputMode;
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
    return new Browser(client, sessionId, { ...DEFAULT_TIMEOUTS, ...options.timeouts }, options.inputMode ?? 'robotic');
  }

  /** A new page in this session. Call page.goto(url) to load a URL. */
  newPage(): Page {
    return new Page(this.client, this.sessionId, this.timeouts, this.inputMode);
  }

  /** Close the session and drop the connection. */
  async close(): Promise<void> {
    await this.client.call('vs_session_close', [this.sessionId], {}).catch(() => {});
    this.client.close();
  }
}
