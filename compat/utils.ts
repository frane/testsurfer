/** Stand-ins for the helpers in Playwright's tests/config/utils.ts the ported specs import. */

export { rafraf } from './pageTest.ts';

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

export function roundBox<T extends { x: number; y: number; width?: number; height?: number; w?: number; h?: number }>(b: T): T {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(b)) out[k] = typeof v === 'number' ? Math.round(v) : (v as number);
  return out as T;
}

export async function attachFrame(
  page: { evaluate: (s: string) => Promise<unknown> },
  frameId: string,
  url: string,
): Promise<void> {
  await page.evaluate(
    `new Promise(r => { const f = document.createElement('iframe'); f.src = ${JSON.stringify(url)}; f.id = ${JSON.stringify(frameId)}; f.onload = () => r('ok'); document.body.appendChild(f); })`,
  );
}
