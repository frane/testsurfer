// @ts-nocheck
/**
 * Element text as Playwright's text selectors and getByText see it.
 *
 * Part of the page-side locator engine (see src/injected/index.ts):
 * plain browser JavaScript, bundled into one script by
 * scripts/build-injected.mjs.
 */

import { Map } from './realm.ts';
import { N, allUnder } from './basics.ts';

export const SKIP_TEXT = { SCRIPT: 1, NOSCRIPT: 1, STYLE: 1, TEMPLATE: 1, HEAD: 1 };
let textCache = new Map();
/** Element text is cached for one engine call (one resolution). */
export const resetTextCache = () => {
  textCache = new Map();
};

export function elementText(e) {
  if (textCache.has(e)) return textCache.get(e);
  let t = '';
  if (e.nodeType === 1 && SKIP_TEXT[e.nodeName]) t = '';
  else if (e.nodeName === 'INPUT' && /^(button|submit|reset)$/i.test(e.type)) t = e.value;
  else {
    if (e.shadowRoot) t += elementText(e.shadowRoot);
    for (let c = e.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) t += c.nodeValue;
      else if (c.nodeType === 1) t += elementText(c);
    }
  }
  textCache.set(e, t);
  return t;
}

/** {s, exact} or {re:[src, flags]} -> predicate over raw text. */
export function matcher(m, caseSensitiveDefault) {
  if (!m) return () => true;
  if (m.re) {
    const re = new RegExp(m.re[0], m.re[1].replace('g', ''));
    return (t) => re.test(N(t));
  }
  const want = N(m.s);
  if (m.exact) return (t) => N(t) === want;
  if (m.full) return (t) => N(t).toLowerCase() === want.toLowerCase();
  if (caseSensitiveDefault) return (t) => N(t).includes(want);
  const lw = want.toLowerCase();
  return (t) => N(t).toLowerCase().includes(lw);
}

/**
 * Exact text (`text="..."`, getByText exact): an element's full text
 * when it has no child elements, otherwise one of its own text nodes.
 */
export function strictTextOk(e, want) {
  if (!e.firstElementChild) return N(elementText(e)) === want;
  for (let c = e.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && N(c.nodeValue) === want) return true;
  return false;
}

/** Playwright's text engine: the smallest elements whose text matches. */
export function textQuery(root, m, legacy) {
  if (legacy && m && m.exact && !m.re) {
    const want = N(m.s);
    const pool = root.nodeType === 1 ? [root, ...allUnder(root)] : allUnder(root);
    return pool.filter((e) => !SKIP_TEXT[e.nodeName] && !(e.closest && e.closest('head')) && strictTextOk(e, want));
  }
  const ok = matcher(m);
  // A text query chained off an element can match that element itself.
  const pool = root.nodeType === 1 ? [root, ...allUnder(root)] : allUnder(root);
  return pool.filter((e) => {
    if (SKIP_TEXT[e.nodeName] || (e.closest && e.closest('head'))) return false;
    if (!ok(elementText(e))) return false;
    for (let c = e.firstElementChild; c; c = c.nextElementSibling) if (ok(elementText(c))) return false;
    if (e.shadowRoot) for (let c = e.shadowRoot.firstElementChild; c; c = c.nextElementSibling) if (ok(elementText(c))) return false;
    return true;
  });
}
