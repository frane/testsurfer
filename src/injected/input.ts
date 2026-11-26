// @ts-nocheck
/**
 * Keyboard and form input with the browser default actions.
 *
 * Part of the page-side locator engine (see src/injected/index.ts):
 * plain browser JavaScript, bundled into one script by
 * scripts/build-injected.mjs.
 */

import { Set } from './realm.ts';
import { allUnder, contains, tag } from './basics.ts';
import { isVisible } from './visibility.ts';
import { isDisabled } from './roles.ts';

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
  // Physical key codes Playwright also accepts as key names.
  const CODES = { Space: ' ', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '\x60', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Meta', MetaRight: 'Meta', NumpadEnter: 'Enter' };
  if (CODES[k]) return keyInfo(CODES[k], shift);
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

export function editableTarget(e) {
  if (!e) return false;
  if (tag(e) === 'textarea') return !e.readOnly && !e.disabled;
  if (tag(e) === 'input') return !e.readOnly && !e.disabled && !/^(checkbox|radio|button|submit|reset|image|file|hidden|range|color)$/i.test(e.type);
  return !!e.isContentEditable;
}

export function deepActive(doc) {
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

export function insertText(target, text) {
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
export function pressKey(chord, phase) {
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

/** Arrow, Page and Home/End keys on a range or number input step its value, as the browser does. */
function stepValue(target, key) {
  if (tag(target) !== 'input' || !/^(range|number)$/.test(target.type) || target.disabled || target.readOnly) return false;
  const deltas = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 };
  if (!(key in deltas) && key !== 'Home' && key !== 'End') return false;
  // Left and Right edit the text of a number field; only Up and Down step it.
  if (target.type === 'number' && !/^Arrow(Up|Down)$/.test(key)) return false;
  const before = target.value;
  if (key === 'Home' || key === 'End') {
    if (target.type !== 'range') return false;
    target.value = key === 'Home' ? target.min || '0' : target.max || '100';
  } else {
    const n = deltas[key];
    try {
      if (n > 0) target.stepUp(Math.abs(n));
      else target.stepDown(Math.abs(n));
    } catch (_) {
      return false;
    }
  }
  if (target.value !== before) {
    target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}

function defaultAction(target, info, mods) {
  const cmd = mods.has('Control') || mods.has('Meta');
  const editable = editableTarget(target);
  if (!cmd && stepValue(target, info.key)) return;
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
export function synthClick(e, a) {
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

export function dispatch(e, type, init) {
  const w = e.ownerDocument.defaultView || window;
  const cls = w[EVENT_CLASS[type]] || w.Event;
  const ev = new cls(type, { bubbles: true, cancelable: true, composed: true, ...(init || {}) });
  e.dispatchEvent(ev);
}

export function fill(e, value) {
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

export function selectOption(e, wanted) {
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
