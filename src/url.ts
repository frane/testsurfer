/** URL matchers for routes, waits and events: exact strings, globs, regexps and predicates. */

export type UrlMatcher = string | RegExp | ((url: URL) => boolean);

/** Playwright-style glob: `**` any characters, `*` any but `/`, `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  let inGroup = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '\\' && i + 1 < glob.length) {
      // A backslash makes the next character literal (`index\\?hello`).
      const next = glob[++i]!;
      out += '\\^$.|?+()[]{}*'.includes(next) ? `\\${next}` : next;
    } else if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') {
          // `**/` also matches nothing, so `**/api` matches `/api`.
          out += '/?';
          i++;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '{') {
      inGroup = true;
      out += '(';
    } else if (c === '}' && inGroup) {
      inGroup = false;
      out += ')';
    } else if (c === ',' && inGroup) {
      out += '|';
    } else if ('\\^$.|?+()[]'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`${out}$`);
}

export function urlMatches(matcher: UrlMatcher, url: string, baseURL?: string): boolean {
  if (typeof matcher === 'function') {
    try {
      return matcher(new URL(url));
    } catch {
      return false;
    }
  }
  if (matcher instanceof RegExp) return matcher.test(url);
  let pattern = matcher;
  if (baseURL && !/^[a-z]+:|^\*/i.test(pattern)) {
    try {
      pattern = new URL(pattern, baseURL).href;
    } catch {
      /* keep as given */
    }
  }
  if (!/[*{]/.test(pattern)) return url === pattern;
  return globToRegExp(pattern).test(url);
}
