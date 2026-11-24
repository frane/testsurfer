/**
 * Cookies in Playwright's shape, and the conversions to and from the
 * jar vibesurfer keeps per context (`vs_cookies`, HttpOnly included).
 */

/** A cookie as context.cookies() returns it. `expires` is unix seconds, -1 for a session cookie. */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/** A cookie for context.addCookies(): `url`, or `domain` and `path`. */
export interface CookieInput {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** The daemon's wire shape (vibesurfer's CookieData). */
export interface WireCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires_unix?: number;
  secure: boolean;
  http_only: boolean;
  same_site?: string;
}

export function fromWire(c: WireCookie): Cookie {
  const ss = (c.same_site ?? '').toLowerCase();
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    expires: c.expires_unix ?? -1,
    httpOnly: c.http_only,
    secure: c.secure,
    sameSite: ss === 'strict' ? 'Strict' : ss === 'lax' ? 'Lax' : 'None',
  };
}

export function toWire(c: CookieInput | Cookie): WireCookie {
  const u = 'url' in c && c.url ? new URL(c.url) : null;
  const domain = c.domain ?? u?.hostname;
  if (!domain) throw new Error('browserContext.addCookies: a cookie needs url or domain');
  const path = c.path ?? (u ? u.pathname.replace(/\/[^/]*$/, '/') || '/' : '/');
  const out: WireCookie = {
    name: c.name,
    value: c.value,
    domain,
    path,
    secure: c.secure ?? u?.protocol === 'https:',
    http_only: c.httpOnly ?? false,
  };
  if (c.expires !== undefined && c.expires > 0) out.expires_unix = Math.floor(c.expires);
  if (c.sameSite) out.same_site = c.sameSite;
  return out;
}

/** Whether `c` goes with a request to `url` (RFC 6265 domain, path and secure rules). */
export function matches(c: Cookie, url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const d = c.domain.toLowerCase();
  const domainOk = d.startsWith('.') ? host === d.slice(1) || host.endsWith(d) : host === d;
  if (!domainOk) return false;
  const p = u.pathname || '/';
  const pathOk = p === c.path || (p.startsWith(c.path) && (c.path.endsWith('/') || p[c.path.length] === '/'));
  if (!pathOk) return false;
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (c.secure && u.protocol !== 'https:' && !loopback) return false;
  if (c.expires > 0 && c.expires * 1000 < Date.now()) return false;
  return true;
}

/** The `Cookie` header for a request to `url`, longest path first; undefined when none apply. */
export function cookieHeader(jar: Cookie[], url: string): string | undefined {
  const picked = jar.filter((c) => matches(c, url)).sort((a, b) => b.path.length - a.path.length);
  return picked.length ? picked.map((c) => `${c.name}=${c.value}`).join('; ') : undefined;
}

/** One `Set-Cookie` header of a response to `url`, as a cookie for the jar; null when it is not valid for that URL. */
export function parseSetCookie(header: string, url: string): WireCookie | null {
  const u = new URL(url);
  const [pair, ...attrs] = header.split(';');
  const eq = (pair ?? '').indexOf('=');
  if (eq <= 0) return null;
  const name = pair!.slice(0, eq).trim();
  const value = pair!.slice(eq + 1).trim();
  let domain = u.hostname;
  let path = u.pathname.replace(/\/[^/]*$/, '/') || '/';
  let expires: number | undefined;
  let maxAge: number | undefined;
  let secure = false;
  let httpOnly = false;
  let sameSite: string | undefined;
  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : a.slice(i + 1).trim();
    if (k === 'domain' && v) {
      const d = v.replace(/^\./, '').toLowerCase();
      const host = u.hostname.toLowerCase();
      if (host !== d && !host.endsWith(`.${d}`)) return null;
      domain = `.${d}`;
    } else if (k === 'path' && v.startsWith('/')) path = v;
    else if (k === 'expires') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) expires = Math.floor(t / 1000);
    } else if (k === 'max-age') {
      const n = Number(v);
      if (Number.isFinite(n)) maxAge = n;
    } else if (k === 'secure') secure = true;
    else if (k === 'httponly') httpOnly = true;
    else if (k === 'samesite') sameSite = v;
  }
  const out: WireCookie = { name, value, domain, path, secure, http_only: httpOnly };
  if (maxAge !== undefined) out.expires_unix = Math.floor(Date.now() / 1000) + maxAge;
  else if (expires !== undefined) out.expires_unix = expires;
  if (sameSite) out.same_site = sameSite;
  return out;
}

/** Storage state as Playwright saves it: the jar and each origin's localStorage. */
export interface StorageState {
  cookies: Cookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}
