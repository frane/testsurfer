/**
 * Context options that Playwright sets through its browser protocol,
 * done here with document-start scripts and request headers: user
 * agent, locale, time zone, geolocation and permissions, touch, and
 * the online state. Each builder returns a script that runs before the
 * page's own scripts, in every frame.
 */

export interface Geolocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

/** navigator.userAgent, appVersion and the User-Agent header (set by the caller). */
export function userAgentScript(ua: string): string {
  return `(() => {
    const ua = ${JSON.stringify(ua)};
    const nav = Object.getPrototypeOf(navigator);
    Object.defineProperty(nav, 'userAgent', { get: () => ua, configurable: true });
    Object.defineProperty(nav, 'appVersion', { get: () => ua.replace(/^Mozilla\\//, ''), configurable: true });
  })();`;
}

/**
 * navigator.language(s), and `locale` as the default of every Intl
 * constructor and toLocale*String / localeCompare, as a browser
 * started with that locale has.
 */
export function localeScript(locale: string): string {
  return `(() => {
    const L = ${JSON.stringify(locale)};
    const nav = Object.getPrototypeOf(navigator);
    Object.defineProperty(nav, 'language', { get: () => L, configurable: true });
    Object.defineProperty(nav, 'languages', { get: () => [L], configurable: true });
    const def = (locales) => (locales === undefined || (Array.isArray(locales) && locales.length === 0) ? L : locales);
    for (const name of ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat', 'ListFormat', 'DisplayNames', 'Segmenter']) {
      const C = Intl[name];
      if (!C) continue;
      const W = function (locales, options) { return new.target ? new C(def(locales), options) : C(def(locales), options); };
      W.prototype = C.prototype;
      W.supportedLocalesOf = C.supportedLocalesOf;
      Object.defineProperty(Intl, name, { value: W, writable: true, configurable: true });
    }
    const wrap = (proto, key) => {
      const f = proto[key];
      Object.defineProperty(proto, key, { value: function (locales, options) { return f.call(this, def(locales), options); }, writable: true, configurable: true });
    };
    for (const k of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) wrap(Date.prototype, k);
    wrap(Number.prototype, 'toLocaleString');
    if (typeof BigInt !== 'undefined') wrap(BigInt.prototype, 'toLocaleString');
    wrap(Array.prototype, 'toLocaleString');
    const lc = String.prototype.localeCompare;
    Object.defineProperty(String.prototype, 'localeCompare', { value: function (that, locales, options) { return lc.call(this, that, def(locales), options); }, writable: true, configurable: true });
  })();`;
}

/**
 * The page's local time in `zone` (an IANA name): Date's local-time
 * getters, setters, constructor and string forms, getTimezoneOffset,
 * and the default time zone of Intl.DateTimeFormat.
 */
/** timezoneScript: Minutes ahead of UTC in the zone at an instant, and the instant for local wall-clock fields. */
const TZ_ZONE_MATH = `    const OD = Date;
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: Z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short' });
    // Minutes the zone is ahead of UTC at instant t.
    const ahead = (t) => {
      if (!isFinite(t)) return 0;
      const p = {};
      for (const x of fmt.formatToParts(new OD(t))) p[x.type] = x.value;
      let y = +p.year;
      if (p.era === 'BC' || p.era === 'B') y = 1 - y;
      const asUTC = OD.UTC(y, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      return Math.round((asUTC - (t - (((t % 1000) + 1000) % 1000))) / 60000);
    };
    // UTC instant for local wall-clock fields in the zone.
    const fromLocal = (y, mo, d, h, mi, s, ms) => {
      const guess = OD.UTC(y, mo, d, h, mi, s, ms);
      let t = guess - ahead(guess) * 60000;
      t = guess - ahead(t) * 60000;
      return t;
    };
`;

/** timezoneScript: Date's local getters and getTimezoneOffset read the zone's wall clock. */
const TZ_LOCAL_GETTERS = `    const DP = OD.prototype;
    const utc = {
      FullYear: DP.getUTCFullYear, Month: DP.getUTCMonth, Date: DP.getUTCDate, Day: DP.getUTCDay,
      Hours: DP.getUTCHours, Minutes: DP.getUTCMinutes, Seconds: DP.getUTCSeconds, Milliseconds: DP.getUTCMilliseconds,
    };
    const shifted = (d) => new OD(DP.getTime.call(d) + ahead(DP.getTime.call(d)) * 60000);
    for (const [k, g] of Object.entries(utc)) {
      Object.defineProperty(DP, 'get' + k, { value: function () { const t = DP.getTime.call(this); return isNaN(t) ? NaN : g.call(shifted(this)); }, writable: true, configurable: true });
    }
    Object.defineProperty(DP, 'getTimezoneOffset', { value: function () { return -ahead(DP.getTime.call(this)); }, writable: true, configurable: true });
`;

/** timezoneScript: Date's local setters write the zone's wall clock. */
const TZ_LOCAL_SETTERS = `    const fields = (d) => { const s = shifted(d); return [utc.FullYear.call(s), utc.Month.call(s), utc.Date.call(s), utc.Hours.call(s), utc.Minutes.call(s), utc.Seconds.call(s), utc.Milliseconds.call(s)]; };
    const setter = (name, idx, n) => function (...args) {
      const f = fields(this);
      for (let i = 0; i < n && i < args.length; i++) f[idx + i] = +args[i];
      return DP.setTime.call(this, fromLocal(...f));
    };
    const set = { FullYear: [0, 3], Month: [1, 2], Date: [2, 1], Hours: [3, 4], Minutes: [4, 3], Seconds: [5, 2], Milliseconds: [6, 1] };
    for (const [k, [i, n]] of Object.entries(set)) Object.defineProperty(DP, 'set' + k, { value: setter(k, i, n), writable: true, configurable: true });
`;

/** timezoneScript: toString, toDateString, toTimeString and the toLocale forms in the zone. */
const TZ_STRING_FORMS = `    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const zoneName = (d) => { try { return new Intl.DateTimeFormat('en-US', { timeZone: Z, timeZoneName: 'long' }).formatToParts(d).find((p) => p.type === 'timeZoneName').value; } catch (e) { return Z; } };
    const off = (d) => { const a = ahead(DP.getTime.call(d)); return 'GMT' + (a < 0 ? '-' : '+') + pad(Math.floor(Math.abs(a) / 60)) + pad(Math.abs(a) % 60); };
    const dateStr = (d) => { const f = fields(d); return DAYS[utc.Day.call(shifted(d))] + ' ' + MONTHS[f[1]] + ' ' + pad(f[2]) + ' ' + (f[0] < 0 ? '-' + pad(-f[0], 6) : pad(f[0], 4)); };
    const timeStr = (d) => { const f = fields(d); return pad(f[3]) + ':' + pad(f[4]) + ':' + pad(f[5]) + ' ' + off(d) + ' (' + zoneName(d) + ')'; };
    const valid = (d) => !isNaN(DP.getTime.call(d));
    Object.defineProperty(DP, 'toString', { value: function () { return valid(this) ? dateStr(this) + ' ' + timeStr(this) : 'Invalid Date'; }, writable: true, configurable: true });
    Object.defineProperty(DP, 'toDateString', { value: function () { return valid(this) ? dateStr(this) : 'Invalid Date'; }, writable: true, configurable: true });
    Object.defineProperty(DP, 'toTimeString', { value: function () { return valid(this) ? timeStr(this) : 'Invalid Date'; }, writable: true, configurable: true });
    for (const k of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
      const f = DP[k];
      Object.defineProperty(DP, k, { value: function (locales, options) { return f.call(this, locales, Object.assign({ timeZone: Z }, options)); }, writable: true, configurable: true });
    }
`;

/** timezoneScript: new Date(...) and Date.parse read zone-less local times in the zone; Intl.DateTimeFormat defaults to it. */
const TZ_LOCAL_CONSTRUCTOR = `    // new Date(y, m, ...) and Date.parse of a string without a zone mean local time.
    const localString = (s) => typeof s === 'string' && !/(Z|[+-]\\d\\d:?\\d\\d|GMT|UTC)\\s*$/i.test(s.trim()) && !/^\\d{4}-\\d{2}-\\d{2}$/.test(s.trim());
    const sysOffset = (t) => OD.prototype.getTimezoneOffset.call(new OD(t));
    const reparse = (s) => {
      const t = OD.parse(s);
      if (isNaN(t) || !localString(s)) return t;
      // The engine read the string in the system zone; read the same wall clock in Z.
      const wall = t - sysOffset(t) * 60000;
      const g = new OD(wall);
      return fromLocal(g.getUTCFullYear(), g.getUTCMonth(), g.getUTCDate(), g.getUTCHours(), g.getUTCMinutes(), g.getUTCSeconds(), g.getUTCMilliseconds());
    };
    function D(...a) {
      if (!new.target) return new D().toString();
      if (a.length === 0) return new OD();
      if (a.length === 1) return typeof a[0] === 'string' ? new OD(reparse(a[0])) : new OD(a[0] instanceof OD ? DP.getTime.call(a[0]) : a[0]);
      const [y, mo, d = 1, h = 0, mi = 0, s = 0, ms = 0] = a.map(Number);
      return new OD(fromLocal(y >= 0 && y <= 99 ? 1900 + y : y, mo, d, h, mi, s, ms));
    }
    D.prototype = DP;
    D.now = OD.now;
    D.UTC = OD.UTC;
    D.parse = (s) => reparse(String(s));
    Object.defineProperty(DP, 'constructor', { value: D, writable: true, configurable: true });
    self.Date = D;
    const DTF = Intl.DateTimeFormat;
    const W = function (locales, options) { const o = Object.assign({}, options); if (o.timeZone === undefined) o.timeZone = Z; return new.target ? new DTF(locales, o) : DTF(locales, o); };
    W.prototype = DTF.prototype;
    W.supportedLocalesOf = DTF.supportedLocalesOf;
    Object.defineProperty(Intl, 'DateTimeFormat', { value: W, writable: true, configurable: true });
`;

export function timezoneScript(zone: string): string {
  return `(() => {
    const Z = ${JSON.stringify(zone)};
${TZ_ZONE_MATH}${TZ_LOCAL_GETTERS}${TZ_LOCAL_SETTERS}${TZ_STRING_FORMS}${TZ_LOCAL_CONSTRUCTOR}  })();`;
}

/** navigator.geolocation answering with `geo` while the geolocation permission is granted. */
export function geolocationScript(geo: Geolocation | null, granted: string[]): string {
  return `(() => {
    const G = ${JSON.stringify(geo)};
    const granted = new Set(${JSON.stringify(granted)});
    self.__tsGeo = G;
    self.__tsGranted = granted;
    const position = () => {
      const g = self.__tsGeo;
      return { coords: { latitude: g.latitude, longitude: g.longitude, accuracy: g.accuracy ?? 0, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON() { return this; } }, timestamp: Date.now(), toJSON() { return this; } };
    };
    const fail = (cb, code, message) => cb && setTimeout(() => cb({ code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }), 0);
    const answer = (ok, err) => {
      if (!self.__tsGranted.has('geolocation')) return fail(err, 1, 'User denied Geolocation');
      if (!self.__tsGeo) return fail(err, 2, 'Position unavailable');
      setTimeout(() => ok(position()), 0);
    };
    let next = 1;
    const watches = new Map();
    const geo = {
      getCurrentPosition(ok, err) { answer(ok, err); },
      watchPosition(ok, err) { const id = next++; watches.set(id, true); answer(ok, err); return id; },
      clearWatch(id) { watches.delete(id); },
    };
    if (navigator.geolocation) Object.defineProperty(Object.getPrototypeOf(navigator), 'geolocation', { get: () => geo, configurable: true });
    if (navigator.permissions && navigator.permissions.query) {
      const q = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (desc) => {
        const name = desc && desc.name;
        if (!name) return q(desc);
        const state = self.__tsGranted.has(name) ? 'granted' : 'prompt';
        return Promise.resolve({ name, state, onchange: null, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } });
      };
    }
  })();`;
}

/**
 * Touch support as Playwright's WebKit has it: touch event handlers on
 * window (`ontouchstart`) and the coarse pointer media features;
 * navigator.maxTouchPoints stays 0, as there.
 */
export function touchScript(): string {
  return `(() => {
    if (!('ontouchstart' in window)) window.ontouchstart = null;
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => mm(String(q).replace(/\\(\\s*(any-)?pointer\\s*:\\s*coarse\\s*\\)/g, '(min-width: 0px)').replace(/\\(\\s*(any-)?pointer\\s*:\\s*fine\\s*\\)/g, '(max-width: -1px)').replace(/\\(\\s*(any-)?hover\\s*:\\s*none\\s*\\)/g, '(min-width: 0px)').replace(/\\(\\s*(any-)?hover\\s*:\\s*hover\\s*\\)/g, '(max-width: -1px)'));
  })();`;
}

/** navigator.onLine follows the context's offline setting, with online/offline events on a change. */
export function onlineScript(offline: boolean): string {
  return `(() => {
    const was = self.__tsOffline;
    self.__tsOffline = ${offline};
    if (!self.__tsOnlineHooked) {
      self.__tsOnlineHooked = true;
      Object.defineProperty(Object.getPrototypeOf(navigator), 'onLine', { get: () => !self.__tsOffline, configurable: true });
    }
    if (was !== undefined && was !== self.__tsOffline) window.dispatchEvent(new Event(self.__tsOffline ? 'offline' : 'online'));
  })();`;
}
