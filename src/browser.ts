/**
 * Browser: one vibesurfer session. Owns the wire client, opens pages,
 * and closes the session on shutdown.
 */

import { WireClient, type ClientOptions } from './client.ts';

/** Parse the vs_status daemon line into negotiated capabilities. */
async function negotiate(client: WireClient): Promise<{ proto: number; flags: Set<string> }> {
  const caps = { proto: 0, flags: new Set<string>() };
  try {
    const status = await client.call('vs_status');
    const line = status.body.find((l) => l.startsWith('daemon'));
    if (!line) return caps;
    for (const field of line.split('\t').slice(1)) {
      const eq = field.indexOf('=');
      if (eq <= 0) continue;
      const key = field.slice(0, eq);
      const value = field.slice(eq + 1);
      if (key === 'proto') caps.proto = Number(value) || 0;
      if (key === 'flags') for (const f of value.split(',')) caps.flags.add(f.trim());
    }
  } catch {
    // Status shape unknown; stay on pinned-contract defaults.
  }
  return caps;
}
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
  /** How click() reaches visible targets. See ClickVia; negotiated from the daemon by default. */
  clickVia?: ClickVia;
  /** Wire-semantics options for newer daemons. See ProtocolOptions. */
  protocol?: ProtocolOptions;
  /** Resolve relative goto() URLs against this, e.g. `http://localhost:3000`. */
  baseURL?: string;
  /** Attribute getByTestId matches. Default `data-testid`. */
  testIdAttribute?: string;
}

export class Browser {
  private readonly client: WireClient;
  readonly sessionId: string;
  private readonly timeouts: Timeouts;
  private readonly inputMode: InputMode;
  private readonly clickVia: ClickVia;
  private readonly protocol: ProtocolOptions;
  private readonly baseURL: string | undefined;
  private testIdAttribute = 'data-testid';

  private constructor(
    client: WireClient,
    sessionId: string,
    timeouts: Timeouts,
    inputMode: InputMode,
    clickVia: ClickVia,
    protocol: ProtocolOptions,
    baseURL: string | undefined,
  ) {
    this.baseURL = baseURL;
    this.client = client;
    this.sessionId = sessionId;
    this.timeouts = timeouts;
    this.inputMode = inputMode;
    this.clickVia = clickVia;
    this.protocol = protocol;
  }

  /**
   * Connect to the daemon (spawning it if needed) and open a session.
   * Wire capabilities are negotiated from the vs_status daemon line
   * (`daemon version=... proto=N flags=a,b`): protocol-v1 daemons get
   * inline act deltas, act-mode clicks, and nav-in-place goto
   * automatically. Explicit options always win over negotiation.
   */
  static async launch(options: LaunchOptions = {}): Promise<Browser> {
    const client = await WireClient.connect(options);
    const caps = await negotiate(client);
    const flags: Record<string, string> = {};
    if (options.policy) flags['policy'] = options.policy;
    const resp = await client.call('vs_session_open', [], flags);
    const sessionId = resp.body[0];
    if (!sessionId) {
      client.close();
      throw new Error('vs_session_open returned no session id');
    }
    const browser = new Browser(
      client,
      sessionId,
      { ...DEFAULT_TIMEOUTS, ...options.timeouts },
      options.inputMode ?? 'robotic',
      options.clickVia ?? (caps.flags.has('clickVia') ? 'act' : 'click-at'),
      {
        actDeltas: options.protocol?.actDeltas ?? caps.flags.has('actDeltas'),
        navInPlace: options.protocol?.navInPlace ?? caps.proto >= 1,
      },
      options.baseURL,
    );
    if (options.testIdAttribute) browser.testIdAttribute = options.testIdAttribute;
    return browser;
  }

  /** A new page in this session. Call page.goto(url) to load a URL. */
  newPage(): Page {
    const page = new Page(
      this.client,
      this.sessionId,
      this.timeouts,
      this.inputMode,
      this.clickVia,
      this.protocol,
      this.baseURL,
    );
    page.testIdAttribute = this.testIdAttribute;
    return page;
  }

  /** Close the session and drop the connection. */
  async close(): Promise<void> {
    await this.client.call('vs_session_close', [this.sessionId], {}).catch(() => {});
    this.client.close();
  }
}
