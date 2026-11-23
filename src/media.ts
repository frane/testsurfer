/**
 * page.emulateMedia without a browser protocol: matchMedia answers
 * for the emulated features, and the page's @media rules (same-origin
 * and inline sheets, including ones added later) are rewritten so CSS
 * follows too. Covers prefers-reduced-motion, prefers-color-scheme,
 * forced-colors and the print/screen media type.
 */

export interface MediaOptions {
  media?: 'screen' | 'print' | null;
  colorScheme?: 'light' | 'dark' | 'no-preference' | null;
  reducedMotion?: 'reduce' | 'no-preference' | null;
  forcedColors?: 'active' | 'none' | null;
}

/** A script that applies `cfg` to the document it runs in (idempotent; the last call wins). */
export function mediaScript(cfg: MediaOptions): string {
  return `(${MEDIA_JS})(${JSON.stringify(cfg)});`;
}

const MEDIA_JS = String.raw`function (cfg) {
  var w = window;
  w.__tsMediaCfg = cfg;
  if (w.__tsMediaApply) { w.__tsMediaApply(); return; }
  // Stand-ins that are always true and always false.
  var YES = '(min-width: 0px)';
  var NO = '(max-width: -1px)';
  var FEATURES = {
    'prefers-reduced-motion': 'reducedMotion',
    'prefers-color-scheme': 'colorScheme',
    'forced-colors': 'forcedColors'
  };
  function rewrite(text) {
    var c = w.__tsMediaCfg;
    var out = text.replace(/\(\s*([a-z-]+)\s*(?::\s*([a-z-]+)\s*)?\)/gi, function (m, name, value) {
      var key = FEATURES[name.toLowerCase()];
      var want = key && c[key];
      if (!want) return m;
      // A bare (feature) is true for anything but its "off" value.
      var on = value ? value.toLowerCase() === want : want !== 'no-preference' && want !== 'none';
      return on ? YES : NO;
    });
    if (c.media) {
      var other = c.media === 'print' ? 'screen' : 'print';
      out = out.replace(new RegExp('(^|,\\s*)(only\\s+)?' + c.media + '\\b', 'gi'), '$1' + YES);
      out = out.replace(new RegExp('(^|,\\s*)(only\\s+)?' + other + '\\b', 'gi'), '$1' + NO);
    }
    return out;
  }
  var originals = new WeakMap();
  function fix(list) {
    var orig = originals.get(list);
    if (orig === undefined) { orig = list.mediaText; originals.set(list, orig); }
    var next = rewrite(orig);
    if (list.mediaText !== next) list.mediaText = next;
  }
  function walk(rules) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r instanceof CSSMediaRule) fix(r.media);
      if (r instanceof CSSImportRule && r.styleSheet) sheet(r.styleSheet);
      if (r.cssRules) walk(r.cssRules);
    }
  }
  function sheet(s) {
    try { walk(s.cssRules); } catch (e) { /* cross-origin sheet: not readable */ }
  }
  function apply() {
    for (var i = 0; i < document.styleSheets.length; i++) sheet(document.styleSheets[i]);
  }
  w.__tsMediaApply = apply;
  var mm = window.matchMedia.bind(window);
  window.matchMedia = function (q) {
    var l = mm(rewrite(String(q)));
    try { Object.defineProperty(l, 'media', { value: String(q) }); } catch (e) { /* keep the rewritten text */ }
    return l;
  };
  apply();
  document.addEventListener('DOMContentLoaded', apply);
  // A stylesheet that finishes loading, or a <style> added or edited later.
  document.addEventListener('load', apply, true);
  function styling(n) {
    return !!n && (n.nodeName === 'STYLE' || n.nodeName === 'LINK' || (!!n.parentNode && n.parentNode.nodeName === 'STYLE'));
  }
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (styling(r.target) || Array.prototype.some.call(r.addedNodes, styling)) { apply(); return; }
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
}`;
