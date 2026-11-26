// @ts-nocheck
/**
 * Resolving a locator's chain of steps to elements.
 *
 * Part of the page-side locator engine (see src/injected/index.ts):
 * plain browser JavaScript, bundled into one script by
 * scripts/build-injected.mjs.
 */

import { Set } from './realm.ts';
import { docOrder } from './basics.ts';
import { elementText, matcher, textQuery } from './text.ts';
import { isVisible, topRect } from './visibility.ts';
import { attrQuery, labelQuery, roleQuery } from './roles.ts';
import { cssError, cssQuery, xpathQuery } from './css.ts';
import { aka, preview } from './descriptions.ts';
import { HANDLES, isEl } from './handles.ts';

function query(root, q) {
  switch (q.k) {
    case 'css':
      if (q.light) {
        try {
          return [...root.querySelectorAll(q.sel)];
        } catch (_) {
          throw cssError(q.sel);
        }
      }
      return cssQuery(root, q);
    case 'xpath': return xpathQuery(root, q);
    case 'text': {
      const found = textQuery(root, q.t, q.legacy);
      // :light skips matches inside shadow roots.
      return q.light ? found.filter((e) => !(e.getRootNode() instanceof ShadowRoot)) : found;
    }
    case 'role': return roleQuery(root, q);
    case 'label': return labelQuery(root, q.t);
    case 'attr': return attrQuery(root, q);
    case 'and': {
      const right = new Set(resolve(q.r, [root]));
      return resolve(q.l, [root]).filter((e) => right.has(e));
    }
    case 'or': return docOrder([...resolve(q.l, [root]), ...resolve(q.r, [root])]);
  }
  throw new Error('unknown query ' + q.k);
}

function applyFilter(els, f) {
  if (f.hasText) {
    const ok = matcher(f.hasText);
    els = els.filter((e) => ok(elementText(e)));
  }
  if (f.hasNotText) {
    const ok = matcher(f.hasNotText);
    els = els.filter((e) => !ok(elementText(e)));
  }
  if (f.has) els = els.filter((e) => resolve(f.has, [e]).length > 0);
  if (f.hasNot) els = els.filter((e) => resolve(f.hasNot, [e]).length === 0);
  if (f.visible !== undefined) els = els.filter((e) => isVisible(e) === f.visible);
  return els;
}

function pick(els, i) {
  const e = i < 0 ? els[els.length + i] : els[i];
  return e ? [e] : [];
}

/** Run a step chain. Each step searches inside the previous step's matches. */
export function resolve(steps, roots) {
  let cur = roots;
  for (let si = 0; si < steps.length; si++) {
    const s = steps[si];
    if (s.q.k === 'self') {
      let out = cur.filter((e) => e.nodeType === 1);
      for (const f of s.f || []) out = applyFilter(out, f);
      if (s.i !== null && s.i !== undefined) out = pick(out, s.i);
      cur = out;
    } else if (s.q.k === 'handle') {
      const v = HANDLES.get(s.q.id);
      let out = isEl(v) ? [v] : [];
      for (const f of s.f || []) out = applyFilter(out, f);
      cur = out;
    } else if (s.q.k === 'frame') {
      // A frame hop needs exactly one <iframe> (first/last/nth pick one).
      if (cur.length > 1) {
        throw new Error(
          `Error: strict mode violation: ${s.q.d} resolved to ${cur.length} elements:\n` +
            cur.slice(0, 10).map((e, i) => `    ${i + 1}) ${preview(e)} aka ${aka(e)}`).join('\n'),
        );
      }
      for (const e of cur) {
        if (e.nodeType === 1 && e.nodeName !== 'IFRAME' && e.nodeName !== 'FRAME') {
          throw new Error(`Error: ${s.q.d} resolved to ${preview(e)}, <iframe> was expected`);
        }
      }
      const docs = cur
        .map((e) => {
          try {
            return e.contentDocument;
          } catch (_) {
            return null;
          }
        })
        .filter(Boolean);
      // A cross-origin frame has a window but no document we may
      // read: the rest of the chain has to run inside it. Node does
      // that (`vs inspect eval --frame`) and moves points by `x, y`,
      // where the frame's content box sits in the top viewport.
      const xo = cur.length === 1 && docs.length === 0 && cur[0].contentWindow ? cur[0] : null;
      if (xo && steps.length > si + 1) {
        const t = topRect(xo);
        const cs = getComputedStyle(xo);
        const err = new Error(
          JSON.stringify({
            url: xo.src,
            rest: si + 1,
            x: t.x + xo.clientLeft + parseFloat(cs.paddingLeft || '0'),
            y: t.y + xo.clientTop + parseFloat(cs.paddingTop || '0'),
          }),
        );
        err.name = 'XOFrame';
        throw err;
      }
      cur = docs;
    } else {
      let out = [];
      for (const r of cur) out.push(...query(r, s.q));
      out = cur.length > 1 ? docOrder(out) : out;
      for (const f of s.f || []) out = applyFilter(out, f);
      if (s.i !== null && s.i !== undefined) out = pick(out, s.i);
      cur = out;
    }
  }
  return cur;
}
