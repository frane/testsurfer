// @ts-nocheck
/**
 * The operations locators run on resolved elements, and the window.__tse API.
 *
 * Part of the page-side locator engine (see src/injected/index.ts):
 * plain browser JavaScript, bundled into one script by
 * scripts/build-injected.mjs.
 */

import { Map, WeakMap } from './realm.ts';
import { N, allUnder, contains, retarget, styleOf, tag } from './basics.ts';
import { elementText, resetTextCache } from './text.ts';
import { isVisible, topRect } from './visibility.ts';
import { accName, ariaChecked, attr, isDisabled, roleOf } from './roles.ts';
import { aka, preview } from './descriptions.ts';
import { HANDLES, adopt, isEl } from './handles.ts';
import { resolve } from './resolution.ts';
import { deepActive, dispatch, editableTarget, fill, insertText, pressKey, selectOption, synthClick } from './input.ts';

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
  // Remembered so a click whose press and release landed on
  // different elements (the page re-rendered in between, and no click
  // event fired) can be sent again.
  clickSeen.up = false;
  clickSeen.click = false;
  if (!d.__tsClickWatch && d.defaultView) {
    d.defaultView.addEventListener('mouseup', (ev) => {
      if (ev.isTrusted) clickSeen.up = true;
    }, true);
    d.defaultView.addEventListener('click', (ev) => {
      if (ev.isTrusted) clickSeen.click = true;
    }, true);
    Object.defineProperty(d, '__tsClickWatch', { value: true });
  }
  return { x: t.x + (first.left - r.left) + lx, y: t.y + (first.top - r.top) + ly };
}

/**
 * Page state every reply carries: the URL, the iframe count (frames()
 * refreshes when it changes), and whether a service worker controls
 * the page, which marks its responses fromServiceWorker in proxy mode.
 */
function here() {
  let sw = false;
  try {
    sw = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  } catch (_) {
    /* a sandboxed document may not ask */
  }
  return { u: location.href, fc: document.querySelectorAll('iframe,frame').length, sw };
}

let focusMoved = true;
/** Trusted mouseup and click events since the last clickPoint. */
const clickSeen = { up: true, click: true };

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
  clickSeen: () => ({ up: clickSeen.up, click: clickSeen.click }),
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
// Elements, documents and shadow roots come back as element handles.
const frameIds = new WeakMap();

export const api = {
  /** Identifies this document: a new document installs a new engine. */
  doc: Math.random().toString(36).slice(2),
  /**
   * req: { steps, op, args, many } -> { n, v } for `many` ops,
   * { v } for one-element ops, { none } when nothing matches,
   * { strict: [previews], n } when more than one matches.
   */
  run(req, fn) {
    resetTextCache();
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
    return { v: SER.ser(v), ...here() };
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
        // Fifth: 1 for a cross-origin frame, which only `--frame` evals reach.
        out.push([id, parent, attr(f, 'name') || '', url, !d && f.contentWindow ? 1 : 0]);
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
    return { ...s, ...here() };
  },
  ser: SER.ser,
  des: SER.des,
};
Object.defineProperty(window, '__tse', { value: api, configurable: true, enumerable: false });
