// @ts-nocheck
/**
 * Visibility, as Playwright's isVisible decides it.
 *
 * Part of the page-side locator engine (see src/injected/index.ts):
 * plain browser JavaScript, bundled into one script by
 * scripts/build-injected.mjs.
 */

import { parentOf, styleOf, tag } from './basics.ts';

export function isVisible(e) {
  if (!e.isConnected) return false;
  const st = styleOf(e);
  if (st.display === 'contents') {
    // A slot shows what is assigned to it, else its fallback children.
    const assigned = e.nodeName === 'SLOT' ? e.assignedNodes({ flatten: true }) : [];
    const kids = assigned.length ? assigned : [...e.childNodes];
    for (const c of kids) {
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

export function hiddenForAria(e) {
  if (tag(e) !== 'option' && styleOf(e).visibility === 'hidden') return true;
  // Not rendered: display:none somewhere above, unslotted shadow-host
  // children, closed <details> content. <option> renders inside its
  // select's popup, so only its own display counts.
  if (tag(e) === 'option') {
    if (styleOf(e).display === 'none') return true;
  } else if (styleOf(e).display === 'contents') {
    // No box of its own (a <slot>, a display:contents wrapper), so
    // checkVisibility() says false; its content decides, below.
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
export function topRect(e) {
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
