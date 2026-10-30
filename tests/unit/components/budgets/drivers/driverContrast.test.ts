/**
 * Contrast of a reforecast's closed-month cells (P4 review round 1, item 13), computed from the
 * theme tokens in styles/globals.css: the cell figure and its 12px (text-xs) "A" marker are
 * `--ff-text-tertiary` on `--ff-bg-tertiary` (on `--ff-cell-selected-bg` when selected). WCAG AA
 * for normal-size text is 4.5:1, in light and dark.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(__dirname, '../../../../../styles/globals.css'), 'utf8');
const darkStart = css.indexOf('.dark {');

/** The token's hex in the light (`:root`) or dark (`.dark`) block. */
function token(name: string, theme: 'light' | 'dark'): string {
  const block = theme === 'light' ? css.slice(0, darkStart) : css.slice(darkStart);
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!m) throw new Error(`no ${theme} --${name}`);
  return m[1]!;
}

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('closed-month (actual) cell contrast', () => {
  it.each(['light', 'dark'] as const)('%s: text-tertiary on bg-tertiary and on the selected fill is at least 4.5:1', (theme) => {
    const fg = token('ff-text-tertiary', theme);
    expect(ratio(fg, token('ff-bg-tertiary', theme))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(fg, token('ff-cell-selected-bg', theme))).toBeGreaterThanOrEqual(4.5);
  });
});
