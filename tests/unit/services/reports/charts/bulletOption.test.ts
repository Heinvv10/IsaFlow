import { describe, it, expect } from 'vitest';
import { buildBudgetVsActualLines } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { buildBudgetBulletOption } from '@/components/accounting/charts/bulletOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const LINES = buildBudgetVsActualLines(
  [
    { id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 900_000 },
    { id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 130_000 },
  ],
  { '1000': 1_000_000, '6000': 120_000 },
);

type Series = { name?: string; type: string; data: unknown[]; itemStyle?: Record<string, unknown> };
const seriesOf = (o: Record<string, unknown>) => o['series'] as Series[];
const named = (o: Record<string, unknown>, n: string) => seriesOf(o).find((s) => s.name === n)!;

describe('buildBudgetBulletOption', () => {
  const opt = buildBudgetBulletOption(LINES, DEFAULT_PALETTE) as unknown as Record<string, unknown>;

  it('draws budget as an outline reference and actual as solid ink', () => {
    expect(named(opt, 'Budget').itemStyle?.['color']).toBe('transparent');
    expect(named(opt, 'Budget').itemStyle?.['borderColor']).toBe(DEFAULT_PALETTE.ink);
    expect(named(opt, 'Actual').itemStyle?.['color']).toBe(DEFAULT_PALETTE.ink);
  });

  it('takes both bar lengths straight from the service, never a difference', () => {
    expect(named(opt, 'Actual').data).toEqual([900_000, 130_000]);
    expect(named(opt, 'Budget').data).toEqual([1_000_000, 120_000]);
  });

  it('colours the variance label by the service polarity, not by which bar is longer', () => {
    const labels = named(opt, 'Actual').data;
    // Sales is UNDER budget on revenue → unfavourable, even though the actual
    // bar is shorter. Rent is OVER budget on an expense → also unfavourable,
    // and its actual bar is longer. Bar length cannot tell them apart.
    const marks = (opt['__varianceColours'] as string[]);
    expect(marks).toEqual([DEFAULT_PALETTE.unfav, DEFAULT_PALETTE.unfav]);
    expect(labels).toHaveLength(2);
  });

  it('marks a favourable line with the favourable colour', () => {
    const favLines = buildBudgetVsActualLines(
      [{ id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 1_100_000 }],
      { '1000': 1_000_000 },
    );
    const o = buildBudgetBulletOption(favLines, DEFAULT_PALETTE) as unknown as Record<string, unknown>;
    expect(o['__varianceColours']).toEqual([DEFAULT_PALETTE.fav]);
  });

  it('shows the largest absolute variances first and honours the limit', () => {
    const o = buildBudgetBulletOption(LINES, DEFAULT_PALETTE, { limit: 1 }) as unknown as Record<string, unknown>;
    expect((o['yAxis'] as { data: string[] }).data).toEqual(['Sales']);
  });

  it('anchors the value axis at zero', () => {
    expect((opt['xAxis'] as { min: number }).min).toBe(0);
  });
});
