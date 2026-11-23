/**
 * Page-side shim behind page.route() and page.on(). Installed with
 * vs_init_script, so it runs at document start in every later
 * document, and evaluated once in the current one.
 *
 * It records console messages, uncaught errors, and fetch/XHR
 * requests and responses into `window.__ts`. While routing is on,
 * every fetch and XHR waits for a decision from Node: the poller in
 * src/events.ts takes the queue, runs the matching handler, and
 * settles the request. Navigations, images, scripts and stylesheets
 * are not fetch/XHR and are not seen.
 *
 * Top frame only: the poller evaluates in the top document.
 */
export const PAGE_SHIM = String.raw`(function () {
  if (window.top !== window || window.__ts) return;
  // routing: null until Node says otherwise; until then the default
  // an earlier init script set for new documents applies.
  var ts = { routing: null, q: [], ev: [], wait: {}, seq: 0 };
  function routing() { return ts.routing === null ? !!window.__tsRoutingDefault : ts.routing; }
  try {
    Object.defineProperty(window, '__ts', { value: ts, enumerable: false, configurable: true });
  } catch (e) { window.__ts = ts; }

  function emit(e) { if (ts.ev.length < 2000) ts.ev.push(e); }
  function fmt(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || String(a);
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }
  // An argument as msg.args()[i].jsonValue() gives it: JSON data, or {u: 1} for undefined.
  function val(a) {
    if (a === undefined) return { u: 1 };
    if (a === null || typeof a !== 'object') return typeof a === 'function' || typeof a === 'symbol' ? { u: 1 } : { v: a };
    try { return { v: JSON.parse(JSON.stringify(a)) }; } catch (e) { return { v: String(a) }; }
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (k) {
    var orig = console[k];
    console[k] = function () {
      try { emit({ t: 'console', type: k === 'warn' ? 'warning' : k, text: [].map.call(arguments, fmt).join(' '), args: [].map.call(arguments, val) }); } catch (e) {}
      return orig.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window) return;
    emit({ t: 'pageerror', message: e.message || String(e.error), stack: (e.error && e.error.stack) || '' });
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    emit({ t: 'pageerror', message: String((r && r.message) || r), stack: (r && r.stack) || '' });
  });

  function hdrs(h) {
    var out = {};
    try { h.forEach(function (v, k) { out[k] = v; }); } catch (e) {}
    return out;
  }
  function b64(buf) {
    var bytes = new Uint8Array(buf), s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function decide(info) {
    return new Promise(function (resolve) { ts.wait[info.id] = resolve; ts.q.push(info); });
  }
  ts.take = function () {
    var out = { q: ts.q, ev: ts.ev };
    ts.q = []; ts.ev = [];
    return out;
  };
  ts.settle = function (id, d) {
    var w = ts.wait[id];
    if (w) { delete ts.wait[id]; w(d); }
    return 'ok';
  };
  ts.setRouting = function (on) { ts.routing = !!on; return 'ok'; };

  var ofetch = window.fetch;
  function realFetch(info, d) {
    var method = (d && d.method) || info.method;
    var init = { method: method, headers: (d && d.headers) || info.headers, credentials: 'include' };
    var body = d && d.body !== undefined && d.body !== null ? d.body : info.body;
    if (method !== 'GET' && method !== 'HEAD' && body !== null && body !== undefined) init.body = body;
    return ofetch.call(window, (d && d.url) || info.url, init);
  }
  // route.fetch(): run the real request, hand the response to Node,
  // and wait for the handler's final decision.
  function fetchForNode(info, d) {
    return realFetch(info, d).then(function (res) {
      return res.arrayBuffer().then(function (buf) {
        return { status: res.status, statusText: res.statusText, headers: hdrs(res.headers), body: b64(buf), url: res.url };
      });
    }, function (err) {
      return { error: String((err && err.message) || err) };
    }).then(function (r) {
      return decide({ id: info.id, kind: 'fetched', response: r });
    });
  }
  function responseFrom(d) {
    var body = d.body === undefined || d.body === null ? null : unb64(d.body);
    var status = d.status || 200;
    if (status === 204 || status === 205 || status === 304) body = null;
    return new Response(body, { status: status, statusText: d.statusText || '', headers: d.headers || {} });
  }
  function settleFetch(info, d) {
    if (d.kind === 'fetch') return fetchForNode(info, d).then(function (n) { return settleFetch(info, n); });
    if (d.kind === 'abort') return Promise.reject(new TypeError('Failed to fetch'));
    if (d.kind === 'fulfill') return Promise.resolve(responseFrom(d));
    return realFetch(info, d);
  }
  function track(p, info) {
    return p.then(function (res) {
      emit({ t: 'response', id: info.id, url: res.url || info.url, status: res.status, statusText: res.statusText, headers: hdrs(res.headers) });
      return res;
    }, function (err) {
      emit({ t: 'requestfailed', id: info.id, failure: String((err && err.message) || err) });
      throw err;
    });
  }

  window.fetch = function (input, init) {
    var req;
    try { req = new Request(input, init); } catch (e) { return ofetch.apply(window, arguments); }
    var info = { id: ++ts.seq, url: req.url, method: req.method, headers: hdrs(req.headers), type: 'fetch', body: null };
    var hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    var bodyP = hasBody ? req.clone().text().catch(function () { return null; }) : Promise.resolve(null);
    return bodyP.then(function (body) {
      info.body = body;
      emit({ t: 'request', id: info.id, url: info.url, method: info.method, headers: info.headers, body: body, type: 'fetch' });
      if (!routing()) return track(ofetch.call(window, req), info);
      return track(decide(info).then(function (d) { return settleFetch(info, d); }), info);
    });
  };

  var XP = XMLHttpRequest.prototype, xopen = XP.open, xsend = XP.send, xset = XP.setRequestHeader;
  XP.open = function (method, url, async) {
    var abs = url;
    try { abs = new URL(url, location.href).href; } catch (e) {}
    this.__tsx = { method: String(method).toUpperCase(), url: abs, headers: {}, async: async !== false };
    return xopen.apply(this, arguments);
  };
  XP.setRequestHeader = function (k, v) {
    if (this.__tsx) this.__tsx.headers[String(k).toLowerCase()] = String(v);
    return xset.apply(this, arguments);
  };
  function fakeXhr(xhr, info, d) {
    var bytes = d.body ? unb64(d.body) : new Uint8Array(0);
    var text = new TextDecoder().decode(bytes);
    var headers = d.headers || {};
    var lower = {};
    Object.keys(headers).forEach(function (k) { lower[k.toLowerCase()] = headers[k]; });
    var type = xhr.responseType;
    var response = text;
    if (type === 'json') { try { response = JSON.parse(text); } catch (e) { response = null; } }
    else if (type === 'arraybuffer') response = bytes.buffer;
    else if (type === 'blob') response = new Blob([bytes], { type: lower['content-type'] || '' });
    var props = {
      readyState: 4, status: d.status || 200, statusText: d.statusText || 'OK',
      responseText: text, response: response, responseURL: info.url,
    };
    Object.keys(props).forEach(function (k) {
      Object.defineProperty(xhr, k, { configurable: true, get: function () { return props[k]; } });
    });
    xhr.getResponseHeader = function (k) { var v = lower[String(k).toLowerCase()]; return v === undefined ? null : v; };
    xhr.getAllResponseHeaders = function () {
      return Object.keys(lower).map(function (k) { return k + ': ' + lower[k]; }).join('\r\n');
    };
    ['readystatechange', 'load', 'loadend'].forEach(function (name) {
      xhr.dispatchEvent(new ProgressEvent(name));
    });
    emit({ t: 'response', id: info.id, url: info.url, status: props.status, statusText: props.statusText, headers: lower });
  }
  function failXhr(xhr, info) {
    Object.defineProperty(xhr, 'readyState', { configurable: true, get: function () { return 4; } });
    Object.defineProperty(xhr, 'status', { configurable: true, get: function () { return 0; } });
    ['readystatechange', 'error', 'loadend'].forEach(function (name) { xhr.dispatchEvent(new ProgressEvent(name)); });
    emit({ t: 'requestfailed', id: info.id, failure: 'net::ERR_FAILED' });
  }
  XP.send = function (body) {
    var x = this.__tsx;
    if (!x) return xsend.apply(this, arguments);
    var xhr = this;
    var info = { id: ++ts.seq, url: x.url, method: x.method, headers: x.headers, type: 'xhr', body: typeof body === 'string' ? body : null };
    emit({ t: 'request', id: info.id, url: info.url, method: info.method, headers: info.headers, body: info.body, type: 'xhr' });
    xhr.addEventListener('loadend', function () {
      if (xhr.__tsFaked) return;
      if (xhr.status) emit({ t: 'response', id: info.id, url: xhr.responseURL || info.url, status: xhr.status, statusText: xhr.statusText, headers: {} });
      else emit({ t: 'requestfailed', id: info.id, failure: 'net::ERR_FAILED' });
    });
    if (!routing() || !x.async) return xsend.apply(xhr, arguments);
    var args = arguments;
    function apply(d) {
      if (d.kind === 'fetch') return fetchForNode(info, d).then(apply);
      if (d.kind === 'abort') { xhr.__tsFaked = true; failXhr(xhr, info); return; }
      if (d.kind === 'fulfill') { xhr.__tsFaked = true; fakeXhr(xhr, info, d); return; }
      if (d.url || d.method) {
        xopen.call(xhr, d.method || x.method, d.url || x.url, true);
        var h = d.headers || x.headers;
        Object.keys(h).forEach(function (k) { xset.call(xhr, k, h[k]); });
      }
      xsend.call(xhr, d.body !== undefined && d.body !== null ? d.body : args[0]);
    }
    decide(info).then(apply);
  };
})();`;
