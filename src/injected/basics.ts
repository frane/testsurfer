// @ts-nocheck
/**
 * Text normalization, parents across shadow roots, elements in document order, attributes.
 *
 * Part of the page-side locator engine (see src/injected/index.ts):
 * plain browser JavaScript, bundled into one script by
 * scripts/build-injected.mjs.
 */

import { Map, Set } from './realm.ts';

export const N = (s) => String(s == null ? '' : s).replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');

/** A label stands in for its control in value, check and fill operations, as in Playwright. */
export const retarget = (e) => (e.nodeName === 'LABEL' && e.control ? e.control : e);

export function parentOf(e) {
  if (e.parentElement) return e.parentElement;
  const p = e.parentNode;
  return p && p.nodeType === 11 && p.host ? p.host : null;
}

export function contains(a, b) {
  for (let e = b; e; e = parentOf(e)) if (e === a) return true;
  return false;
}

/** Elements under `root` in document order, entering open shadow roots. */
export function allUnder(root, out) {
  if (!out) {
    // A scope element's own shadow root is part of its subtree, after its light children.
    const top = [];
    allUnder(root, top);
    if (root.nodeType === 1 && root.shadowRoot) allUnder(root.shadowRoot, top);
    return top;
  }
  const kids = root.children || (root.nodeType === 9 ? [root.documentElement] : root.childNodes);
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (!c || c.nodeType !== 1) continue;
    out.push(c);
    // Light children before shadow content, as Playwright orders them.
    allUnder(c, out);
    if (c.shadowRoot) allUnder(c.shadowRoot, out);
  }
  return out;
}

export function docOrder(list) {
  const seen = new Set();
  const uniq = list.filter((e) => (seen.has(e) ? false : (seen.add(e), true)));
  if (uniq.length < 2) return uniq;
  const rank = new Map();
  const roots = new Set(uniq.map((e) => e.ownerDocument));
  for (const d of roots) allUnder(d).forEach((e, i) => rank.set(e, i));
  return uniq.sort((a, b) => {
    if (a.ownerDocument !== b.ownerDocument) {
      return a.ownerDocument.compareDocumentPosition(b.ownerDocument) & 4 ? -1 : 1;
    }
    return (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  });
}

export function styleOf(e) {
  const w = e.ownerDocument.defaultView || window;
  return w.getComputedStyle(e);
}

export const tag = (e) => e.nodeName.toLowerCase();
