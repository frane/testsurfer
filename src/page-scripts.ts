/**
 * Small in-page helpers behind Page's DOM conveniences: script and
 * style tags, content(), web storage, the GC nudge, and the
 * Chromium-only coverage API that throws as on Playwright's WebKit.
 */

/** Adds a <script> from `o.url` or `o.content`; resolves with the element once it ran or loaded. */
export const ADD_SCRIPT_TAG_JS = `(o) => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      if (o.type) s.type = o.type;
      if (o.url !== undefined) {
        s.src = o.url;
        s.onload = () => resolve(s);
        s.onerror = () => reject(new Error('Failed to load script at ' + o.url));
        document.head.appendChild(s);
        return;
      }
      let err = null;
      const onErr = (e) => { err = e.error || new Error(e.message); };
      window.addEventListener('error', onErr);
      s.text = o.content;
      document.head.appendChild(s);
      window.removeEventListener('error', onErr);
      if (err) reject(err); else resolve(s);
    })`;

/** Adds a <link rel=stylesheet> for `o.url` or a <style> with `o.content`; resolves with the element. */
export const ADD_STYLE_TAG_JS = `(o) => new Promise((resolve, reject) => {
      let el;
      if (o.url !== undefined) {
        el = document.createElement('link');
        el.rel = 'stylesheet';
        el.href = o.url;
      } else {
        el = document.createElement('style');
        el.textContent = o.content;
      }
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Error while loading style'));
      document.head.appendChild(el);
      if (o.url === undefined) resolve(el);
    })`;

/** The document's HTML without the data-vs-ref markers vibesurfer adds. */
export const CONTENT_JS =
  `(function(){var c=document.documentElement.cloneNode(true);c.removeAttribute('data-vs-ref');` +
  `c.querySelectorAll('[data-vs-ref]').forEach(function(e){e.removeAttribute('data-vs-ref');});` +
  `return '<!DOCTYPE html>'+c.outerHTML;})()`;

/** Allocation pressure that makes JavaScriptCore (and V8) collect, then a task turn. */
export const GC_PRESSURE_JS =
  '() => new Promise((r) => { let a = []; for (let i = 0; i < 40; i++) a.push(new Array(500000).fill(i)); a = null; setTimeout(r, 0); })';

type Evaluate = <T>(fn: string, arg?: unknown) => Promise<T>;

/** page.localStorage / page.sessionStorage for the current origin. */
export function webStorage(kind: 'localStorage' | 'sessionStorage', evaluate: Evaluate) {
  const run = <T>(body: string, arg?: unknown) => evaluate<T>(`(a) => { const s = window.${kind}; ${body} }`, arg);
  return {
    clear: () => run<void>('s.clear();'),
    getItem: (name: string) => run<string | null>('return s.getItem(a);', name),
    setItem: (name: string, value: string) => run<void>('s.setItem(a[0], a[1]);', [name, value]),
    removeItem: (name: string) => run<void>('s.removeItem(a);', name),
    items: () => run<{ name: string; value: string }[]>('const out = []; for (let i = 0; i < s.length; i++) { const k = s.key(i); out.push({ name: k, value: s.getItem(k) }); } return out;'),
  };
}

const chromiumOnly = (name: string) => async (): Promise<never> => {
  throw new Error(`coverage.${name}: Coverage is only supported in Chromium`);
};

/** JS and CSS coverage: Chromium only, as in Playwright on WebKit. */
export const coverageApi = () => ({
  startJSCoverage: chromiumOnly('startJSCoverage'),
  stopJSCoverage: chromiumOnly('stopJSCoverage'),
  startCSSCoverage: chromiumOnly('startCSSCoverage'),
  stopCSSCoverage: chromiumOnly('stopCSSCoverage'),
});
