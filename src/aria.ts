/**
 * Accessibility-tree snapshots: render a subtree as indented text and
 * match a hand-written template against it.
 *
 * Template format, one node per line, children indented under a
 * trailing colon:
 *
 *     - heading "Todos" [level=1]
 *     - list:
 *       - listitem "Buy milk"
 *       - listitem /walk/i
 *     - checkbox "Done" [checked]
 *     - button "Add"
 *
 * A role is an ARIA role name (or a wire role code). The name is a
 * quoted string, matched whole after whitespace is collapsed, or a
 * /regex/flags; leaving it out matches any name. `[level=N]` and
 * `[checked]` constrain attributes.
 *
 * Matching is structural but forgiving: template siblings must appear
 * in document order, and a template child may sit at any depth under
 * its parent, so wrapper elements in the page do not break a template.
 * Nodes the template does not mention are ignored.
 */

import { ROLE_TO_CODES } from './roles.ts';
import type { Snapshot, TreeNode } from './tree.ts';

export interface TemplateNode {
  role: string;
  name?: string | RegExp;
  attrs: Record<string, string>;
  children: TemplateNode[];
  line: number;
}

const CODE_TO_ROLE: Record<string, string> = {};
for (const [role, codes] of Object.entries(ROLE_TO_CODES)) {
  for (const code of codes) CODE_TO_ROLE[code] ??= role;
}
CODE_TO_ROLE['lbl'] ??= 'label';
CODE_TO_ROLE['hdr'] = 'banner';

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Role name for a wire code, falling back to the code itself. */
export function roleName(code: string): string {
  return CODE_TO_ROLE[code] ?? code;
}

function roleMatches(want: string, code: string): boolean {
  if (want === code) return true;
  const codes = ROLE_TO_CODES[want];
  if (codes?.includes(code)) return true;
  // `banner` (page header) shares the wire code with columnheader.
  return want === 'banner' && code === 'hdr';
}

/** Parse a template. Throws with the line number on malformed input. */
export function parseTemplate(text: string): TemplateNode[] {
  const roots: TemplateNode[] = [];
  const stack: { indent: number; node: TemplateNode }[] = [];
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    if (raw.trim() === '') return;
    const indent = raw.length - raw.trimStart().length;
    const m = /^-\s+([A-Za-z]+)(.*)$/.exec(raw.trim());
    if (!m) throw new Error(`aria template line ${i + 1}: expected "- role ...", got ${JSON.stringify(raw.trim())}`);
    const role = m[1]!;
    let rest = m[2]!.trim();
    if (rest.endsWith(':')) rest = rest.slice(0, -1).trim();
    const node: TemplateNode = { role, attrs: {}, children: [], line: i + 1 };
    const str = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
    const re = /^\/((?:[^/\\]|\\.)+)\/([a-z]*)/.exec(rest);
    if (str) {
      node.name = str[1]!.replace(/\\(.)/g, '$1');
      rest = rest.slice(str[0].length).trim();
    } else if (re) {
      node.name = new RegExp(re[1]!, re[2]);
      rest = rest.slice(re[0].length).trim();
    }
    for (const a of rest.matchAll(/\[([a-z]+)(?:=([^\]]*))?\]/g)) {
      node.attrs[a[1]!] = a[2] ?? '';
    }
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  });
  return roots;
}

/** The text a node is known by: its label, or for a form field its <label> text when present. */
function names(node: TreeNode): string[] {
  const out = [normalize(node.label)];
  const lbl = node.attrs['lbl'];
  if (lbl) out.push(normalize(lbl));
  return out;
}

function nodeMatches(t: TemplateNode, n: TreeNode): boolean {
  if (!roleMatches(t.role, n.role)) return false;
  if (t.name !== undefined) {
    const want = t.name;
    const ok = names(n).some((s) => (want instanceof RegExp ? want.test(s) : s === normalize(want)));
    if (!ok) return false;
  }
  for (const [k, v] of Object.entries(t.attrs)) {
    if (k === 'checked') {
      const checked = n.attrs['checked'] === '1';
      if (checked !== (v === '' || v === 'true')) return false;
    } else if (n.attrs[k] !== v) {
      return false;
    }
  }
  return true;
}

/** Descendants of `refs` in document order, each with the index just past its subtree. */
function flatten(snap: Snapshot, refs: number[]): { node: TreeNode; end: number }[] {
  const out: { node: TreeNode; end: number }[] = [];
  const visit = (ref: number) => {
    const node = snap.nodes.get(ref);
    if (!node) return;
    const slot = { node, end: 0 };
    out.push(slot);
    for (const c of node.children) visit(c);
    slot.end = out.length;
  };
  for (const r of refs) visit(r);
  return out;
}

/**
 * Match template siblings, in order, against a document-ordered node
 * list. Each template node takes the first viable node; a later sibling
 * must start after the previous one's subtree. Backtracks when a
 * greedy pick starves a later sibling.
 */
function matchSeq(
  flat: { node: TreeNode; end: number }[],
  from: number,
  to: number,
  tmpl: TemplateNode[],
): boolean {
  if (tmpl.length === 0) return true;
  const [head, ...tail] = tmpl;
  for (let i = from; i < to; i++) {
    const slot = flat[i]!;
    if (!nodeMatches(head!, slot.node)) continue;
    if (!matchSeq(flat, i + 1, slot.end, head!.children)) continue;
    if (matchSeq(flat, slot.end, to, tail)) return true;
  }
  return false;
}

/** True when the template matches somewhere within the subtrees rooted at `scope`. */
export function matchesTemplate(snap: Snapshot, scope: number[], template: TemplateNode[]): boolean {
  const flat = flatten(snap, scope);
  return matchSeq(flat, 0, flat.length, template);
}

/**
 * Render subtrees as template text. Unnamed generic wrappers are
 * dropped and their children lifted, so the output reads like the page
 * and pastes straight back in as a template.
 */
export function renderSnapshot(snap: Snapshot, scope: number[]): string {
  const lines: string[] = [];
  const visit = (ref: number, depth: number) => {
    const node = snap.nodes.get(ref);
    if (!node) return;
    const label = normalize(node.label);
    const wrapper = (node.role === 'el' || node.role === 'doc') && label === '';
    if (wrapper || node.role === 'doc') {
      for (const c of node.children) visit(c, depth);
      return;
    }
    let line = `${'  '.repeat(depth)}- ${roleName(node.role)}`;
    // A form field's label is its value; show the <label> text instead when there is one.
    const lbl = node.attrs['lbl'];
    const shown = lbl ? normalize(lbl) : label;
    if (shown) line += ` ${JSON.stringify(shown)}`;
    if (node.attrs['level']) line += ` [level=${node.attrs['level']}]`;
    if (node.attrs['checked'] === '1') line += ' [checked]';
    const at = lines.push(line) - 1;
    for (const c of node.children) visit(c, depth + 1);
    if (lines.length > at + 1) lines[at] += ':';
  };
  for (const r of scope) visit(r, 0);
  return lines.join('\n');
}
