// @ts-nocheck
/**
 * Elements as Playwright previews them in logs and strict-mode errors.
 *
 * Part of the page-side locator engine (see src/injected/index.ts):
 * plain browser JavaScript, bundled into one script by
 * scripts/build-injected.mjs.
 */

import { Set } from './realm.ts';
import { N, tag } from './basics.ts';
import { elementText } from './text.ts';
import { accName, attr, roleOf } from './roles.ts';

const VOID = new Set(['AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT', 'KEYGEN', 'LINK', 'MENUITEM', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
const BOOL_ATTR = new Set(['checked', 'selected', 'disabled', 'readonly', 'multiple']);
const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + '\u2026' : s);

/** An element as Playwright previews it in logs and strict-mode errors. */
export function preview(e) {
  if (e.nodeType === 9) return '#document';
  if (e.nodeType === 11) return '#document-fragment';
  const name = tag(e);
  const attrs = [...e.attributes]
    .filter((a) => a.name !== 'style' && a.name !== 'data-vs-ref')
    .map((a) => (!a.value && BOOL_ATTR.has(a.name) ? ` ${a.name}` : ` ${a.name}="${a.value}"`))
    .sort((a, b) => a.length - b.length);
  const at = trim(attrs.join(''), 500);
  const line = (s) => s.replace(/\n/g, '↵').replace(/\t/g, '⇆');
  if (VOID.has(e.nodeName)) return line(`<${name}${at}/>`);
  const kids = e.childNodes;
  let onlyText = kids.length <= 5;
  for (const c of kids) onlyText = onlyText && c.nodeType === 3;
  const text = onlyText ? e.textContent || '' : kids.length ? '\u2026' : '';
  return line(`<${name}${at}>${trim(text, 50)}</${name}>`);
}

/** A short locator for an element, for strict-mode lists (Playwright's "aka"). */
export function aka(e) {
  const qs = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const tid = attr(e, 'data-testid');
  if (tid) return `getByTestId(${qs(tid)})`;
  const role = roleOf(e);
  const name = role ? accName(e) : '';
  if (role && name && !/^(generic|presentation|paragraph)$/.test(role)) return `getByRole(${qs(role)}, { name: ${qs(name)} })`;
  const text = N(elementText(e));
  if (text && text.length <= 80) return `getByText(${qs(text)})`;
  if (role) return `getByRole(${qs(role)})`;
  if (e.id) return `locator(${qs('#' + e.id)})`;
  return `locator(${qs(tag(e))})`;
}
