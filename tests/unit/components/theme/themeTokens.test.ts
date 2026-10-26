/**
 * The measured contrast of the text tokens (master plan 3b-2: muted text >= 4.5:1 in both themes).
 * Reads the real values from styles/globals.css and computes WCAG ratios against every surface a
 * token sits on, so changing a hex there is judged by the number, not by eye.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'styles/globals.css'), 'utf8');

function block(selector: string): string {
  const open = new RegExp(`(^|\\n)\\s*${selector.replace('.', '\\.')}(,[^{]*)?\\s\\{`).exec(css);
  if (!open) throw new Error(`no ${selector} block`);
  return css.slice(open.index, css.indexOf('\n  }', open.index));
}
function token(scope: string, name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block(scope));
  if (!m?.[1]) throw new Error(`${name} not found in ${scope}`);
  return m[1];
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// Surfaces text sits on: page, card, secondary, hover/chip, and (dark) the lightest chip behind text.
const SURFACES = {
  ':root': ['#ffffff', '#f9fafb', '#f3f4f6'],
  '.dark': ['#0f172a', '#1e293b', '#334155'],
} as const;

describe.each(Object.entries(SURFACES))('%s text tokens', (scope, surfaces) => {
  const primary = token(scope, '--ff-text-primary');
  const secondary = token(scope, '--ff-text-secondary');
  const tertiary = token(scope, '--ff-text-tertiary');

  it.each(['primary', 'secondary', 'tertiary'] as const)('%s text is AA (4.5:1) on every surface it sits on', (which) => {
    const fg = { primary, secondary, tertiary }[which];
    for (const bg of surfaces) expect(contrast(fg, bg), `${which} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the three levels visibly apart, so muted labels keep their hierarchy', () => {
    const onPage = surfaces[0];
    const [p, s, t] = [primary, secondary, tertiary].map((c) => contrast(c, onPage)) as [number, number, number];
    expect(p).toBeGreaterThan(s * 1.15);
    expect(s).toBeGreaterThan(t * 1.15);
  });
});
