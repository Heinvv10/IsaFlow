/**
 * THE HALF-CENT TOLERANCE IS A MONEY TOLERANCE.
 *
 * `signOf` treats anything under half a cent as nil, which is right for float
 * residue on rands. Applied to a ratio, a percentage or a day count it printed
 * the en dash — the pack's word for a figure measured and nil — over a small
 * figure that is not nil: a current ratio of 0.004 is a measured ratio.
 */
import { describe, expect, it } from 'vitest';
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';

const fig = (value: number, format: PackFigure['format']): PackFigure => ({ value, format, source: 's.f' });

describe('formatFigureText nil handling by unit', () => {
  it('prints a small non-zero ratio as that ratio, not as nil', () => {
    expect(formatFigureText(fig(0.004, 'ratio'), 'R')).toBe('0.00×');
  });
  it('prints a small non-zero day count as days, not as nil', () => {
    expect(formatFigureText(fig(0.004, 'days'), 'R')).toBe('0 days');
  });
  it('still prints an exact zero ratio, percentage and day count as the nil glyph', () => {
    for (const format of ['ratio', 'pct', 'days'] as const) {
      expect(formatFigureText(fig(0, format), 'R'), format).toBe('–');
    }
  });
  it('keeps the half-cent tolerance for money', () => {
    expect(formatFigureText(fig(0.004, 'money'), 'R')).toBe('–');
  });
});
