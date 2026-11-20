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

type Loaded = { format?: string | null; source?: string | ArrayBuffer | Uint8Array | null; shortCircuit?: boolean };
type NextLoad = (url: string, context?: unknown) => Promise<Loaded>;

/**
 * Test files may use `__filename` and `__dirname`, which Playwright's
 * CommonJS transpile provides. In an ES module they are undefined, so
 * define them for files that use them without declaring them.
 */
export async function load(url: string, context: unknown, next: NextLoad): Promise<Loaded> {
  const r = await next(url, context);
  if (!url.startsWith('file:') || url.includes('/node_modules/') || r.format === 'commonjs' || r.source == null) return r;
  const src = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source);
  if (!/\b__(file|dir)name\b/.test(src) || /\b(const|let|var)\s+__(file|dir)name\b/.test(src)) return r;
  const prelude =
    "const __filename = (await import('node:url')).fileURLToPath(import.meta.url);" +
    "const __dirname = (await import('node:path')).dirname(__filename);";
  return { ...r, source: prelude + src };
}
