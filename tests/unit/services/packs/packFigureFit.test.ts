/**
 * What a row of nowrap figures tells the stylesheet: the summed widths, in ems, of the widest figure
 * of each column (`packFigureFit.ts`). The printed proof, that nothing then passes the right edge, is
 * `tests/unit/print/packNothingPassesTheEdge.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { kpiFitStyle, tableFitStyle, widestPerColumnEms } from '@/components/accounting/packs/primitives/packFigureFit';
import { textWidthEms } from '@/modules/accounting/services/packs/pages/packTextMetrics';

describe('packFigureFit', () => {
  it('sums the widest text of each column, not the widest overall nor every text', () => {
    const ems = widestPerColumnEms([['(1 546)', '12'], ['9']]);
    expect(ems).toBeCloseTo(textWidthEms('(1 546)') + textWidthEms('9'), 6);
  });

  it('puts tile i in column i % 4, and ignores a tile with no figure', () => {
    const texts = ['1', '22', '333', '4444', '(55 555)', null, '7', '8'];
    const expected = widestPerColumnEms([['1', '(55 555)'], ['22'], ['333', '7'], ['4444', '8']]);
    expect(kpiFitStyle(texts)['--pack-fit-ems']).toBeCloseTo(expected, 1);
  });

  it('states a table\'s column count beside its width', () => {
    const style = tableFitStyle([['1', '2'], ['(297 000 000)'], ['5']]);
    expect(style['--pack-fit-cols']).toBe(3);
    expect(style['--pack-fit-ems']).toBeCloseTo(widestPerColumnEms([['1', '2'], ['(297 000 000)'], ['5']]), 1);
  });

  it('a wider figure is a wider row', () => {
    const narrow = kpiFitStyle(['(1 546)', '910', '5', '6'])['--pack-fit-ems'] as number;
    const wide = kpiFitStyle(['(133 500 000)', '910', '5', '6'])['--pack-fit-ems'] as number;
    expect(wide).toBeGreaterThan(narrow);
  });
});
