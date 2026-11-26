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

/** True if a view body is a delta (ops start with a sigil; full trees start with a ref). */
export function isDeltaBody(firstLine: string): boolean {
  return /^[+\-~>*]/.test(firstLine.trimStart());
}

/** Parse `<ref>@<parent>[:<pos>]` from an add/move op head. */
function parseRefAt(s: string): { ref: number; parent: number; pos: number | null } | null {
  const at = s.indexOf('@');
  if (at < 0) return null;
  const ref = Number(s.slice(0, at));
  const rest = s.slice(at + 1);
  const colon = rest.indexOf(':');
  const parent = Number(colon < 0 ? rest : rest.slice(0, colon));
  const pos = colon < 0 ? null : Number(rest.slice(colon + 1));
  if (!Number.isInteger(ref) || !Number.isInteger(parent)) return null;
  return { ref, parent, pos: pos !== null && Number.isInteger(pos) ? pos : null };
}

function removeSubtree(snap: Snapshot, ref: number): void {
  const node = snap.nodes.get(ref);
  if (!node) return;
  for (const c of [...node.children]) removeSubtree(snap, c);
  if (node.parent === null) {
    snap.roots = snap.roots.filter((r) => r !== ref);
  } else {
    const parent = snap.nodes.get(node.parent);
    if (parent) parent.children = parent.children.filter((r) => r !== ref);
  }
  snap.nodes.delete(ref);
}

/** Attach `ref` under `parent` (0 = root level) at `pos` (null = append). */
function attach(snap: Snapshot, ref: number, parent: number, pos: number | null): void {
  const node = snap.nodes.get(ref);
  if (!node) return;
  const siblings = parent === 0 ? snap.roots : snap.nodes.get(parent)?.children;
  if (!siblings) return;
  node.parent = parent === 0 ? null : parent;
  if (pos === null || pos >= siblings.length) siblings.push(ref);
  else siblings.splice(pos, 0, ref);
}

function detach(snap: Snapshot, ref: number): void {
  const node = snap.nodes.get(ref);
  if (!node) return;
  if (node.parent === null) {
    snap.roots = snap.roots.filter((r) => r !== ref);
  } else {
    const parent = snap.nodes.get(node.parent);
    if (parent) parent.children = parent.children.filter((r) => r !== ref);
  }
}

/**
 * Apply a delta view body to a snapshot in place. Five ops per the
 * protocol: `+<ref>@<parent>[:<pos>] ...` add, `-<ref>` remove,
 * `~<ref> k=v ...` attribute-map replace, `><ref>@<parent>[:<pos>]`
 * move, `*<ref>` plus indented subtree replace.
 */
export function applyDelta(snap: Snapshot, lines: string[]): void {
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i++] ?? '';
    if (raw.trim() === '') continue;
    const line = raw.trimStart();
    switch (line[0]) {
      case '+':
        deltaAdd(snap, line);
        break;
      case '-':
        removeSubtree(snap, Number(line.slice(1).trim()));
        break;
      case '~':
        deltaAttrs(snap, line);
        break;
      case '>':
        deltaMove(snap, line);
        break;
      case '*': {
        // The replacement subtree is the indented lines that follow.
        const subLines: string[] = [];
        while (i < lines.length && /^[ \t]/.test(lines[i] ?? '')) subLines.push(lines[i++] ?? '');
        deltaReplace(snap, Number(line.slice(1).trim()), subLines);
        break;
      }
      default:
      // Unknown line in a delta body; skip rather than corrupt state.
    }
  }
}

/** `+<ref>@<parent>[:<pos>] role ...`: a new node. */
function deltaAdd(snap: Snapshot, line: string): void {
  const sp = line.search(/[ \t]/);
  const head = sp < 0 ? line.slice(1) : line.slice(1, sp);
  const rest = sp < 0 ? '' : line.slice(sp + 1);
  const target = parseRefAt(head);
  if (!target) return;
  const node = parseTreeLine(`${target.ref} ${rest}`, 0);
  if (!node) return;
  snap.nodes.set(node.ref, node);
  attach(snap, node.ref, target.parent, target.pos);
}

/** `~<ref> k=v ...`: the node's attributes, replaced as a whole. */
function deltaAttrs(snap: Snapshot, line: string): void {
  const tokens = tokenizeTreeLine(line);
  const node = snap.nodes.get(Number(tokens[0]?.slice(1)));
  if (!node) return;
  const attrs: Record<string, string> = {};
  for (const tok of tokens.slice(1)) {
    const eq = tok.indexOf('=');
    if (eq > 0) attrs[tok.slice(0, eq)] = stripQuotes(tok.slice(eq + 1));
  }
  node.attrs = attrs;
}

/** `><ref>@<parent>[:<pos>]`: the node moves. */
function deltaMove(snap: Snapshot, line: string): void {
  const target = parseRefAt(line.slice(1));
  if (!target || !snap.nodes.has(target.ref)) return;
  detach(snap, target.ref);
  attach(snap, target.ref, target.parent, target.pos);
}

/** `*<ref>` and an indented subtree: the node and its subtree, replaced in place. */
function deltaReplace(snap: Snapshot, ref: number, subLines: string[]): void {
  const old = snap.nodes.get(ref);
  if (!old) return;
  const parent = old.parent;
  const siblings = parent === null ? snap.roots : (snap.nodes.get(parent)?.children ?? []);
  const position = siblings.indexOf(ref);
  removeSubtree(snap, ref);
  const indent = (subLines[0] ?? '').length - (subLines[0] ?? '').trimStart().length;
  const sub = parseFullTree(subLines.map((l) => l.slice(indent)));
  for (const node of sub.nodes.values()) snap.nodes.set(node.ref, node);
  for (const root of sub.roots) attach(snap, root, parent ?? 0, position < 0 ? null : position);
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
