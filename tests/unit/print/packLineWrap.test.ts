/**
 * THE FILL OVER EXACT WIDTHS: the greedy line count, each candidate line measured whole, with its guard; and where a
 * footnote mark sits. (Where text may break is held to Chromium by `packLineBreaks.test.ts`; the fill against
 * Chromium's own lines by `packTableLayout.test.ts`.)
 */
import { describe, expect, it } from 'vitest';
import { linesForText, minPx, WRAP_GUARD_PX } from '@/modules/accounting/services/packs/pages/packLineWrap';
import { pieces } from '@/modules/accounting/services/packs/pages/packLineBreaks';
import { textPx } from '@/modules/accounting/services/packs/pages/packFigureWidth';

const width = (text: string): number => textPx(text, 12, 400);

describe('the fill', () => {
  const parts = pieces('Operating expenses');
  const full = width('Operating expenses');

  it('a line is measured whole, and a piece that fits with less than the guard to spare takes the next line', () => {
    expect(linesForText(parts, width, 0, full + WRAP_GUARD_PX)).toBe(1);
    expect(linesForText(parts, width, 0, full + WRAP_GUARD_PX - 1 / 64)).toBe(2);
    expect(linesForText(parts, width, 0, width('Operating') + WRAP_GUARD_PX)).toBe(2);
  });

  it('a footnote mark stays with the last piece: it can push that piece to a line of its own', () => {
    expect(linesForText(parts, width, 10, full + WRAP_GUARD_PX)).toBe(2);
    expect(linesForText(parts, width, 10, full + 10 + WRAP_GUARD_PX)).toBe(1);
  });

  it('the narrowest width is the widest piece, the mark counted with the LAST one it sits after', () => {
    const runs = (text: string) => pieces(text).map((p) => ({ w: width(p.text) }));
    expect(minPx(runs('Intercompanyrecharges net'), 10)).toBe(width('Intercompanyrecharges'));
    expect(minPx(runs('net Intercompanyrecharges'), 10)).toBe(width('Intercompanyrecharges') + 10);
  });
});
