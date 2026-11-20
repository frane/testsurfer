/**
 * Playwright's string selector syntax, compiled to locator steps:
 * `>>` chains, the `css=`, `text=`, `xpath=`, `id=`, `data-testid=`,
 * `role=`, `nth=` and `visible=` engines, and the CSS extensions
 * `:has-text()`, `:text()`, `:text-is()`, `:text-matches()` and
 * `:visible` at the end of a CSS selector.
 */

import type { ByRoleOptions } from './locator.ts';

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

export type ParsedPart =
  | { kind: 'css'; selector: string; extras: CssExtras }
  | { kind: 'xpath'; xpath: string }
  | { kind: 'text'; text: string | RegExp; exact: boolean }
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
    if (c === '"' || c === "'" || c === '`') quote = c;
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

function textPart(body: string): ParsedPart {
  const re = parseRegex(body);
  if (re) return { kind: 'text', text: re, exact: false };
  const q = unquote(body);
  // "quoted" is a whole-string, case-sensitive match; a trailing i
  // makes it case-insensitive again.
  return { kind: 'text', text: q.value, exact: q.quoted && q.flag !== 'i' };
}

function rolePart(body: string): ParsedPart {
  const m = /^([a-z]+)((?:\[[^\]]*\])*)$/i.exec(body.trim());
  if (!m) throw new Error(`unsupported role selector "role=${body}"`);
  const options: ByRoleOptions = {};
  for (const [, key, raw] of m[2]!.matchAll(/\[\s*([\w-]+)\s*(?:=\s*([^\]]*))?\]/g)) {
    if (key === 'name' && raw !== undefined) {
      const re = parseRegex(raw);
      if (re) options.name = re;
      else {
        const q = unquote(raw);
        options.name = q.value;
        if (q.flag === 's') options.exact = true;
      }
    } else if (key === 'level' && raw !== undefined) options.level = Number(raw);
  }
  return { kind: 'role', role: m[1]!.toLowerCase(), options };
}

const PSEUDO = /:(has-text|text-is|text-matches|text|visible)(?:\(((?:[^()"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*)\))?$/;

/**
 * Peel Playwright's text and visibility pseudos off the end of a CSS
 * selector. Only trailing ones are understood; one in the middle of a
 * selector (`div:has-text("x") > span`) is left for the browser to
 * reject.
 */
function cssPart(selector: string): ParsedPart {
  const extras: CssExtras = {};
  let sel = selector.trim();
  for (let m = PSEUDO.exec(sel); m; m = PSEUDO.exec(sel)) {
    sel = sel.slice(0, m.index);
    const [, name, arg = ''] = m;
    if (name === 'visible') extras.visible = true;
    else if (name === 'text-matches') {
      const args = splitTop(arg, ',').map((a) => unquote(a).value);
      (extras.textRe ??= []).push([args[0] ?? '', args[1] ?? '']);
    } else {
      const v = unquote(arg).value;
      const key = name === 'has-text' ? 'hasText' : name === 'text-is' ? 'textIs' : 'text';
      (extras[key] ??= []).push(v);
    }
  }
  // A bare pseudo (`:visible`) applies to any element.
  if (sel === '' || /[\s>+~,]$/.test(sel)) sel += '*';
  return { kind: 'css', selector: sel, extras };
}

function onePart(raw: string): ParsedPart {
  let part = raw.trim();
  if (part.startsWith('*')) part = part.slice(1);
  const eng = /^([a-zA-Z_][\w-]*)\s*=\s*([\s\S]*)$/.exec(part);
  if (eng) {
    const [, name, body] = eng as unknown as [string, string, string];
    switch (name) {
      case 'css':
        return cssPart(body);
      case 'xpath':
        return { kind: 'xpath', xpath: body };
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
        throw new Error(`unsupported selector engine "${name}="`);
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
