// @ts-nocheck
/**
 * The page's own built-ins when they are native, else a clean realm's: page script may have replaced Map, Set and friends.
 *
 * Part of the page-side locator engine (see src/injected/index.ts):
 * plain browser JavaScript, bundled into one script by
 * scripts/build-injected.mjs.
 */

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
export const Map = pristine('Map');
export const Set = pristine('Set');
export const WeakMap = pristine('WeakMap');
const WeakRef = pristine('WeakRef');
