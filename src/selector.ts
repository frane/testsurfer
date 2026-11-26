/**
 * Playwright's string selector syntax, compiled to locator steps:
 * `>>` chains, the `css=`, `text=`, `xpath=`, `id=`, `data-testid=`,
 * `role=`, `nth=` and `visible=` engines, and the CSS extensions
 * `:has-text()`, `:text()`, `:text-is()`, `:text-matches()` and
 * `:visible` at the end of a CSS selector.
 */

import type { ByRoleOptions } from './query.ts';

/** Element-level checks applied page-side after querySelectorAll. */
export interface CssExtras {
  /** :has-text(): normalized textContent contains (case-insensitive). */
  hasText?: string[];
  /** :text(): like has-text, on the element's own text. */
  text?: string[];
  /** :text-is(): normalized text equals. */
  textIs?: string[];
  /** :text-matches(): [source, flags]. */
  textRe?: [string, string][];
  visible?: boolean;
}

export type ParsedPart = BasePart & { capture?: boolean };

type BasePart =
  | { kind: 'css'; selector: string; extras: CssExtras; light?: boolean }
  | { kind: 'xpath'; xpath: string }
  | { kind: 'text'; text: string | RegExp; exact: boolean; light?: boolean; legacy?: boolean }
  | { kind: 'attr'; attr: string; value: string }
  | { kind: 'role'; role: string; options: ByRoleOptions }
  | { kind: 'nth'; index: number }
  | { kind: 'visible'; visible: boolean };

/** Split on a top-level separator, ignoring it inside quotes, brackets and parentheses. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    // A quote opens a string only where one can start: a part's start,
    // after `=` (engine body, attribute value), `(` or `,`. Elsewhere it
    // is a literal character (`text=/let's/ >> span`).
    const before = s.slice(start, i).trimEnd();
    const opens = before === '' || /[=(,]$/.test(before);
    if ((c === '"' || c === "'" || c === '`') && opens) quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function unquote(v: string): { value: string; quoted: boolean; flag: string } {
  const m = /^(["'`])([\s\S]*)\1([is]?)$/.exec(v.trim());
  if (!m) return { value: v.trim(), quoted: false, flag: '' };
  return { value: m[2]!.replace(/\\(.)/g, '$1'), quoted: true, flag: m[3]! };
}

function parseRegex(v: string): RegExp | null {
  const m = /^\/([\s\S]*)\/([a-z]*)$/.exec(v.trim());
  return m ? new RegExp(m[1]!, m[2]) : null;
}

function textPart(body: string): BasePart {
  const re = parseRegex(body);
  if (re) return { kind: 'text', text: re, exact: false };
  // Only a quote right at the start makes a quoted body; `text= "x"`
  // searches for the literal `"x"`.
  if (!/^["'`]/.test(body)) return { kind: 'text', text: body.trim(), exact: false };
  const q = unquote(body);
  // "quoted" matches the element's own text nodes, case-sensitively; a
  // trailing i makes it case-insensitive again.
  return { kind: 'text', text: q.value, exact: q.quoted && q.flag !== 'i', legacy: true };
}

const ROLE_ATTRS = ['checked', 'disabled', 'expanded', 'include-hidden', 'level', 'name', 'pressed', 'selected'];
const ROLE_SUPPORT: Record<string, string[]> = {
  checked: ['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem'],
  pressed: ['button'],
  selected: ['row', 'gridcell', 'tab', 'option', 'columnheader', 'rowheader', 'treeitem'],
  level: ['heading', 'listitem', 'row', 'treeitem'],
};

/** `role=button[name="OK"i][pressed]`, with Playwright's attribute grammar and errors. */
function rolePart(body: string): BasePart {
  const src = body.trim();
  const m = /^([a-zA-Z]*)([\s\S]*)$/.exec(src)!;
  const role = m[1]!.toLowerCase();
  if (!role) throw new Error('Error: Role must not be empty');
  const options: ByRoleOptions & { nameFull?: boolean } = {};
  let rest = m[2]!.trim();
  while (rest) {
    const a = /^\[\s*([^\]=*~^$|]*?)\s*(?:(\*=|~=|\^=|\$=|\|=|=)\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\/(?:[^/\\]|\\.)*\/[a-z]*|[^\]\s]*))\s*([is])?)?\s*\]/.exec(rest);
    if (!a) throw new Error(`Error: Unexpected token while parsing role selector "role=${src}"`);
    rest = rest.slice(a[0].length).trim();
    const key = a[1]!.replace(/\s+/g, '');
    const op = a[2];
    const raw = a[3];
    const flag = a[4];
    if (!ROLE_ATTRS.includes(key)) {
      throw new Error(`Error: Unknown attribute "${key}", must be one of ${ROLE_ATTRS.map((x) => `"${x}"`).join(', ')}.`);
    }
    const supported = ROLE_SUPPORT[key];
    if (supported && !supported.includes(role)) {
      throw new Error(`Error: "${key}" attribute is only supported for roles: ${supported.map((x) => `"${x}"`).join(', ')}`);
    }
    const quoted = raw !== undefined && /^["']/.test(raw);
    const value = raw === undefined ? undefined : quoted ? unquote(raw).value : raw;
    if (op && op !== '=' && !(key === 'name' && op === '*=')) {
      if (key !== 'name') throw new Error(`Error: cannot use ${op} in attribute with non-string matching value`);
    }
    if (key === 'name') {
      if (value === undefined) throw new Error('Error: "name" attribute must have a value');
      const re = !quoted ? parseRegex(raw!) : null;
      if (re) options.name = re;
      else if (op === '*=') options.name = value;
      else {
        options.name = value;
        if (flag === 's') options.exact = true;
        else options.nameFull = true;
      }
      continue;
    }
    if (key === 'level') {
      const n = Number(value);
      if (value === undefined || quoted || !Number.isInteger(n)) throw new Error('Error: "level" attribute must be compared to a number');
      options.level = n;
      continue;
    }
    // Boolean states: bare means true.
    let v: boolean | 'mixed';
    if (value === undefined) v = true;
    else if (value === 'true' && !quoted) v = true;
    else if (value === 'false' && !quoted) v = false;
    else if (value === 'mixed' && (key === 'checked' || key === 'pressed')) v = 'mixed';
    else if (key === 'checked' || key === 'pressed') throw new Error(`Error: "${key}" must be one of true, false, "mixed"`);
    else throw new Error(`Error: "${key}" must be one of true, false`);
    if (key === 'include-hidden') options.includeHidden = v === true;
    else (options as Record<string, unknown>)[key] = v;
  }
  return { kind: 'role', role, options };
}

/** CSS, passed through whole: the engine handles Playwright's pseudos in any position. */
function cssPart(selector: string): ParsedPart {
  return { kind: 'css', selector: selector.trim(), extras: {} };
}

function onePart(raw: string): ParsedPart {
  const part = raw.trim();
  // `*css=div >> span`: the result is the marked part, among those the rest matches inside.
  if (/^\*[a-zA-Z_-]+=/.test(part)) return { ...basePart(part.slice(1)), capture: true };
  return basePart(part);
}

function basePart(part: string): BasePart {
  const eng = /^([a-zA-Z_][\w-]*(?::light)?)\s*=([\s\S]*)$/.exec(part);
  if (eng) {
    const [, name, body] = eng as unknown as [string, string, string];
    switch (name) {
      case 'css':
        return cssPart(body);
      case 'css:light':
        return { kind: 'css', selector: body.trim(), extras: {}, light: true };
      case 'text:light':
        return { ...textPart(body), light: true } as BasePart;
      case 'xpath':
        return { kind: 'xpath', xpath: body.trim() };
      case 'text':
        return textPart(body);
      case 'id':
      case 'data-testid':
      case 'data-test-id':
      case 'data-test':
        return { kind: 'attr', attr: name, value: unquote(body).value };
      case 'role':
        return rolePart(body);
      case 'nth':
        return { kind: 'nth', index: Number(body) };
      case 'visible':
        return { kind: 'visible', visible: body.trim() !== 'false' };
      default:
        throw new Error(`Unknown engine "${name}" while parsing selector ${part}`);
    }
  }
  if (part.startsWith('//') || part.startsWith('..') || part.startsWith('(//')) return { kind: 'xpath', xpath: part };
  // A quoted string alone is a text selector.
  if (/^(["'`]).*\1[is]?$/s.test(part)) return textPart(part);
  return cssPart(part);
}

/** A selector string as engine parts, in chain order. */
export function parseSelector(selector: string): ParsedPart[] {
  return splitTop(selector, '>>').map(onePart);
}
