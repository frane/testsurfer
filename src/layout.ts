/** Element boxes from vs_layout replies. */

export interface LayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

/** Parse `<ref> x=.. y=.. w=.. h=.. visible=.. z=..` lines; `!` error lines are skipped. */
export function parseLayoutLines(lines: string[]): Map<number, LayoutRect> {
  const out = new Map<number, LayoutRect>();
  for (const line of lines) {
    if (line.startsWith('!')) continue;
    const tokens = line.trim().split(/\s+/);
    const ref = Number(tokens[0]);
    if (!Number.isInteger(ref)) continue;
    const rect: LayoutRect = { x: 0, y: 0, w: 0, h: 0, visible: false };
    for (const tok of tokens.slice(1)) {
      const eq = tok.indexOf('=');
      if (eq <= 0) continue;
      const k = tok.slice(0, eq);
      const v = tok.slice(eq + 1);
      if (k === 'visible') rect.visible = v === 'true';
      else if (k === 'x') rect.x = Number(v);
      else if (k === 'y') rect.y = Number(v);
      else if (k === 'w') rect.w = Number(v);
      else if (k === 'h') rect.h = Number(v);
    }
    out.set(ref, rect);
  }
  return out;
}
