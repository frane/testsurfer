/**
 * jest-style value printing and line diffs, as Playwright shows them
 * when an object or array assertion fails:
 *
 *   - Expected  - 1
 *   + Received  + 1
 *
 *     Object {
 *       "a": 1,
 *   -   "c": 2021-07-28T20:26:32.001Z,
 *   +   "c": 2021-07-28T20:26:32.000Z,
 *     }
 */

function pretty(v: unknown, indent: string, seen: unknown[]): string[] {
  if (v === null) return ['null'];
  if (v === undefined) return ['undefined'];
  if (typeof v === 'string') return [JSON.stringify(v)];
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
  if (typeof v === 'bigint') return [`${v}n`];
  if (v instanceof Date) return [Number.isNaN(v.getTime()) ? 'Date { NaN }' : v.toISOString()];
  if (v instanceof RegExp) return [String(v)];
  if (typeof v !== 'object') return [String(v)];
  if (seen.includes(v)) return ['[Circular]'];
  const inner = indent + '  ';
  const next = [...seen, v];
  const block = (open: string, close: string, items: string[][]): string[] => {
    if (items.length === 0) return [`${open}${close}`];
    const out = [`${open}`];
    for (const lines of items) {
      lines.forEach((l, i) => out.push(`${inner}${l}${i === lines.length - 1 ? ',' : ''}`));
    }
    out.push(`${indent}${close}`);
    return out;
  };
  if (Array.isArray(v)) return block('Array [', ']', v.map((x) => pretty(x, inner, next)));
  if (v instanceof Map) {
    return block(
      'Map {',
      '}',
      [...v.entries()].map(([k, x]) => {
        const val = pretty(x, inner, next);
        return [`${pretty(k, inner, next).join('')} => ${val[0]}`, ...val.slice(1)];
      }),
    );
  }
  if (v instanceof Set) return block('Set {', '}', [...v].map((x) => pretty(x, inner, next)));
  const name = (v as object).constructor?.name;
  const label = !name || name === 'Object' ? 'Object' : name;
  const keys = Object.keys(v as object).sort();
  return block(
    `${label} {`,
    '}',
    keys.map((k) => {
      const val = pretty((v as Record<string, unknown>)[k], inner, next);
      return [`${JSON.stringify(k)}: ${val[0]}`, ...val.slice(1)];
    }),
  );
}

/** A value printed the way jest's pretty-format does, one line per entry. */
export function prettyLines(v: unknown): string[] {
  return pretty(v, '', []);
}

/** Whether a value prints on several lines (and so earns a diff). */
export function isStructured(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !(v instanceof Date) && !(v instanceof RegExp);
}

/** Line diff of the two printed values, with the "- Expected / + Received" header. */
export function diffValues(expected: unknown, received: unknown): string {
  const a = prettyLines(expected);
  const b = prettyLines(received);
  // LCS table over lines.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let minus = 0;
  let plus = 0;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      // Emit removals before additions at the same spot, as jest does.
      if (i < n && dp[i + 1]![j]! === dp[i]![j + 1]!) {
        out.push(`- ${a[i]}`);
        minus++;
        i++;
      } else {
        out.push(`+ ${b[j]}`);
        plus++;
        j++;
      }
    } else {
      out.push(`- ${a[i]}`);
      minus++;
      i++;
    }
  }
  return [`- Expected  - ${minus}`, `+ Received  + ${plus}`, '', ...out].join('\n');
}
