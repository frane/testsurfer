// @ts-nocheck
/**
 * CSS selectors piercing open shadow roots, with Playwright's pseudo-classes.
 *
 * Part of the page-side locator engine (see src/injected/index.ts):
 * plain browser JavaScript, bundled into one script by
 * scripts/build-injected.mjs.
 */

import { N, allUnder, contains, parentOf } from './basics.ts';
import { SKIP_TEXT, elementText, matcher, strictTextOk } from './text.ts';
import { isVisible } from './visibility.ts';

//
// Playwright's CSS: the descendant combinator pierces open shadow
// roots, :scope and leading combinators refer to the chain's scope
// (so `>> ~ div` finds siblings), comma lists come back in document
// order, and :has-text(), :text(), :text-is(), :text-matches() and
// :visible work in any compound. Each compound is checked with the
// native matches(); combinators are walked here, right to left.

const CUSTOM_PSEUDO = /^(has-text|text|text-is|text-matches|visible|scope|is|where|not|has)$/;
const LIST_PSEUDO = /^(is|where|not|has)$/;

function splitList(s) {
  const out = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += s[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') {
      cur += c + (s[++i] ?? '');
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** A CSS string's value: `\a ` is a newline, `\"` a quote. */
const cssUnescape = (s) =>
  s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));
const unq = (v) => {
  const m = /^\s*(["'])([\s\S]*)\1\s*$/.exec(v);
  return m ? cssUnescape(m[2]) : v.trim();
};

/** One compound: native part for matches(), plus Playwright's own pseudos. */
function compound(src) {
  let native = '';
  const custom = [];
  let depth = 0;
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      native += c;
      if (c === '\\') native += src[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') {
      native += c + (src[++i] ?? '');
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ':' && depth === 0 && src[i + 1] !== ':') {
      const m = /^:([a-zA-Z-]+)/.exec(src.slice(i));
      if (m && CUSTOM_PSEUDO.test(m[1])) {
        let j = i + m[0].length;
        let args = '';
        if (src[j] === '(') {
          let d = 0;
          let qq = null;
          const s0 = j;
          for (; j < src.length; j++) {
            const ch = src[j];
            if (qq) {
              if (ch === '\\') j++;
              else if (ch === qq) qq = null;
              continue;
            }
            if (ch === '"' || ch === "'") qq = ch;
            else if (ch === '(') d++;
            else if (ch === ')' && --d === 0) break;
          }
          args = src.slice(s0 + 1, j);
          j++;
        }
        custom.push(
          LIST_PSEUDO.test(m[1])
            ? { name: m[1], list: splitList(args).map((x) => complex(x.trim())) }
            : { name: m[1], args: splitList(args).map(unq), raw: args },
        );
        i = j - 1;
        continue;
      }
    }
    native += c;
  }
  return { native: native.trim() || '*', custom };
}

/** A complex selector as [compound, combinator, compound, ...]; a leading combinator gets :scope. */
function complex(sel) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let quote = null;
  const push = () => {
    if (cur.trim()) parts.push(compound(cur.trim()));
    cur = '';
  };
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += sel[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') {
      cur += c + (sel[++i] ?? '');
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) {
      push();
      let comb = ' ';
      let j = i;
      while (j < sel.length && /[\s>+~]/.test(sel[j])) {
        if (!/\s/.test(sel[j])) comb = sel[j];
        j++;
      }
      i = j - 1;
      if (parts.length === 0) {
        if (comb !== ' ') parts.push(compound(':scope'), comb);
      } else if (j < sel.length) parts.push(comb);
      continue;
    }
    cur += c;
  }
  push();
  return parts;
}

function customOk(e, c, scope) {
  switch (c.name) {
    case 'scope':
      return e === scope;
    case 'is':
    case 'where':
      return c.list.some((parts) => matchComplex(e, parts, parts.length - 1, scope, null, false));
    case 'not':
      return !c.list.some((parts) => matchComplex(e, parts, parts.length - 1, scope, null, false));
    case 'has':
      // Inside :has(), :scope is the element being tested.
      {
        // Sibling combinators can reach outside the element, so search its whole tree then.
        const wide = c.list.some((parts) => parts.includes('+') || parts.includes('~'));
        const pool = wide ? allUnder(e.getRootNode()) : [e, ...allUnder(e)];
        return pool.some((d) => c.list.some((parts) => matchComplex(d, parts, parts.length - 1, e, e, false)));
      }
  }
  if (/^(has-text|text|text-is)$/.test(c.name)) {
    const raw = (c.raw || '').trim();
    if (c.args.length !== 1 || (!/^(["'])[\s\S]*\1$/.test(raw) && /[\s>+~,]/.test(raw))) {
      throw new Error(`Error: "${c.name === 'has-text' ? 'has-text' : 'text'}" engine expects a single string`);
    }
  }
  if (c.name !== 'visible' && (SKIP_TEXT[e.nodeName] || (e.closest && e.closest('head')))) return false;
  const t = elementText(e);
  const own = (ok) => {
    if (!ok(t)) return false;
    for (let k = e.firstElementChild; k; k = k.nextElementSibling) if (ok(elementText(k))) return false;
    return true;
  };
  switch (c.name) {
    case 'has-text':
      return matcher({ s: c.args[0] || '' })(t);
    case 'text':
      return own(matcher({ s: c.args[0] || '' }));
    case 'text-is':
      return strictTextOk(e, N(c.args[0] || ''));
    case 'text-matches':
      return own(matcher({ re: [c.args[0] || '', c.args[1] || ''] }));
    case 'visible':
      return isVisible(e);
  }
  return false;
}

export function cssError(sel) {
  let bad = sel[sel.length - 1];
  const stack = [];
  for (const ch of sel) {
    if (ch === '[' || ch === '(') stack.push(ch);
    else if (ch === ']' || ch === ')') {
      if (!stack.length || stack.pop() !== (ch === ']' ? '[' : '(')) {
        bad = ch;
        break;
      }
    }
  }
  return new Error(`Error: Unexpected token "${bad}" while parsing css selector "${sel}". Did you mean to CSS.escape it?`);
}

/** A compound that names :scope, directly or inside :is()/:not()/... */
function hasScope(c) {
  // A :scope inside :has() is :has's own element, not this one.
  return c.custom.some(
    (x) => x.name === 'scope' || (x.name !== 'has' && (x.list || []).some((parts) => parts.some((p) => typeof p === 'object' && hasScope(p)))),
  );
}

/** Index of the first compound naming :scope at its top level, or -1. Cached on the parts array. */
function scopeIndex(parts) {
  if (parts.sIdx === undefined) {
    parts.sIdx = -1;
    for (let i = 0; i < parts.length; i += 2) {
      if (parts[i].custom.some((x) => x.name === 'scope')) {
        parts.sIdx = i;
        break;
      }
    }
  }
  return parts.sIdx;
}

/**
 * Does `el` match compound i of `parts`, walking combinators
 * leftward? With `bound`, matching starts at that element, as in
 * jQuery and Playwright: a compound that does not name :scope must
 * match inside it when it is the subject or an ancestor step (`>`,
 * descendant); sibling steps may leave it, so `:scope ~ div` and
 * `#a ~ :scope` work.
 */
function matchComplex(el, parts, i, scope, bound, viaAncestor) {
  const c = parts[i];
  if (!el || el.nodeType !== 1 || !el.matches(c.native)) return false;
  // The subject is bounded unless the selector names :scope (then
  // :scope fixes where matching starts); ancestor steps always are.
  const subjectBound = i === parts.length - 1 && scopeIndex(parts) < 0;
  if (bound && (subjectBound || viaAncestor) && !(contains(bound, el) && (el !== bound || hasScope(c)))) return false;
  for (const x of c.custom) if (!customOk(el, x, scope)) return false;
  if (i === 0) return true;
  switch (parts[i - 1]) {
    case '>':
      return matchComplex(parentOf(el), parts, i - 2, scope, bound, true);
    case '+':
      return matchComplex(el.previousElementSibling, parts, i - 2, scope, bound, false);
    case '~':
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) if (matchComplex(s, parts, i - 2, scope, bound, false)) return true;
      return false;
    default:
      for (let p = parentOf(el); p; p = parentOf(p)) if (matchComplex(p, parts, i - 2, scope, bound, true)) return true;
      return false;
  }
}

function validate(doc, parts, sel) {
  for (let i = 0; i < parts.length; i += 2) {
    try {
      doc.querySelector(parts[i].native);
    } catch (_) {
      throw cssError(sel);
    }
    for (const x of parts[i].custom) for (const sub of x.list || []) validate(doc, sub, sel);
  }
}

export function cssQuery(root, q) {
  const scopeEl = root.nodeType === 9 ? root.documentElement : root.nodeType === 11 ? root.host : root;
  const lists = splitList(q.sel).map((s) => s.trim()).filter(Boolean);
  if (!lists.length) throw cssError(q.sel);
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  const parsed = lists.map((l) => complex(l));
  for (const parts of parsed) validate(doc, parts, q.sel);
  // :scope can reach siblings and the scope itself, so search the
  // whole tree the scope lives in; otherwise only below it.
  let pool;
  if (/:scope/.test(q.sel) || parsed.some((parts) => parts[0].custom.some((c) => c.name === 'scope'))) {
    const top = scopeEl.getRootNode();
    pool = allUnder(top);
    if (top.nodeType === 11) pool.unshift(top.host);
  } else pool = allUnder(root);
  // Chained off an element (or a shadow root), matching is bounded by it.
  const bound = root.nodeType === 9 ? null : scopeEl;
  if (bound && root.nodeType === 1) pool = [root, ...pool.filter((x) => x !== root)];
  return pool.filter((e) => parsed.some((parts) => matchComplex(e, parts, parts.length - 1, scopeEl, bound, false)));
}

export function xpathQuery(root, q) {
  let xp = q.xp;
  if (root.nodeType !== 9 && xp.startsWith('/')) xp = '.' + xp;
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  const r = doc.evaluate(xp, root, null, 7, null);
  const out = [];
  for (let i = 0; i < r.snapshotLength; i++) {
    const n = r.snapshotItem(i);
    if (n && n.nodeType === 1) out.push(n);
  }
  return out;
}
