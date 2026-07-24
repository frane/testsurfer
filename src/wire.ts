/**
 * Wire-format encoding and decoding for the vibesurfer line protocol.
 *
 * Mirrors `crates/vs-protocol/src/request.rs` in the vibesurfer repo:
 * a request is one line `<primitive> [arg]... [--flag[=val]]...`, args
 * are backslash-escaped then quoted when they contain whitespace, and
 * flags are emitted in sorted order (matching the reference encoder's
 * BTreeMap iteration).
 */

export interface Warning {
  code: string;
  args: string[];
}

export interface WireResponse {
  warnings: Warning[];
  /** The new state token from the `@<token>` success envelope. */
  token: string;
  body: string[];
  /**
   * Extra blank-line-terminated body sections for composite requests
   * (e.g. `vs_view --layout=...`). Present only when the caller asked
   * for them; empty otherwise.
   */
  sections: string[][];
}

/** Flag map: `true` is a bare flag, a string is `--name=value`. */
export type Flags = Record<string, string | true | undefined>;

/**
 * Backslash-escape the characters the line-framed, quote-aware wire
 * would break on: `\` `"` LF CR TAB. Everything else passes through.
 */
export function escapeWire(s: string): string {
  if (!/[\\"\n\r\t]/.test(s)) return s;
  let out = '';
  for (const c of s) {
    switch (c) {
      case '\\':
        out += '\\\\';
        break;
      case '"':
        out += '\\"';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default:
        out += c;
    }
  }
  return out;
}

/** Wrap an already-escaped value in quotes if empty or containing whitespace. */
export function quoteArg(escaped: string): string {
  return escaped === '' || /[ \t]/.test(escaped) ? `"${escaped}"` : escaped;
}

/** Encode one request line, including the trailing newline. */
export function encodeRequest(primitive: string, args: string[] = [], flags: Flags = {}): string {
  let out = primitive;
  for (const a of args) {
    out += ' ' + quoteArg(escapeWire(a));
  }
  for (const k of Object.keys(flags).sort()) {
    const v = flags[k];
    if (v === undefined) continue;
    out += ' --' + k;
    if (v !== true) {
      out += '=' + quoteArg(escapeWire(v));
    }
  }
  return out + '\n';
}

/** Parse a `? code args...` warning line (leading `?` included). */
export function parseWarning(line: string): Warning {
  const parts = line.replace(/^\?\s*/, '').split(/\s+/).filter(Boolean);
  return { code: parts[0] ?? '', args: parts.slice(1) };
}

export interface ParsedEnvelope {
  ok: boolean;
  /** Token for `@` envelopes. */
  token?: string;
  /** Code and args for `!` envelopes. */
  code?: string;
  args?: string[];
}

/** Parse an `@<token>` or `! CODE args...` envelope line. */
export function parseEnvelope(line: string): ParsedEnvelope {
  if (line.startsWith('@')) {
    return { ok: true, token: line.slice(1).trim() };
  }
  if (line.startsWith('!')) {
    const parts = line.slice(1).trim().split(/\s+/).filter(Boolean);
    return { ok: false, code: parts[0] ?? 'UNKNOWN', args: parts.slice(1) };
  }
  throw new Error(`expected ?/@/! envelope, got: ${line}`);
}
