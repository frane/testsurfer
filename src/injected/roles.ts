// @ts-nocheck
/**
 * ARIA roles and accessible names (getByRole, getByLabel).
 *
 * Part of the page-side locator engine (see src/injected/index.ts):
 * plain browser JavaScript, bundled into one script by
 * scripts/build-injected.mjs.
 */

import { Set } from './realm.ts';
import { N, allUnder, parentOf, styleOf, tag } from './basics.ts';
import { SKIP_TEXT, matcher } from './text.ts';
import { hiddenForAria } from './visibility.ts';

export const attr = (e, n) => (e.getAttribute ? e.getAttribute(n) : null);

function landmarkScoped(e) {
  for (let a = parentOf(e); a; a = parentOf(a)) {
    if (/^(article|aside|main|nav|section)$/.test(tag(a))) return true;
    if (/^(article|complementary|main|navigation|region)$/.test(attr(a, 'role') || '')) return true;
  }
  return false;
}

function implicitRole(e) {
  const t = tag(e);
  const type = (attr(e, 'type') || '').toLowerCase();
  switch (t) {
    case 'a':
    case 'area':
      return e.hasAttribute('href') ? 'link' : null;
    case 'article': return 'article';
    case 'aside': return 'complementary';
    case 'blockquote': return 'blockquote';
    case 'button': return 'button';
    case 'caption': return 'caption';
    case 'code': return 'code';
    case 'datalist': return 'listbox';
    case 'dd': return 'definition';
    case 'del': return 'deletion';
    case 'details': return 'group';
    case 'dfn': return 'term';
    case 'dialog': return 'dialog';
    case 'dt': return 'term';
    case 'em': return 'emphasis';
    case 'fieldset': return 'group';
    case 'figure': return 'figure';
    case 'footer': return landmarkScoped(e) ? null : 'contentinfo';
    case 'header': return landmarkScoped(e) ? null : 'banner';
    case 'form': return accName(e) ? 'form' : null;
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
    case 'hr': return 'separator';
    case 'html': return 'document';
    case 'img':
      return attr(e, 'alt') === '' && !attr(e, 'title') && !attr(e, 'aria-label') && !attr(e, 'aria-labelledby')
        ? 'presentation'
        : 'img';
    case 'input':
      switch (type) {
        case 'button': case 'image': case 'reset': case 'submit': return 'button';
        case 'checkbox': return 'checkbox';
        case 'radio': return 'radio';
        case 'range': return 'slider';
        case 'number': return 'spinbutton';
        case 'hidden': return null;
        case 'file': return 'button';
        case 'search': return e.hasAttribute('list') ? 'combobox' : 'searchbox';
        default: return e.hasAttribute('list') ? 'combobox' : 'textbox';
      }
    case 'ins': return 'insertion';
    case 'li': return 'listitem';
    case 'main': return 'main';
    case 'math': return 'math';
    case 'menu': return 'list';
    case 'meter': return 'meter';
    case 'nav': return 'navigation';
    case 'ol': case 'ul': return 'list';
    case 'optgroup': return 'group';
    case 'option': return 'option';
    case 'output': return 'status';
    case 'p': return 'paragraph';
    case 'progress': return 'progressbar';
    case 'search': return 'search';
    case 'section': return accName(e) ? 'region' : null;
    case 'select': return e.multiple || e.size > 1 ? 'listbox' : 'combobox';
    case 'strong': return 'strong';
    case 'sub': return 'subscript';
    case 'sup': return 'superscript';
    case 'svg': return 'img';
    case 'table': return 'table';
    case 'tbody': case 'thead': case 'tfoot': return 'rowgroup';
    case 'td': {
      const tbl = e.closest('table');
      const r = tbl && attr(tbl, 'role');
      return r === 'grid' || r === 'treegrid' ? 'gridcell' : 'cell';
    }
    case 'th': {
      const scope = attr(e, 'scope');
      if (scope === 'row' || scope === 'rowgroup') return 'rowheader';
      return 'columnheader';
    }
    case 'textarea': return 'textbox';
    case 'time': return 'time';
    case 'tr': return 'row';
  }
  return null;
}

export function roleOf(e) {
  const explicit = (attr(e, 'role') || '').trim().split(/\s+/)[0];
  if (explicit) return explicit === 'none' ? 'presentation' : explicit;
  return implicitRole(e);
}

/** The role without the name-dependent cases (form, section), for use inside name computation. */
function roleForName(e) {
  const t = tag(e);
  if (!attr(e, 'role') && (t === 'form' || t === 'section')) return null;
  return roleOf(e);
}

const NAME_FROM_CONTENT = new Set([
  'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab',
  'tooltip', 'treeitem', 'listitem', 'term', 'definition',
]);

/** CSS generated content (::before / ::after), which accessible names include. */
function pseudoText(e, which) {
  try {
    const c = (e.ownerDocument.defaultView || window).getComputedStyle(e, which).content;
    if (!c || c === 'none' || c === 'normal') return '';
    const m = /^(["'])([\s\S]*)\1$/.exec(c);
    return m ? m[2] : '';
  } catch (_) {
    return '';
  }
}

function contentName(e, skip, visited) {
  let out = pseudoText(e, '::before');
  const add = (s) => {
    out += s;
  };
  const kids = e.shadowRoot ? [...e.shadowRoot.childNodes, ...e.childNodes] : [...e.childNodes];
  for (const c of kids) {
    if (c.nodeType === 3) {
      add(c.nodeValue);
      continue;
    }
    if (c.nodeType !== 1 || c === skip || SKIP_TEXT[c.nodeName]) continue;
    if (hiddenForAria(c)) continue;
    const block = /^(block|flex|grid|list-item|table)/.test(styleOf(c).display);
    if (block) add(' ');
    if (c.nodeName === 'SLOT') {
      for (const s of c.assignedNodes()) add(s.nodeType === 3 ? s.nodeValue : textAlternative(s, skip, visited, true));
    } else add(textAlternative(c, skip, visited, true));
    if (block) add(' ');
  }
  out += pseudoText(e, '::after');
  return out;
}

/** A simplified accname computation: labelledby, aria-label, native labels, content, title. */
function textAlternative(e, skip, visited, embedded) {
  visited = visited || new Set();
  if (visited.has(e)) return '';
  visited.add(e);
  const lb = attr(e, 'aria-labelledby');
  if (lb && !embedded) {
    const doc = e.getRootNode();
    const parts = lb.split(/\s+/).map((id) => {
      const t = doc.getElementById ? doc.getElementById(id) : e.ownerDocument.getElementById(id);
      return t ? textAlternative(t, skip, visited, true) || N(t.textContent) : '';
    });
    const s = N(parts.join(' '));
    if (s) return s;
  }
  const al = N(attr(e, 'aria-label'));
  if (al) return al;
  const t = tag(e);
  if (t === 'input') {
    const type = (e.type || '').toLowerCase();
    if (embedded && !/^(button|submit|reset|image)$/.test(type)) return e.value || '';
    if (/^(button|submit|reset)$/.test(type)) return e.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
    if (type === 'image') return attr(e, 'alt') || attr(e, 'title') || 'Submit';
  }
  if (embedded && t === 'select') {
    const o = e.selectedOptions && e.selectedOptions[0];
    return o ? N(o.textContent) : '';
  }
  if (embedded && t === 'textarea') return e.value || '';
  if (!embedded && e.labels && e.labels.length && t !== 'button') {
    const s = N([...e.labels].map((l) => contentName(l, e, visited)).join(' '));
    if (s) return s;
  }
  if (t === 'img' || t === 'area') {
    const alt = attr(e, 'alt');
    if (alt) return alt;
  }
  if (t === 'fieldset') {
    const lg = [...e.children].find((c) => tag(c) === 'legend');
    if (lg) return N(contentName(lg, null, visited));
  }
  if (t === 'figure') {
    const fc = [...e.children].find((c) => tag(c) === 'figcaption');
    if (fc) return N(contentName(fc, null, visited));
  }
  if (t === 'table' && e.caption) return N(contentName(e.caption, null, visited));
  if (t === 'svg') {
    const st = [...e.children].find((c) => tag(c) === 'title');
    if (st) return N(st.textContent);
  }
  const role = roleForName(e);
  if (embedded || NAME_FROM_CONTENT.has(role)) {
    const s = contentName(e, skip, visited);
    if (N(s)) return s;
  }
  return attr(e, 'title') || (!embedded && /^(input|textarea)$/.test(t) ? attr(e, 'placeholder') || '' : '');
}

export function accName(e) {
  return N(textAlternative(e, null, null, false));
}

export function ariaChecked(e) {
  if (tag(e) === 'input' && /^(checkbox|radio)$/i.test(e.type)) return e.indeterminate ? 'mixed' : e.checked;
  const a = attr(e, 'aria-checked');
  if (a === 'mixed') return 'mixed';
  if (a === 'true') return true;
  if (a === 'false') return false;
  return undefined;
}

export function isDisabled(e) {
  if (/^(button|input|select|textarea|option|optgroup|fieldset)$/.test(tag(e))) {
    if (e.disabled) return true;
    if (tag(e) === 'option' && e.parentElement && tag(e.parentElement) === 'optgroup' && e.parentElement.disabled) return true;
    const fs = e.closest && e.closest('fieldset[disabled]');
    if (fs) {
      const lg = [...fs.children].find((c) => tag(c) === 'legend');
      if (!lg || !lg.contains(e)) return true;
    }
  }
  // aria-disabled reaches down only to elements that can be disabled.
  if (attr(e, 'aria-disabled') === 'true') return true;
  const native = /^(button|input|select|textarea|option|optgroup|fieldset)$/.test(tag(e));
  if (!native && !DISABLEABLE.has(roleOf(e) || '')) return false;
  for (let a = parentOf(e); a; a = parentOf(a)) if (attr(a, 'aria-disabled') === 'true') return true;
  return false;
}

const DISABLEABLE = new Set([
  'application', 'button', 'checkbox', 'columnheader', 'combobox', 'grid', 'gridcell', 'group', 'link',
  'listbox', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio',
  'radiogroup', 'row', 'rowheader', 'scrollbar', 'searchbox', 'separator', 'slider', 'spinbutton',
  'switch', 'tab', 'tablist', 'textbox', 'toolbar', 'tree', 'treegrid', 'treeitem',
]);

export function roleQuery(root, q) {
  const o = q.o || {};
  const name = o.name ? matcher(o.name) : null;
  return allUnder(root).filter((e) => {
    if (roleOf(e) !== q.role) return false;
    if (!o.includeHidden && hiddenForAria(e)) return false;
    if (o.checked !== undefined && (ariaChecked(e) ?? false) !== o.checked) return false;
    if (o.disabled !== undefined && isDisabled(e) !== o.disabled) return false;
    if (o.expanded !== undefined) {
      const x = attr(e, 'aria-expanded');
      if (x === null || (x === 'true') !== o.expanded) return false;
    }
    if (o.pressed !== undefined) {
      const p = attr(e, 'aria-pressed');
      const v = p === 'mixed' ? 'mixed' : p === 'true';
      if (v !== o.pressed) return false;
    }
    if (o.selected !== undefined) {
      const s = tag(e) === 'option' ? e.selected : attr(e, 'aria-selected') === 'true';
      if (s !== o.selected) return false;
    }
    if (o.level !== undefined) {
      const m = /^h([1-6])$/.exec(tag(e));
      const lvl = Number(attr(e, 'aria-level')) || (m ? Number(m[1]) : 0);
      if (lvl !== o.level) return false;
    }
    if (name && !name(accName(e))) return false;
    return true;
  });
}

function labelsOf(e) {
  const out = [];
  if (e.labels) for (const l of e.labels) out.push(contentName(l, e));
  const lb = attr(e, 'aria-labelledby');
  if (lb) {
    for (const id of lb.split(/\s+/)) {
      const t = e.ownerDocument.getElementById(id);
      if (t) out.push(t.textContent);
    }
  }
  const al = attr(e, 'aria-label');
  if (al) out.push(al);
  return out;
}

export function labelQuery(root, m) {
  const ok = matcher(m);
  return allUnder(root).filter((e) => labelsOf(e).some(ok));
}

export function attrQuery(root, q) {
  const ok = q.testid
    ? q.t.re
      ? matcher(q.t)
      : (v) => v === q.t.s
    : matcher(q.t);
  return allUnder(root).filter((e) => {
    const v = attr(e, q.a);
    return v !== null && ok(v);
  });
}
