/**
 * Module resolve hooks for running a Playwright suite unchanged:
 * `@playwright/test` (and `playwright/test`) resolve to testsurfer, and
 * extensionless relative imports (`../fixtures`) find their .ts / .js
 * file, as Playwright's own runner does. Registered by register.ts.
 */

const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const INDEX = new URL(`./index${ext}`, import.meta.url).href;
const ALIASES = new Set(['@playwright/test', 'playwright/test']);
const TRY = ['.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.js'];

type Resolved = { url: string; format?: string | null; shortCircuit?: boolean };
type Next = (specifier: string, context?: unknown) => Promise<Resolved>;

export async function resolve(specifier: string, context: { parentURL?: string }, next: Next): Promise<Resolved> {
  if (ALIASES.has(specifier)) return { url: INDEX, shortCircuit: true };
  const relative = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
  if (!relative || /\.[cm]?[jt]sx?$|\.json$/.test(specifier)) return next(specifier, context);
  try {
    return await next(specifier, context);
  } catch (first) {
    for (const suffix of TRY) {
      try {
        return await next(specifier + suffix, context);
      } catch {
        /* try the next one */
      }
    }
    throw first;
  }
}
