// @ts-nocheck
/**
 * The page-side locator engine, installed lazily as `window.__tse`.
 *
 * Playwright locators address DOM elements, and most of the DOM (a
 * plain `<div>` with text) never reaches vibesurfer's accessibility
 * tree, so locators resolve here, in the page: CSS (piercing open
 * shadow roots), XPath, text, role, label and attribute queries,
 * chained, filtered and indexed, in one evaluate per call. vibesurfer
 * still supplies trusted pointer input, layout and screenshots.
 *
 * This function is serialized with toString() and evaluated in the
 * page, so it must be self-contained plain JavaScript (the file is
 * excluded from type checking for that reason).
 */
export function installEngine(SER) {
  if (window.__tse) return window.__tse;

  // Page script may have replaced built-ins (window.Map = 1). Use the
  // page's own when they are native, else a clean realm's.
  const isNative = (f) => typeof f === 'function' && /\[native code\]/.test(Function.prototype.toString.call(f));
  let cleanRealm = null;
  const pristine = (name) => {
    if (isNative(window[name])) return window[name];
    if (!cleanRealm) {
      const f = document.createElement('iframe');
      f.style.display = 'none';
      (document.documentElement || document).appendChild(f);
      cleanRealm = f.contentWindow;
      f.remove();
    }
    return cleanRealm[name];
  };
  const Map = pristine('Map');
  const Set = pristine('Set');
  const WeakMap = pristine('WeakMap');
  const WeakRef = pristine('WeakRef');

  // --- basics ---------------------------------------------------------

  const N = (s) => String(s == null ? '' : s).replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');

  /** A label stands in for its control in value, check and fill operations, as in Playwright. */
  const retarget = (e) => (e.nodeName === 'LABEL' && e.control ? e.control : e);

  function parentOf(e) {
    if (e.parentElement) return e.parentElement;
    const p = e.parentNode;
    return p && p.nodeType === 11 && p.host ? p.host : null;
  }

  function contains(a, b) {
    for (let e = b; e; e = parentOf(e)) if (e === a) return true;
    return false;
  }

  /** Elements under `root` in document order, entering open shadow roots. */
  function allUnder(root, out) {
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

  function docOrder(list) {
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

  function styleOf(e) {
    const w = e.ownerDocument.defaultView || window;
    return w.getComputedStyle(e);
  }

  // --- text -------------------------------------------------------------

  const SKIP_TEXT = { SCRIPT: 1, NOSCRIPT: 1, STYLE: 1, TEMPLATE: 1, HEAD: 1 };
  let textCache = new Map();

  function elementText(e) {
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
  function matcher(m, caseSensitiveDefault) {
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
  function strictTextOk(e, want) {
    if (!e.firstElementChild) return N(elementText(e)) === want;
    for (let c = e.firstChild; c; c = c.nextSibling) if (c.nodeType === 3 && N(c.nodeValue) === want) return true;
    return false;
  }

  /** Playwright's text engine: the smallest elements whose text matches. */
  function textQuery(root, m, legacy) {
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

  // --- visibility -------------------------------------------------------

  function isVisible(e) {
    if (!e.isConnected) return false;
    const st = styleOf(e);
    if (st.display === 'contents') {
      for (let c = e.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 1 && isVisible(c)) return true;
        if (c.nodeType === 3) {
          const r = document.createRange();
          r.selectNodeContents(c);
          const b = r.getBoundingClientRect();
          if (b.width > 0 && b.height > 0) return true;
        }
      }
      return false;
    }
    if (st.visibility !== 'visible') return false;
    // Catches content inside a closed <details> and content-visibility.
    if (typeof e.checkVisibility === 'function' && !e.checkVisibility()) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function hiddenForAria(e) {
    if (tag(e) !== 'option' && styleOf(e).visibility === 'hidden') return true;
    // Not rendered: display:none somewhere above, unslotted shadow-host
    // children, closed <details> content. <option> renders inside its
    // select's popup, so only its own display counts.
    if (tag(e) === 'option') {
      if (styleOf(e).display === 'none') return true;
    } else if (typeof e.checkVisibility === 'function' && !e.checkVisibility()) {
      return true;
    }
    for (let a = e; a; a = parentOf(a)) {
      if (a.getAttribute && a.getAttribute('aria-hidden') === 'true') return true;
      if (a.nodeType === 1 && styleOf(a).display === 'none') return true;
    }
    return false;
  }

  /** Rect in the top document's viewport, adding iframe offsets. */
  function topRect(e) {
    const r = e.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    let w = e.ownerDocument.defaultView;
    while (w && w.frameElement) {
      const f = w.frameElement;
      const fr = f.getBoundingClientRect();
      x += fr.left + f.clientLeft;
      y += fr.top + f.clientTop;
      w = f.ownerDocument.defaultView;
    }
    return { x, y, width: r.width, height: r.height };
  }

  // --- roles and names --------------------------------------------------

  const tag = (e) => e.nodeName.toLowerCase();
  const attr = (e, n) => (e.getAttribute ? e.getAttribute(n) : null);

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

  function roleOf(e) {
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

  function accName(e) {
    return N(textAlternative(e, null, null, false));
  }

  function ariaChecked(e) {
    if (tag(e) === 'input' && /^(checkbox|radio)$/i.test(e.type)) return e.indeterminate ? 'mixed' : e.checked;
    const a = attr(e, 'aria-checked');
    if (a === 'mixed') return 'mixed';
    if (a === 'true') return true;
    if (a === 'false') return false;
    return undefined;
  }

  function isDisabled(e) {
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

  function roleQuery(root, q) {
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

  function labelQuery(root, m) {
    const ok = matcher(m);
    return allUnder(root).filter((e) => labelsOf(e).some(ok));
  }

  function attrQuery(root, q) {
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

  // --- CSS ---------------------------------------------------------------
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

  function cssError(sel) {
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

  function cssQuery(root, q) {
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

  function xpathQuery(root, q) {
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

  // --- resolution -------------------------------------------------------

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
  function resolve(steps, roots) {
    let cur = roots;
    for (const s of steps) {
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
        cur = cur
          .map((e) => {
            try {
              return e.contentDocument;
            } catch (_) {
              return null;
            }
          })
          .filter(Boolean);
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

  // --- descriptions -----------------------------------------------------

  const VOID = new Set(['AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT', 'KEYGEN', 'LINK', 'MENUITEM', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
  const BOOL_ATTR = new Set(['checked', 'selected', 'disabled', 'readonly', 'multiple']);
  const trim = (s, n) => (s.length > n ? s.slice(0, n - 1) + '\u2026' : s);

  /** An element as Playwright previews it in logs and strict-mode errors. */
  function preview(e) {
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
  function aka(e) {
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

  // --- input helpers ----------------------------------------------------

  const KEYS = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    Escape: { code: 'Escape', keyCode: 27 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
    Shift: { code: 'ShiftLeft', keyCode: 16 },
    Control: { code: 'ControlLeft', keyCode: 17 },
    Alt: { code: 'AltLeft', keyCode: 18 },
    Meta: { code: 'MetaLeft', keyCode: 91 },
    Insert: { code: 'Insert', keyCode: 45 },
    F1: { code: 'F1', keyCode: 112 }, F2: { code: 'F2', keyCode: 113 }, F5: { code: 'F5', keyCode: 116 },
    ' ': { code: 'Space', keyCode: 32, text: ' ' },
  };
  const isMac = /Mac/.test(navigator.platform);

  function keyInfo(k, shift) {
    if (k === 'ControlOrMeta') k = isMac ? 'Meta' : 'Control';
    if (KEYS[k]) return { key: k, ...KEYS[k] };
    if (k.length === 1 && k.charCodeAt(0) > 126) throw new Error(`Error: Unknown key: "${k}"`);
    if ([...k].length === 1 && k.length > 1) throw new Error(`Error: Unknown key: "${k}"`);
    if (k.length === 1) {
      const ch = shift && /[a-z]/.test(k) ? k.toUpperCase() : k;
      const up = k.toUpperCase();
      const code = /[A-Z]/.test(up) ? 'Key' + up : /[0-9]/.test(k) ? 'Digit' + k : '';
      return { key: ch, code, keyCode: up.charCodeAt(0), text: ch };
    }
    if (/^Key[A-Z]$/.test(k)) return keyInfo(k.slice(3).toLowerCase(), shift);
    if (/^Digit[0-9]$/.test(k)) return keyInfo(k.slice(5), shift);
    if (/^F([1-9]|1[0-2])$/.test(k)) return { key: k, code: k, keyCode: 111 + Number(k.slice(1)) };
    if (/^(CapsLock|NumLock|ScrollLock|Pause|ContextMenu|PrintScreen|AltGraph|Hyper|Super|Fn)$/.test(k)) return { key: k, code: k, keyCode: 0 };
    throw new Error(`Error: Unknown key: "${k}"`);
  }

  function splitChord(chord) {
    const parts = chord.split('+');
    // "Shift++" and "+" name the plus key.
    if (parts.length > 1 && parts[parts.length - 1] === '') {
      parts.pop();
      parts[parts.length - 1] = '+';
    }
    return { mods: parts.slice(0, -1), key: parts[parts.length - 1] };
  }

  function editableTarget(e) {
    if (!e) return false;
    if (tag(e) === 'textarea') return !e.readOnly && !e.disabled;
    if (tag(e) === 'input') return !e.readOnly && !e.disabled && !/^(checkbox|radio|button|submit|reset|image|file|hidden|range|color)$/i.test(e.type);
    return !!e.isContentEditable;
  }

  function deepActive(doc) {
    let a = (doc || document).activeElement;
    for (;;) {
      if (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
      else if (a && /^(IFRAME|FRAME)$/.test(a.nodeName)) {
        let d = null;
        try {
          d = a.contentDocument;
        } catch (_) {}
        if (!d || !d.activeElement) break;
        a = d.activeElement;
      } else break;
    }
    return a;
  }

  function insertText(target, text) {
    const doc = target.ownerDocument;
    if (doc.execCommand('insertText', false, text)) return;
    if ('value' in target && typeof target.selectionStart === 'number') {
      const s = target.selectionStart;
      const v = target.value;
      target.value = v.slice(0, s) + text + v.slice(target.selectionEnd);
      target.setSelectionRange(s + text.length, s + text.length);
      target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
    }
  }

  function moveFocus(from, back) {
    const doc = from ? from.ownerDocument : document;
    const all = allUnder(doc).filter(
      (e) => e.tabIndex >= 0 && !isDisabled(e) && isVisible(e) && (e.tabIndex > 0 || /^(a|button|input|select|textarea|iframe|summary)$/.test(tag(e)) || e.hasAttribute('tabindex') || e.isContentEditable),
    );
    const i = all.indexOf(from);
    const next = all[back ? (i <= 0 ? all.length - 1 : i - 1) : (i + 1) % all.length];
    if (next) next.focus();
  }

  const held = new Set();

  function keyEvent(target, type, info, mods) {
    const KE = (target.ownerDocument.defaultView || window).KeyboardEvent;
    const ev = new KE(type, {
      key: info.key,
      code: info.code,
      keyCode: info.keyCode,
      which: info.keyCode,
      charCode: type === 'keypress' ? (info.text || '').charCodeAt(0) || 0 : 0,
      bubbles: true,
      cancelable: true,
      composed: true,
      shiftKey: mods.has('Shift'),
      ctrlKey: mods.has('Control'),
      altKey: mods.has('Alt'),
      metaKey: mods.has('Meta'),
      location: 0,
    });
    // keyCode/which are read-only in the init dict on some engines.
    try {
      Object.defineProperty(ev, 'keyCode', { get: () => info.keyCode });
      Object.defineProperty(ev, 'which', { get: () => (type === 'keypress' ? ev.charCode || info.keyCode : info.keyCode) });
    } catch (_) {}
    return target.dispatchEvent(ev);
  }

  /** One key press with its default action, roughly as a browser would do it. */
  function pressKey(chord, phase) {
    const { mods: modList, key } = splitChord(chord);
    const mods = new Set([...held, ...modList.map((m) => (m === 'ControlOrMeta' ? (isMac ? 'Meta' : 'Control') : m))]);
    const info = keyInfo(key, mods.has('Shift'));
    const target = deepActive() || document.body;
    const down = phase !== 'up';
    const up = phase !== 'down';
    if (down) {
      for (const m of modList) keyEvent(target, 'keydown', keyInfo(m), mods);
      const ok = keyEvent(target, 'keydown', info, mods);
      if (/^(Shift|Control|Alt|Meta)$/.test(info.key)) {
        if (phase === 'down') held.add(info.key);
      } else if (ok) defaultAction(target, info, mods);
    }
    if (up) {
      keyEvent(deepActive() || target, 'keyup', info, mods);
      if (phase === 'up') held.delete(info.key);
      for (const m of modList.slice().reverse()) keyEvent(deepActive() || target, 'keyup', keyInfo(m), mods);
    }
  }

  function defaultAction(target, info, mods) {
    const cmd = mods.has('Control') || mods.has('Meta');
    const editable = editableTarget(target);
    if (cmd) {
      if (info.key.toLowerCase() === 'a') {
        if ('select' in target && editable && typeof target.select === 'function') target.select();
        else target.ownerDocument.execCommand('selectAll');
      }
      return;
    }
    if (info.text !== undefined && info.key !== 'Enter') {
      const ok = keyEvent(target, 'keypress', info, mods);
      if (ok && editable) insertText(target, info.text);
      return;
    }
    switch (info.key) {
      case 'Enter': {
        const ok = keyEvent(target, 'keypress', info, mods);
        if (!ok) return;
        if (tag(target) === 'textarea' || (target.isContentEditable && editable)) {
          target.ownerDocument.execCommand(target.isContentEditable ? 'insertParagraph' : 'insertLineBreak') ||
            insertText(target, '\n');
        } else if (tag(target) === 'input' && target.form) {
          const f = target.form;
          const b = f.querySelector('button:not([type]),button[type=submit],input[type=submit],input[type=image]');
          if (b) b.click();
          else f.requestSubmit ? f.requestSubmit() : f.submit();
        } else if (/^(a|button)$/.test(tag(target)) || (tag(target) === 'input' && /^(button|submit|reset)$/i.test(target.type))) {
          target.click();
        }
        return;
      }
      case 'Backspace':
        if (editable) target.ownerDocument.execCommand('delete');
        return;
      case 'Delete':
        if (editable) target.ownerDocument.execCommand('forwardDelete');
        return;
      case 'Tab':
        moveFocus(target, mods.has('Shift'));
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
        if (editable && typeof target.selectionStart === 'number') {
          const len = target.value.length;
          let p = target.selectionStart;
          if (info.key === 'ArrowLeft') p = Math.max(0, (target.selectionStart === target.selectionEnd ? p - 1 : p));
          else if (info.key === 'ArrowRight') p = Math.min(len, target.selectionStart === target.selectionEnd ? target.selectionEnd + 1 : target.selectionEnd);
          else p = info.key === 'Home' ? 0 : len;
          if (mods.has('Shift')) target.setSelectionRange(Math.min(p, target.selectionStart), Math.max(p, target.selectionEnd));
          else target.setSelectionRange(p, p);
        }
        return;
      case ' ':
        return;
    }
  }

  function mouseEvent(e, type, x, y, o) {
    const w = e.ownerDocument.defaultView || window;
    const Ctor = /^(pointer)/.test(type) ? w.PointerEvent || w.MouseEvent : w.MouseEvent;
    const ev = new Ctor(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: o.button,
      buttons: o.buttons || 0,
      detail: o.detail || 1,
      view: w,
      shiftKey: o.mods.has('Shift'),
      ctrlKey: o.mods.has('Control'),
      altKey: o.mods.has('Alt'),
      metaKey: o.mods.has('Meta'),
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    });
    return e.dispatchEvent(ev);
  }

  /** A synthetic click sequence, for buttons, modifiers and click counts native input cannot express. */
  function synthClick(e, a) {
    const button = { left: 0, middle: 1, right: 2 }[a.button || 'left'];
    const mods = new Set(a.modifiers || []);
    const r = e.getBoundingClientRect();
    const x = r.left + (a.position ? a.position.x : r.width / 2);
    const y = r.top + (a.position ? a.position.y : r.height / 2);
    const count = a.clickCount || 1;
    const o = { button, mods, buttons: 1 << (button === 1 ? 2 : button === 2 ? 1 : 0) };
    mouseEvent(e, 'pointerover', x, y, o);
    mouseEvent(e, 'mouseover', x, y, o);
    mouseEvent(e, 'pointermove', x, y, o);
    mouseEvent(e, 'mousemove', x, y, o);
    for (let i = 1; i <= count; i++) {
      o.detail = i;
      mouseEvent(e, 'pointerdown', x, y, o);
      if (mouseEvent(e, 'mousedown', x, y, o) && i === 1) {
        // The default action of a press: focus the nearest focusable ancestor, or clear focus.
        const f = e.closest('a[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable]');
        const act = deepActive(e.ownerDocument);
        if (f && !isDisabled(f)) f.focus();
        else if (act && act !== e.ownerDocument.body && !contains(act, e) && typeof act.blur === 'function') act.blur();
      }
      o.buttons = 0;
      mouseEvent(e, 'pointerup', x, y, o);
      mouseEvent(e, 'mouseup', x, y, o);
      if (button === 0) {
        if (i === 1 && typeof e.click === 'function' && !a.modifiers?.length) e.click();
        else mouseEvent(e, 'click', x, y, o);
      } else if (button === 2) mouseEvent(e, 'contextmenu', x, y, o);
      else mouseEvent(e, 'auxclick', x, y, o);
      if (i === 2 && button === 0) mouseEvent(e, 'dblclick', x, y, o);
    }
  }

  const EVENT_CLASS = {
    click: 'MouseEvent', dblclick: 'MouseEvent', mousedown: 'MouseEvent', mouseup: 'MouseEvent',
    mouseover: 'MouseEvent', mouseout: 'MouseEvent', mouseenter: 'MouseEvent', mouseleave: 'MouseEvent',
    mousemove: 'MouseEvent', contextmenu: 'MouseEvent', auxclick: 'MouseEvent',
    keydown: 'KeyboardEvent', keyup: 'KeyboardEvent', keypress: 'KeyboardEvent',
    pointerdown: 'PointerEvent', pointerup: 'PointerEvent', pointermove: 'PointerEvent',
    pointerover: 'PointerEvent', pointerout: 'PointerEvent', pointerenter: 'PointerEvent', pointerleave: 'PointerEvent',
    focus: 'FocusEvent', blur: 'FocusEvent', focusin: 'FocusEvent', focusout: 'FocusEvent',
    input: 'InputEvent', beforeinput: 'InputEvent',
    drag: 'DragEvent', dragstart: 'DragEvent', dragend: 'DragEvent', dragenter: 'DragEvent',
    dragleave: 'DragEvent', dragover: 'DragEvent', drop: 'DragEvent',
    touchstart: 'TouchEvent', touchend: 'TouchEvent', touchmove: 'TouchEvent', wheel: 'WheelEvent',
  };

  function dispatch(e, type, init) {
    const w = e.ownerDocument.defaultView || window;
    const cls = w[EVENT_CLASS[type]] || w.Event;
    const ev = new cls(type, { bubbles: true, cancelable: true, composed: true, ...(init || {}) });
    e.dispatchEvent(ev);
  }

  function fill(e, value) {
    const t = tag(e);
    if (t === 'input') {
      const type = (e.type || 'text').toLowerCase();
      if (/^(checkbox|radio|file|button|submit|reset|image|hidden|range)$/.test(type)) {
        throw new Error(`Error: Input of type "${type}" cannot be filled`);
      }
      if (/^(date|time|datetime-local|month|week|color|number)$/.test(type)) {
        e.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(e, value);
        if (type === 'number' && value !== '' && e.value === '') throw new Error('Error: Cannot type text into input[type=number]');
        e.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    } else if (t !== 'textarea' && !e.isContentEditable) {
      throw new Error('Error: Element is not an <input>, <textarea> or [contenteditable] element');
    }
    e.focus();
    if (t === 'input' || t === 'textarea') {
      e.select();
    } else {
      const sel = e.ownerDocument.getSelection();
      const r = e.ownerDocument.createRange();
      r.selectNodeContents(e);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    const doc = e.ownerDocument;
    if (value === '') {
      if (!doc.execCommand('delete') && 'value' in e) {
        e.value = '';
        e.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContent' }));
      }
    } else if (!doc.execCommand('insertText', false, value)) {
      if ('value' in e) {
        const proto = t === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
      } else e.textContent = value;
      e.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: value, inputType: 'insertText' }));
    }
    if (t === 'input' || t === 'textarea') e.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function selectOption(e, wanted) {
    if (tag(e) !== 'select') throw new Error('Error: Element is not a <select> element');
    if (isDisabled(e)) throw new Error('Error: Element is not enabled');
    const opts = [...e.options];
    const chosen = [];
    for (const w of wanted) {
      const o = opts.find((op) =>
        w.index !== undefined
          ? op.index === w.index
          : w.value !== undefined && w.label !== undefined
            ? op.value === w.value && op.label === w.label
            : w.value !== undefined
              ? op.value === w.value
              : w.label !== undefined
                ? op.label === w.label
                : op.value === w.valueOrLabel || op.label === w.valueOrLabel,
      );
      if (!o) return { missing: true };
      if (o.disabled) throw new Error('Error: Option being selected is not enabled');
      chosen.push(o);
      if (!e.multiple) break;
    }
    if (wanted.length && !chosen.length) return { missing: true };
    for (const o of opts) o.selected = chosen.includes(o);
    if (!wanted.length) e.selectedIndex = -1;
    e.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return { values: chosen.map((o) => o.value) };
  }

  // --- element ops ------------------------------------------------------

  function inputValue(e) {
    if (/^(input|textarea|select)$/.test(tag(e))) return e.value;
    throw new Error('Error: Node is not an <input>, <textarea> or <select> element');
  }

  function checkedState(e) {
    if (tag(e) === 'input' && /^(checkbox|radio)$/i.test(e.type)) return e.checked;
    const c = ariaChecked(e);
    if (c === undefined) {
      const role = roleOf(e);
      if (!/^(checkbox|radio|switch|menuitemcheckbox|menuitemradio|option|treeitem)$/.test(role || '')) {
        throw new Error('Error: Not a checkbox or radio button');
      }
      return false;
    }
    return c === true;
  }

  function isEditable(e) {
    if (isDisabled(e)) return false;
    if (/^(input|textarea|select)$/.test(tag(e))) {
      if (tag(e) === 'input' && /^(checkbox|radio|button|submit|reset|image|file|hidden|range|color)$/i.test(e.type)) {
        return !e.readOnly;
      }
      return !e.readOnly && attr(e, 'aria-readonly') !== 'true';
    }
    if (e.isContentEditable) return attr(e, 'aria-readonly') !== 'true';
    const role = roleOf(e);
    if (/^(checkbox|combobox|grid|gridcell|listbox|radiogroup|slider|spinbutton|textbox)$/.test(role || '')) {
      return attr(e, 'aria-readonly') !== 'true';
    }
    throw new Error('Error: Element is not an <input>, <textarea>, <select> or [contenteditable] and does not have a role allowing [aria-readonly]');
  }

  /** Scroll the element into view and find the point a click should land on. */
  function clickPoint(e, a) {
    if (!e.isConnected) return { retry: 'element is not attached to the DOM' };
    if (!a.force) {
      if (!isVisible(e)) return { retry: 'element is not visible' };
      if (a.enabled !== false && isDisabled(e)) return { retry: 'element is not enabled' };
    }
    if (typeof e.scrollIntoViewIfNeeded === 'function') e.scrollIntoViewIfNeeded(true);
    else e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = e.getBoundingClientRect();
    const rects = e.getClientRects();
    const first = rects.length ? rects[0] : r;
    const lx = a.position ? a.position.x : first.width / 2;
    const ly = a.position ? a.position.y : first.height / 2;
    const cx = first.left + lx;
    const cy = first.top + ly;
    if (!a.force) {
      const hit = e.ownerDocument.elementFromPoint(cx, cy);
      let deep = hit;
      while (deep && deep.shadowRoot) {
        const inner = deep.shadowRoot.elementFromPoint(cx, cy);
        if (!inner || inner === deep) break;
        deep = inner;
      }
      const ok = (h) => h && (contains(e, h) || (tag(e) === 'label' && e.control === h) || (h.nodeName === 'LABEL' && h.control === e));
      if (!ok(deep) && !ok(hit)) {
        return { retry: `${deep ? preview(deep) : 'nothing'} intercepts pointer events` };
      }
    }
    const t = topRect(e);
    // Remembered so settleFocus can tell whether the click moved focus.
    focusMoved = false;
    const d = e.ownerDocument;
    if (!d.__tsFocusWatch) {
      const mark = () => {
        focusMoved = true;
      };
      d.addEventListener('focusin', mark, true);
      d.addEventListener('focusout', mark, true);
      Object.defineProperty(d, '__tsFocusWatch', { value: true });
    }
    return { x: t.x + (first.left - r.left) + lx, y: t.y + (first.top - r.top) + ly };
  }

  let focusMoved = true;

  /**
   * After a native click: a press on content moves focus to its nearest
   * focusable ancestor, or clears it. The headless view does not always
   * do that itself, and apps that save on blur depend on it.
   */
  function settleFocus(e) {
    const act = deepActive(e.ownerDocument);
    if (focusMoved || !act || act === e.ownerDocument.body) return true;
    focusMoved = true;
    if (contains(e, act) || contains(act, e)) return true;
    const f = e.closest('a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable=""],[contenteditable="true"]');
    if (f && !isDisabled(f)) f.focus();
    else if (typeof act.blur === 'function') act.blur();
    return true;
  }

  const OPS = {
    count: (els) => els.length,
    texts: (els) => els.map((e) => e.textContent || ''),
    elTexts: (els) => els.map((e) => elementText(e)),
    innerTexts: (els) => els.map((e) => e.innerText || ''),
    visibleAny: (els) => els.some(isVisible),
    evalAll: (els, a) => a.fnc(els, SER.des(a.arg)),
    describe: (els) => els.map(preview),
    adoptAll: (els) => els.map((e) => adopt(e)),
    refs: (els) => els.map((e) => {
      const own = attr(e, 'data-vs-ref');
      if (own) return [Number(own)];
      return [...e.querySelectorAll('[data-vs-ref]')].map((x) => Number(x.getAttribute('data-vs-ref')));
    }),
  };

  const ONE = {
    text: (e) => e.textContent || '',
    adopt: (e) => adopt(e),
    elText: (e) => elementText(e),
    innerText: (e) => {
      if (!(e instanceof (e.ownerDocument.defaultView || window).HTMLElement)) throw new Error('Error: Node is not an HTMLElement');
      return e.innerText;
    },
    innerHTML: (e) => e.innerHTML,
    attr: (e, a) => attr(e, a.name),
    value: (e) => inputValue(retarget(e)),
    values: (e) => {
      e = retarget(e);
      if (tag(e) !== 'select' || !e.multiple) throw new Error('Error: Not a select element with a multiple attribute');
      return [...e.selectedOptions].map((o) => o.value);
    },
    checked: (e) => checkedState(retarget(e)),
    disabled: (e) => isDisabled(e),
    editable: (e) => isEditable(e),
    focused: (e) => {
      const root = e.getRootNode();
      return (root.activeElement || null) === e;
    },
    visible: (e) => isVisible(e),
    box: (e) => {
      if (!isVisible(e) && e.getBoundingClientRect().width === 0) return null;
      const t = topRect(e);
      return t.width === 0 && t.height === 0 ? null : t;
    },
    eval: (e, a) => a.fnc(e, SER.des(a.arg)),
    clickPoint: (e, a) => clickPoint(e, a),
    settleFocus: (e) => settleFocus(e),
    synthClick: (e, a) => {
      if (typeof e.scrollIntoViewIfNeeded === 'function') e.scrollIntoViewIfNeeded(true);
      synthClick(e, a);
      return true;
    },
    focus: (e) => {
      e.focus();
      return true;
    },
    blur: (e) => {
      e.blur();
      return true;
    },
    fill: (e, a) => {
      if (!a.force) {
        if (!isVisible(e)) return { retry: 'element is not visible' };
        if (isDisabled(e)) return { retry: 'element is not enabled' };
        if (e.readOnly || attr(e, 'aria-readonly') === 'true') return { retry: 'element is not editable' };
      }
      fill(retarget(e), a.value);
      return true;
    },
    refs: (e) => {
      // vibesurfer 0.2.16+ keeps refs in maps (__vsRefOf); older ones in an attribute.
      const refOf = (x) => {
        if (typeof window.__vsRefOf === 'function') return window.__vsRefOf(x);
        const a = attr(x, 'data-vs-ref');
        return a === null ? null : Number(a);
      };
      const own = refOf(e);
      if (own !== null) return [own];
      // The outermost reported elements inside.
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          const r = refOf(c);
          if (r !== null) out.push(r);
          else walk(c);
        }
        if (n.shadowRoot) walk(n.shadowRoot);
      };
      walk(e);
      return out;
    },
    press: (e, a) => {
      if (deepActive(e.ownerDocument) !== e) e.focus();
      pressKey(a.key);
      return true;
    },
    selectOption: (e, a) => selectOption(retarget(e), a.values),
    selectText: (e) => {
      e.focus();
      if (typeof e.select === 'function') e.select();
      else {
        const r = e.ownerDocument.createRange();
        r.selectNodeContents(e);
        const s = e.ownerDocument.getSelection();
        s.removeAllRanges();
        s.addRange(r);
      }
      return true;
    },
    dispatch: (e, a) => {
      dispatch(e, a.type, a.init);
      return true;
    },
    scroll: (e) => {
      e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return true;
    },
    setFiles: (e, a) => {
      e = retarget(e);
      if (tag(e) !== 'input' || e.type !== 'file') throw new Error('Error: Node is not an HTMLInputElement');
      const dt = new DataTransfer();
      for (const f of a.files) {
        const bin = atob(f.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.mimeType, lastModified: f.lastModified || Date.now() }));
      }
      e.files = dt.files;
      e.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    checkedMixed: (e) => {
      e = retarget(e);
      if (tag(e) === 'input' && /^(checkbox|radio)$/i.test(e.type)) return { c: e.checked, m: e.indeterminate };
      const c = ariaChecked(e);
      if (c === undefined) checkedState(e);
      return { c: c === true, m: c === 'mixed' };
    },
    css: (e, a) => styleOf(e).getPropertyValue(a.name) || styleOf(e)[a.name] || '',
    prop: (e, a) => a.name.split('.').reduce((o, k) => (o == null ? undefined : o[k]), e),
    role: (e) => roleOf(e) || '',
    name: (e) => accName(e),
    description: (e) => {
      const ids = attr(e, 'aria-describedby');
      if (ids) return N(ids.split(/\s+/).map((id) => { const t = e.ownerDocument.getElementById(id); return t ? t.textContent : ''; }).join(' '));
      return N(attr(e, 'aria-description') || attr(e, 'title') || '');
    },
    inViewport: (e, a) => {
      const w = e.ownerDocument.defaultView;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return 0;
      const vx = Math.max(0, Math.min(r.right, w.innerWidth) - Math.max(r.left, 0));
      const vy = Math.max(0, Math.min(r.bottom, w.innerHeight) - Math.max(r.top, 0));
      return (vx * vy) / (r.width * r.height);
    },
    empty: (e) => {
      if (/^(input|textarea)$/.test(tag(e))) return !e.value;
      return !N(e.textContent);
    },
    classList: (e) => [...e.classList],
    outerHTML: (e) => e.outerHTML,
  };

  const SLOTS = new Map();
  let seq = 0;

  // Handles: page values the test holds by id (JSHandle, ElementHandle).
  const HANDLES = new Map();
  let handleSeq = 0;
  const adopt = (v) => {
    const id = ++handleSeq;
    HANDLES.set(id, v);
    return id;
  };
  SER.H.get = (id) => HANDLES.get(id);
  // Elements, documents and shadow roots come back as element handles.
  const frameIds = new WeakMap();
  const isEl = (v) => !!v && typeof v === 'object' && (v.nodeType === 1 || v.nodeType === 9 || v.nodeType === 11);

  const api = {
    /** Identifies this document: a new document installs a new engine. */
    doc: Math.random().toString(36).slice(2),
    /**
     * req: { steps, op, args, many } -> { n, v } for `many` ops,
     * { v } for one-element ops, { none } when nothing matches,
     * { strict: [previews], n } when more than one matches.
     */
    run(req, fn) {
      textCache = new Map();
      if (fn) req.args = { ...(req.args || {}), fnc: fn };
      const els = resolve(req.steps, [document]);
      const wrap = (v, n) => (v && typeof v.then === 'function' ? v.then((r) => ({ v: r, n })) : { v, n });
      if (req.many) return wrap(OPS[req.op](els, req.args || {}), els.length);
      if (els.length === 0) return { none: true };
      if (els.length > 1 && !req.first) return { strict: els.slice(0, 10).map((e) => `${preview(e)} aka ${aka(e)}`), n: els.length };
      const r = wrap(ONE[req.op](els[0], req.args || {}), 1);
      const p = preview(els[0]);
      return r && typeof r.then === 'function' ? r.then((x) => ({ ...x, p })) : { ...r, p };
    },
    key(chord, phase) {
      pressKey(chord, phase);
      return true;
    },
    insertText(text) {
      const t = deepActive() || document.body;
      if (editableTarget(t)) insertText(t, text);
      return true;
    },
    /** Call f; park a promise result in a slot for take(). */
    exec(f) {
      let v;
      try {
        v = f();
      } catch (e) {
        return { e: { name: e && e.name, message: e && e.message !== undefined ? e.message : String(e), stack: e && e.stack } };
      }
      if (v && typeof v.then === 'function') {
        const id = ++seq;
        SLOTS.set(id, null);
        v.then(
          (r) => SLOTS.set(id, { v: SER.ser(r) }),
          (e) => SLOTS.set(id, { e: { name: e && e.name, message: e && e.message !== undefined ? e.message : String(e), stack: e && e.stack } }),
        );
        return { p: id };
      }
      return { v: SER.ser(v), u: location.href, fc: document.querySelectorAll('iframe,frame').length };
    },
    h: (id) => HANDLES.get(id),
    drop(id) {
      HANDLES.delete(id);
      return true;
    },
    /** Adopt a value (or a promise of one): { id, el } with el true for an element. */
    adoptValue(v) {
      const prev = (x) => {
        if (x && typeof x === 'object' && x.nodeType === 3) return '#text=' + String(x.nodeValue).replace(/\n/g, '↵');
        if (isEl(x)) return preview(x);
        if (x === null || x === undefined || typeof x !== 'object') return String(x);
        if (Array.isArray(x)) return 'Array(' + x.length + ')';
        return x.constructor && x.constructor.name ? x.constructor.name : 'Object';
      };
      const done = (x) => ({ id: adopt(x), el: isEl(x), p: prev(x) });
      return v && typeof v.then === 'function' ? v.then(done) : done(v);
    },
    /** Same-origin and cross-origin iframes, depth first: [id, parentId, name, url]. */
    frames() {
      const out = [];
      const walk = (doc, parent) => {
        for (const f of allUnder(doc)) {
          if (f.nodeName !== 'IFRAME' && f.nodeName !== 'FRAME') continue;
          // The same iframe keeps its id, so Frame objects stay the same across listings.
          let id = frameIds.get(f);
          if (id === undefined) {
            id = adopt(f);
            frameIds.set(f, id);
          }
          let d = null;
          let url = '';
          try {
            d = f.contentDocument;
            url = d ? d.location.href : f.src;
          } catch (_) {
            url = f.src;
          }
          out.push([id, parent, attr(f, 'name') || '', url]);
          if (d) walk(d, id);
        }
      };
      walk(document, null);
      return out;
    },
    props(id) {
      const v = HANDLES.get(id);
      const out = [];
      if (v && typeof v === 'object') for (const k of Object.keys(v)) out.push([k, adopt(v[k]), isEl(v[k])]);
      return out;
    },
    take(id) {
      if (!SLOTS.has(id)) return { gone: true };
      const s = SLOTS.get(id);
      if (!s) return { p: id };
      SLOTS.delete(id);
      return s;
    },
    ser: SER.ser,
    des: SER.des,
  };
  Object.defineProperty(window, '__tse', { value: api, configurable: true, enumerable: false });
  return api;
}
