/**
 * Parser for the vibesurfer accessibility tree wire format.
 *
 * Full tree lines look like
 *
 *     <ref> <role> <label> [op[,op]...] [k=v]...
 *
 * indented two spaces per nesting level. The label slot is always
 * present (quoted when empty or containing whitespace); ops and attrs
 * are optional. See `docs/PROTOCOL.md` and `docs/codes.md` in the
 * vibesurfer repo.
 */

export interface TreeNode {
  ref: number;
  role: string;
  label: string;
  ops: string[];
  attrs: Record<string, string>;
  parent: number | null;
  children: number[];
  depth: number;
}

export interface Snapshot {
  nodes: Map<number, TreeNode>;
  roots: number[];
}

const OPS = new Set(['click', 'fill', 'scroll', 'key', 'submit', 'hover', 'focus']);

/** Split a tree line into tokens, keeping `"..."` spans together. */
export function tokenizeTreeLine(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= s.length) break;
    const start = i;
    let inQuotes = false;
    while (i < s.length) {
      const c = s[i];
      if (c === '"') inQuotes = !inQuotes;
      else if ((c === ' ' || c === '\t') && !inQuotes) break;
      i++;
    }
    tokens.push(s.slice(start, i));
  }
  return tokens;
}

export function stripQuotes(t: string): string {
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

function isOpsToken(t: string): boolean {
  return t.split(',').every((p) => OPS.has(p));
}

/** Parse one full-tree line (already trimmed of indentation). */
export function parseTreeLine(line: string, depth: number): TreeNode | null {
  const tokens = tokenizeTreeLine(line);
  const refTok = tokens[0];
  const role = tokens[1];
  if (refTok === undefined || role === undefined) return null;
  const ref = Number(refTok);
  if (!Number.isInteger(ref) || ref < 0) return null;
  const label = tokens[2] !== undefined ? stripQuotes(tokens[2]) : '';
  let i = 3;
  let ops: string[] = [];
  const next = tokens[i];
  if (next !== undefined && !next.includes('=') && isOpsToken(next)) {
    ops = next.split(',');
    i++;
  }
  const attrs: Record<string, string> = {};
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    const eq = tok.indexOf('=');
    if (eq > 0) {
      attrs[tok.slice(0, eq)] = stripQuotes(tok.slice(eq + 1));
    }
  }
  return { ref, role, label, ops, attrs, parent: null, children: [], depth };
}

/** Parse the body of a full `vs_view` into a snapshot. */
export function parseFullTree(lines: string[]): Snapshot {
  const nodes = new Map<number, TreeNode>();
  const roots: number[] = [];
  const stack: TreeNode[] = [];
  for (const raw of lines) {
    if (raw.trim() === '') continue;
    const trimmed = raw.replace(/^[ ]*/, '');
    const indent = raw.length - trimmed.length;
    const depth = Math.floor(indent / 2);
    const node = parseTreeLine(trimmed, depth);
    if (!node) continue;
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1]! : null;
    if (parent) {
      node.parent = parent.ref;
      parent.children.push(node.ref);
    } else {
      roots.push(node.ref);
    }
    nodes.set(node.ref, node);
    stack.push(node);
  }
  return { nodes, roots };
}

/** Depth-first iteration over a snapshot's nodes. */
export function* walk(snap: Snapshot): Generator<TreeNode> {
  const visit = function* (ref: number): Generator<TreeNode> {
    const node = snap.nodes.get(ref);
    if (!node) return;
    yield node;
    for (const c of node.children) yield* visit(c);
  };
  for (const r of snap.roots) yield* visit(r);
}

/** True if the node or any ancestor carries hid=1. */
export function isHidden(snap: Snapshot, node: TreeNode): boolean {
  let cur: TreeNode | undefined = node;
  while (cur) {
    if (cur.attrs['hid'] === '1') return true;
    cur = cur.parent === null ? undefined : snap.nodes.get(cur.parent);
  }
  return false;
}
