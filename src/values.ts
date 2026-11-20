/**
 * Plain-value assertions: the Jest-style half of Playwright's expect
 * (`expect(n).toBe(3)`, `expect(list).toContain(x)`, ...), plus
 * `.resolves`, `.rejects` and the polling form behind expect.poll().
 */

import { isDeepStrictEqual, inspect } from 'node:util';

export class AssertionError extends Error {
  override name = 'AssertionError';
}

const show = (v: unknown) => inspect(v, { depth: 4, breakLength: 120 });

/** Deep equality that ignores undefined properties, as toEqual does. */
function looseEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (isAsymmetric(b)) return b.asymmetricMatch(a);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => looseEqual(v, b[i]));
  }
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => looseEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function matchObject(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (typeof expected !== 'object' || expected === null) return looseEqual(actual, expected);
  if (typeof actual !== 'object' || actual === null) return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matchObject(actual[i], v));
  }
  return Object.entries(expected).every(([k, v]) => matchObject((actual as Record<string, unknown>)[k], v));
}

export interface Asymmetric {
  asymmetricMatch(v: unknown): boolean;
  toString(): string;
}
function isAsymmetric(v: unknown): v is Asymmetric {
  return typeof v === 'object' && v !== null && typeof (v as Asymmetric).asymmetricMatch === 'function';
}

/** expect.any(Number), expect.anything(), expect.stringContaining(...), ... */
export const asymmetric = {
  any(ctor: unknown): Asymmetric {
    return {
      asymmetricMatch: (v) =>
        ctor === Number ? typeof v === 'number' || v instanceof Number
        : ctor === String ? typeof v === 'string' || v instanceof String
        : ctor === Boolean ? typeof v === 'boolean'
        : ctor === Function ? typeof v === 'function'
        : v instanceof (ctor as new () => unknown),
      toString: () => `Any<${(ctor as { name?: string }).name}>`,
    };
  },
  anything(): Asymmetric {
    return { asymmetricMatch: (v) => v !== null && v !== undefined, toString: () => 'Anything' };
  },
  stringContaining(s: string): Asymmetric {
    return { asymmetricMatch: (v) => typeof v === 'string' && v.includes(s), toString: () => `StringContaining ${s}` };
  },
  stringMatching(re: string | RegExp): Asymmetric {
    const r = typeof re === 'string' ? new RegExp(re) : re;
    return { asymmetricMatch: (v) => typeof v === 'string' && r.test(v), toString: () => `StringMatching ${r}` };
  },
  objectContaining(o: object): Asymmetric {
    return { asymmetricMatch: (v) => matchObject(v, o), toString: () => `ObjectContaining ${show(o)}` };
  },
  arrayContaining(items: unknown[]): Asymmetric {
    return {
      asymmetricMatch: (v) => Array.isArray(v) && items.every((i) => v.some((x) => looseEqual(x, i))),
      toString: () => `ArrayContaining ${show(items)}`,
    };
  },
};

type Check = { pass: boolean; message: string };

export class ValueAssertions {
  private readonly actual: unknown;
  private readonly negated: boolean;
  private readonly mode: 'value' | 'resolves' | 'rejects';

  constructor(actual: unknown, negated = false, mode: 'value' | 'resolves' | 'rejects' = 'value') {
    this.actual = actual;
    this.negated = negated;
    this.mode = mode;
  }

  get not(): ValueAssertions {
    return new ValueAssertions(this.actual, !this.negated, this.mode);
  }

  /** Assert on what the promise resolves to. Await the matcher. */
  get resolves(): ValueAssertions {
    return new ValueAssertions(this.actual, this.negated, 'resolves');
  }

  /** Assert on the error the promise rejects with. Await the matcher. */
  get rejects(): ValueAssertions {
    return new ValueAssertions(this.actual, this.negated, 'rejects');
  }

  /** Runs synchronously for plain values; returns a promise under .resolves / .rejects. */
  private run(check: (v: unknown) => Check): void | Promise<void> {
    const finish = (v: unknown) => {
      const { pass, message } = check(v);
      if (pass === this.negated) throw new AssertionError(this.negated ? `not: ${message}` : message);
    };
    if (this.mode === 'value') return finish(this.actual);
    return Promise.resolve(this.actual).then(
      (v) => {
        if (this.mode === 'rejects') throw new AssertionError(`expected a rejection, got ${show(v)}`);
        finish(v);
      },
      (e: unknown) => {
        if (this.mode === 'resolves') throw new AssertionError(`expected a resolution, got rejection ${show(e)}`);
        finish(e);
      },
    );
  }

  toBe(expected: unknown): void | Promise<void> {
    return this.run((v) => ({ pass: Object.is(v, expected), message: `expected ${show(v)} to be ${show(expected)}` }));
  }
  toEqual(expected: unknown): void | Promise<void> {
    return this.run((v) => ({ pass: looseEqual(v, expected), message: `expected ${show(v)} to equal ${show(expected)}` }));
  }
  toStrictEqual(expected: unknown): void | Promise<void> {
    return this.run((v) => ({
      pass: isDeepStrictEqual(v, expected),
      message: `expected ${show(v)} to strictly equal ${show(expected)}`,
    }));
  }
  toMatchObject(expected: object): void | Promise<void> {
    return this.run((v) => ({ pass: matchObject(v, expected), message: `expected ${show(v)} to match ${show(expected)}` }));
  }
  toBeTruthy(): void | Promise<void> {
    return this.run((v) => ({ pass: !!v, message: `expected ${show(v)} to be truthy` }));
  }
  toBeFalsy(): void | Promise<void> {
    return this.run((v) => ({ pass: !v, message: `expected ${show(v)} to be falsy` }));
  }
  toBeNull(): void | Promise<void> {
    return this.run((v) => ({ pass: v === null, message: `expected ${show(v)} to be null` }));
  }
  toBeUndefined(): void | Promise<void> {
    return this.run((v) => ({ pass: v === undefined, message: `expected ${show(v)} to be undefined` }));
  }
  toBeDefined(): void | Promise<void> {
    return this.run((v) => ({ pass: v !== undefined, message: `expected value to be defined` }));
  }
  toBeNaN(): void | Promise<void> {
    return this.run((v) => ({ pass: Number.isNaN(v), message: `expected ${show(v)} to be NaN` }));
  }
  toBeInstanceOf(ctor: new (...a: never[]) => unknown): void | Promise<void> {
    return this.run((v) => ({ pass: v instanceof ctor, message: `expected ${show(v)} to be an instance of ${ctor.name}` }));
  }
  toBeGreaterThan(n: number | bigint): void | Promise<void> {
    return this.run((v) => ({ pass: (v as number) > n, message: `expected ${show(v)} > ${n}` }));
  }
  toBeGreaterThanOrEqual(n: number | bigint): void | Promise<void> {
    return this.run((v) => ({ pass: (v as number) >= n, message: `expected ${show(v)} >= ${n}` }));
  }
  toBeLessThan(n: number | bigint): void | Promise<void> {
    return this.run((v) => ({ pass: (v as number) < n, message: `expected ${show(v)} < ${n}` }));
  }
  toBeLessThanOrEqual(n: number | bigint): void | Promise<void> {
    return this.run((v) => ({ pass: (v as number) <= n, message: `expected ${show(v)} <= ${n}` }));
  }
  toBeCloseTo(n: number, digits = 2): void | Promise<void> {
    return this.run((v) => ({
      pass: Math.abs((v as number) - n) < 10 ** -digits / 2,
      message: `expected ${show(v)} to be close to ${n}`,
    }));
  }
  toContain(item: unknown): void | Promise<void> {
    return this.run((v) => ({
      pass:
        typeof v === 'string' ? v.includes(String(item))
        : v != null && typeof (v as Iterable<unknown>)[Symbol.iterator] === 'function'
          ? [...(v as Iterable<unknown>)].includes(item)
          : false,
      message: `expected ${show(v)} to contain ${show(item)}`,
    }));
  }
  toContainEqual(item: unknown): void | Promise<void> {
    return this.run((v) => ({
      pass: Array.isArray(v) && v.some((x) => looseEqual(x, item)),
      message: `expected ${show(v)} to contain an item equal to ${show(item)}`,
    }));
  }
  toHaveLength(n: number): void | Promise<void> {
    return this.run((v) => ({
      pass: (v as { length?: number } | null)?.length === n,
      message: `expected length ${n}, got ${(v as { length?: number } | null)?.length}`,
    }));
  }
  toHaveProperty(keyPath: string | string[], value?: unknown): void | Promise<void> {
    const keys = Array.isArray(keyPath) ? keyPath : keyPath.split('.');
    const hasValue = arguments.length > 1;
    return this.run((v) => {
      let cur: unknown = v;
      for (const k of keys) {
        if (cur === null || cur === undefined || !(k in Object(cur))) {
          return { pass: false, message: `expected ${show(v)} to have property ${keys.join('.')}` };
        }
        cur = (cur as Record<string, unknown>)[k];
      }
      return {
        pass: !hasValue || looseEqual(cur, value),
        message: `expected property ${keys.join('.')} to be ${show(value)}, got ${show(cur)}`,
      };
    });
  }
  toMatch(re: string | RegExp): void | Promise<void> {
    return this.run((v) => ({
      pass: typeof v === 'string' && (typeof re === 'string' ? v.includes(re) : re.test(v)),
      message: `expected ${show(v)} to match ${String(re)}`,
    }));
  }
  /** The function throws (or, under .rejects, the error) matches `expected`. */
  toThrow(expected?: string | RegExp | (new (...a: never[]) => Error)): void | Promise<void> {
    const matches = (e: unknown) => {
      if (expected === undefined) return true;
      const msg = e instanceof Error ? e.message : String(e);
      if (typeof expected === 'string') return msg.includes(expected);
      if (expected instanceof RegExp) return expected.test(msg);
      return e instanceof expected;
    };
    if (this.mode === 'rejects') {
      return this.run((e) => ({ pass: matches(e), message: `expected the rejection ${show(e)} to match ${String(expected)}` }));
    }
    return this.run((fn) => {
      try {
        (fn as () => unknown)();
      } catch (e) {
        return { pass: matches(e), message: `expected the thrown ${show(e)} to match ${String(expected)}` };
      }
      return { pass: false, message: 'expected the function to throw' };
    });
  }
  toThrowError(expected?: string | RegExp | (new (...a: never[]) => Error)): void | Promise<void> {
    return this.toThrow(expected);
  }
}

/** expect.poll(fn): the value matchers, retried until `fn()` passes or the timeout. */
export function pollAssertions(fn: () => unknown, timeout: number, intervals: number[], negated = false): unknown {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === 'not') return pollAssertions(fn, timeout, intervals, !negated);
      return async (...args: unknown[]) => {
        const deadline = Date.now() + timeout;
        let i = 0;
        for (;;) {
          const value = await fn();
          const base = new ValueAssertions(value, negated);
          const matcher = (base as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string];
          if (typeof matcher !== 'function') throw new Error(`expect.poll has no matcher ${String(prop)}`);
          try {
            await matcher.apply(base, args);
            return;
          } catch (e) {
            if (Date.now() >= deadline) throw e;
          }
          await new Promise((r) => setTimeout(r, intervals[Math.min(i++, intervals.length - 1)]));
        }
      };
    },
  };
  return new Proxy({}, handler);
}
