/**
 * THE FILL OVER EXACT WIDTHS: the greedy line count with its safe-side guard, and where a footnote mark sits. (Where
 * text may break is held to Chromium by `packLineBreaks.test.ts`.)
 */
import { describe, expect, it } from 'vitest';
import { linesFor, minPx, runsOf } from '@/modules/accounting/services/packs/pages/packLineWrap';
import { textPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';

describe('the fill', () => {
  const runs = runsOf('Operating expenses', (piece) => textPx(piece, 12, 400), 3);

  it('a piece that fits with less than the guard to spare takes a line it may not need, never one too few', () => {
    const full = runs.reduce((sum, r) => sum + r.gap + r.w, 0);
    expect(linesFor(runs, 0, full)).toBe(2);
    expect(linesFor(runs, 0, full + 1)).toBe(1);
  });

  it('a footnote mark sits on the last piece: it widens the narrowest width only if the last piece is the widest', () => {
    const wide = runsOf('Intercompanyrecharges net', (piece) => textPx(piece, 12, 400), 3);
    expect(minPx(wide, 10)).toBe(textPx('Intercompanyrecharges', 12, 400));
    const last = runsOf('net Intercompanyrecharges', (piece) => textPx(piece, 12, 400), 3);
    expect(minPx(last, 10)).toBe(textPx('Intercompanyrecharges', 12, 400) + 10);
  });
});
