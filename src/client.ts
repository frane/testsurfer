/**
 * Socket client for the vibesurfer daemon.
 *
 * Speaks the line protocol over the Unix domain socket at
 * `~/.vibesurfer/daemon.sock`. One connection, requests answered in
 * order. Responses are read up to the blank-line terminator, mirroring
 * `crates/vs-cli/src/client.rs` in the vibesurfer repo.
 *
 * If the socket is unreachable the client shells out once to the `vs`
 * binary (which auto-spawns the daemon) and retries. The binary is
 * resolved in this order: `options.vsCommand`, the `TESTSURFER_VS`
 * environment variable, `vs` on PATH, `npx -y vibesurfer@<pinned>`.
 */

import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { WireError, TimeoutError } from './errors.ts';
import {
  encodeRequest,
  parseEnvelope,
  parseWarning,
  type Flags,
  type Warning,
  type WireResponse,
} from './wire.ts';

/** The vibesurfer release testsurfer is built and tested against. */
export const PINNED_VIBESURFER = '0.2.18';

export interface ClientOptions {
  /** Socket path. Default: `~/.vibesurfer/daemon.sock`. */
  socketPath?: string;
  /** Command used to reach the vs binary, e.g. `['vs']` or `['npx', '-y', 'vibesurfer@0.2.18']`. */
  vsCommand?: string[];
  /** Per-request timeout in ms. Default 70000 (above the daemon's 60s wait cap). */
  requestTimeout?: number;
}

interface Pending {
  resolve: (r: WireResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  line: string;
  /** Extra blank-line-terminated sections expected after a success body. */
  extraSections: number;
}

export interface CallOptions {
  timeoutMs?: number;
  /**
   * Number of extra blank-line-terminated body sections the daemon
   * appends on success for this request (composites like
   * `vs_view --layout=...`). Error envelopes never carry sections.
   */
  extraSections?: number;
}

export function defaultSocketPath(): string {
  return path.join(os.homedir(), '.vibesurfer', 'daemon.sock');
}

function candidateCommands(opts: ClientOptions): string[][] {
  const out: string[][] = [];
  if (opts.vsCommand?.length) out.push(opts.vsCommand);
  const env = process.env['TESTSURFER_VS'];
  if (env) out.push(env.split(' ').filter(Boolean));
  out.push(['vs']);
  out.push(['npx', '-y', `vibesurfer@${PINNED_VIBESURFER}`]);
  return out;
}

function runCommand(cmd: string[], args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const [bin, ...pre] = cmd;
    if (!bin) {
      reject(new Error('empty vs command'));
      return;
    }
    // npx and npm shims are .cmd files on Windows, which only run
    // through a shell.
    execFile(bin, [...pre, ...args], { timeout: timeoutMs, shell: process.platform === 'win32' }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Run a vs command and return its trimmed stdout. */
function commandOutput(cmd: string[], args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const [bin, ...pre] = cmd;
    if (!bin) {
      reject(new Error('empty vs command'));
      return;
    }
    execFile(bin, [...pre, ...args], { timeout: timeoutMs, shell: process.platform === 'win32' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

function connectOnce(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    sock.once('connect', () => {
      sock.removeAllListeners('error');
      resolve(sock);
    });
    sock.once('error', (e) => reject(e));
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** TESTSURFER_PROFILE=1: count and time every wire call, printed per process at exit. */
const PROFILE = !!process.env['TESTSURFER_PROFILE'];
const profile = new Map<string, { n: number; ms: number }>();
function profileAdd(key: string, ms: number): void {
  const e = profile.get(key) ?? { n: 0, ms: 0 };
  e.n += 1;
  e.ms += ms;
  profile.set(key, e);
}
if (PROFILE) {
  process.on('exit', () => {
    const rows = [...profile].sort((a, b) => b[1].ms - a[1].ms);
    const lines = rows.map(([k, e]) => `${k}\t${e.n}\t${e.ms.toFixed(0)}`);
    process.stderr.write(`\n[ts-profile ${process.pid}]\n${lines.join('\n')}\n`);
  });
}

export class WireClient {
  private sock: net.Socket | null = null;
  private buf = '';
  private queue: Pending[] = [];
  private current: {
    warnings: Warning[];
    envelope: ReturnType<typeof parseEnvelope> | null;
    body: string[];
    sections: string[][];
    active: string[] | null;
    sectionsWanted: number;
  } | null = null;
  private closed = false;

  private readonly opts: ClientOptions;

  private constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  static async connect(opts: ClientOptions = {}): Promise<WireClient> {
    const client = new WireClient(opts);
    await client.ensureConnected();
    return client;
  }

  /** Resolved daemon address; on Windows a named pipe only `vs socket` can name. */
  private address: string | null = null;

  private socketPath(): string {
    return this.opts.socketPath ?? this.address ?? defaultSocketPath();
  }

  /** The daemon address this client uses. */
  get endpoint(): string {
    return this.socketPath();
  }

  /**
   * On Windows the daemon listens on a named pipe whose name is a hash
   * of the socket path, so ask the vs binary for it (vibesurfer
   * 0.2.15+). Unix uses the path directly.
   */
  private async resolveAddress(): Promise<void> {
    if (this.opts.socketPath || this.address || process.platform !== 'win32') return;
    let lastErr: unknown = null;
    for (const cmd of candidateCommands(this.opts)) {
      try {
        const out = await commandOutput(cmd, ['socket'], 180_000);
        if (out) {
          this.address = out.split(/\r?\n/).pop()!.trim();
          return;
        }
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`could not get the vibesurfer pipe name from \`vs socket\`: ${String(lastErr)}`);
  }

  private async ensureConnected(): Promise<void> {
    if (this.sock && !this.sock.destroyed) return;
    if (this.closed) throw new Error('client closed');
    await this.resolveAddress();
    try {
      this.attach(await connectOnce(this.socketPath()));
      return;
    } catch {
      // Socket missing or daemon down. Ask the CLI to auto-spawn it.
    }
    await this.spawnDaemon();
    const deadline = Date.now() + 15_000;
    let lastErr: unknown = new Error('daemon socket missing');
    while (Date.now() < deadline) {
      try {
        this.attach(await connectOnce(this.socketPath()));
        return;
      } catch (e) {
        lastErr = e;
        await sleep(100);
      }
    }
    throw new Error(`cannot reach vibesurfer daemon at ${this.socketPath()}: ${String(lastErr)}`);
  }

  private async spawnDaemon(): Promise<void> {
    let lastErr: unknown = null;
    for (const cmd of candidateCommands(this.opts)) {
      try {
        // Any CLI call auto-spawns the daemon. `status` is the cheapest.
        // The generous timeout covers a first-run npx download.
        await runCommand(cmd, ['status'], 180_000);
        return;
      } catch (e) {
        lastErr = e;
        // node --test runs test files in parallel, so another process
        // may be spawning the daemon right now and won the race (its
        // npx install or socket bind made ours fail). Use its daemon.
        if (await this.socketUp()) return;
      }
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await this.socketUp()) return;
      await sleep(250);
    }
    throw new Error(`could not start the vibesurfer daemon (tried vs, npx): ${String(lastErr)}`);
  }

  private async socketUp(): Promise<boolean> {
    try {
      (await connectOnce(this.socketPath())).destroy();
      return true;
    } catch {
      return false;
    }
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    this.buf = '';
    this.current = null;
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => this.onData(chunk));
    sock.on('error', (e) => this.failAll(new Error(`daemon connection error: ${e.message}`)));
    sock.on('close', () => {
      if (this.queue.length > 0) {
        this.failAll(new Error('daemon closed the connection'));
      }
      this.sock = null;
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    if (!this.current) {
      this.current = {
        warnings: [],
        envelope: null,
        body: [],
        sections: [],
        active: null,
        sectionsWanted: 0,
      };
    }
    const cur = this.current;
    if (line === '') {
      // Blank line before the envelope is noise. After the envelope it
      // terminates the main body, then each expected extra section.
      if (!cur.envelope) return;
      if (cur.active === null) {
        if (cur.sectionsWanted > 0) {
          cur.active = [];
          return;
        }
        this.finishResponse();
        return;
      }
      cur.sections.push(cur.active);
      if (cur.sections.length >= cur.sectionsWanted) {
        cur.active = null;
        this.finishResponse();
      } else {
        cur.active = [];
      }
      return;
    }
    if (!cur.envelope) {
      if (line.startsWith('?')) {
        cur.warnings.push(parseWarning(line));
        return;
      }
      cur.envelope = parseEnvelope(line);
      // Sections only follow success envelopes; the request at the
      // queue head is the one being answered.
      cur.sectionsWanted = cur.envelope.ok ? (this.queue[0]?.extraSections ?? 0) : 0;
      return;
    }
    if (cur.active !== null) cur.active.push(line);
    else cur.body.push(line);
  }

  private finishResponse(): void {
    const cur = this.current;
    this.current = null;
    const pending = this.queue.shift();
    if (!cur?.envelope || !pending) return;
    clearTimeout(pending.timer);
    if (cur.envelope.ok) {
      pending.resolve({
        warnings: cur.warnings,
        token: cur.envelope.token ?? '',
        body: cur.body,
        sections: cur.sections,
      });
    } else {
      pending.reject(new WireError(cur.envelope.code ?? 'UNKNOWN', cur.envelope.args ?? []));
    }
  }

  private failAll(err: Error): void {
    const pending = this.queue;
    this.queue = [];
    this.current = null;
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.sock?.destroy();
    this.sock = null;
  }

  /**
   * Send one request and await its response. Rejects with WireError on
   * a `!` envelope, TimeoutError if the daemon does not answer in time.
   */
  async call(
    primitive: string,
    args: string[] = [],
    flags: Flags = {},
    opts: CallOptions = {},
  ): Promise<WireResponse> {
    await this.ensureConnected();
    const sock = this.sock;
    if (!sock) throw new Error('not connected');
    const line = encodeRequest(primitive, args, flags);
    const budget = opts.timeoutMs ?? this.opts.requestTimeout ?? 70_000;
    const p = new Promise<WireResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out call desyncs the response order; drop the
        // connection so the next call starts clean.
        this.failAll(new TimeoutError(`no response to ${primitive} within ${budget}ms`));
      }, budget);
      this.queue.push({ resolve, reject, timer, line, extraSections: opts.extraSections ?? 0 });
      sock.write(line);
    });
    if (!PROFILE) return p;
    const t0 = performance.now();
    const key = primitive === 'vs_inspect' ? `vs_inspect ${args[0]}` : primitive;
    return p.finally(() => profileAdd(key, performance.now() - t0));
  }

  /** A second connection to the same daemon, with the same options. */
  sibling(): Promise<WireClient> {
    return WireClient.connect({ ...this.opts, socketPath: this.socketPath() });
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error('client closed'));
  }
}
