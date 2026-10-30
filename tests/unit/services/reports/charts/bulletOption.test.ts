import { describe, it, expect } from 'vitest';
import { buildBudgetVsActualLines } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { formatStatementFigure } from '@/lib/format/money';
import { buildBudgetBulletOption } from '@/components/accounting/charts/bulletOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const LINES = buildBudgetVsActualLines(
  [
    { id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 900_000 },
    { id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 130_000 },
  ],
  { a: 1_000_000, b: 120_000 },
);

type Item = { value: number; label: { show: boolean; color: string } };
type Series = {
  name?: string;
  type: string;
  data: Item[];
  itemStyle?: Record<string, unknown>;
};
const seriesOf = (o: Record<string, unknown>) => o['series'] as Series[];
const named = (o: Record<string, unknown>, n: string) => seriesOf(o).find((s) => s.name === n)!;
const values = (s: Series) => s.data.map((d) => d.value);

/** The polarity the chart paints, per row: the colour of the one label shown, on whichever bar is
 *  longer (a per-item string; bulletLegibility.test.ts proves it is the colour painted). */
const labelColours = (o: Record<string, unknown>): string[] => {
  const [budget, actual] = [named(o, 'Budget'), named(o, 'Actual')];
  return actual.data.map((a, i) => {
    const shown = [a, budget.data[i]!].filter((d) => d.label.show);
    if (shown.length !== 1) throw new Error(`row ${i}: ${shown.length} labels shown`);
    return shown[0]!.label.color;
  });
};

type TooltipOption = { tooltip: { formatter: (params: Array<{ dataIndex: number }>) => string } };

describe('buildBudgetBulletOption', () => {
  const opt = buildBudgetBulletOption(LINES, DEFAULT_PALETTE) as unknown as Record<string, unknown>;

  it('escapes an account name before it reaches the tooltip formatter', () => {
    const maliciousLines = buildBudgetVsActualLines(
      [{ id: 'a', account_code: '1000', account_name: '<img src=x onerror=1>', account_type: 'revenue', actual_amount: 900_000 }],
      { a: 1_000_000 },
    );
    const withXss = buildBudgetBulletOption(maliciousLines, DEFAULT_PALETTE) as unknown as TooltipOption;
    const html = withXss.tooltip.formatter([{ dataIndex: 0 }]);
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src=x onerror=1>');
  });

  it('draws budget as an outline reference and actual as solid ink', () => {
    expect(named(opt, 'Budget').itemStyle?.['color']).toBe('transparent');
    expect(named(opt, 'Budget').itemStyle?.['borderColor']).toBe(DEFAULT_PALETTE.ink);
    expect(named(opt, 'Actual').itemStyle?.['color']).toBe(DEFAULT_PALETTE.ink);
  });

  it('takes both bar lengths straight from the service, never a difference', () => {
    // Rent (|variance| 10,000) is the smaller movement so it sits first in
    // the reversed row order; Sales (|variance| 100,000) is last, which is
    // what lands at the TOP of a horizontal bar chart.
    expect(values(named(opt, 'Actual'))).toEqual([130_000, 900_000]);
    expect(values(named(opt, 'Budget'))).toEqual([120_000, 1_000_000]);
  });

  it('keeps the largest |variance| account last, which ECharts renders at the top', () => {
    const yAxisData = (opt['yAxis'] as { data: string[] }).data;
    expect(yAxisData[yAxisData.length - 1]).toBe('Sales');
    expect(yAxisData).toEqual(['Rent', 'Sales']);
  });

  it('lines up every series datum with the same-index yAxis category', () => {
    const yAxisData = (opt['yAxis'] as { data: string[] }).data;
    const actualData = values(named(opt, 'Actual'));
    const budgetData = values(named(opt, 'Budget'));
    // Index 0 is Rent: actual 130,000 against a budget of 120,000.
    expect(yAxisData[0]).toBe('Rent');
    expect(actualData[0]).toBe(130_000);
    expect(budgetData[0]).toBe(120_000);
    // Index 1 is Sales: actual 900,000 against a budget of 1,000,000.
    expect(yAxisData[1]).toBe('Sales');
    expect(actualData[1]).toBe(900_000);
    expect(budgetData[1]).toBe(1_000_000);
  });

  it('colours the variance label by the service polarity, not by which bar is longer', () => {
    const labels = values(named(opt, 'Actual'));
    // Sales is UNDER budget on revenue → unfavourable, even though the actual
    // bar is shorter. Rent is OVER budget on an expense → also unfavourable,
    // and its actual bar is longer. Bar length cannot tell them apart.
    expect(labelColours(opt)).toEqual([DEFAULT_PALETTE.unfav, DEFAULT_PALETTE.unfav]);
    expect(labels).toHaveLength(2);
  });

  it('marks a favourable line with the favourable colour', () => {
    const favLines = buildBudgetVsActualLines(
      [{ id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 1_100_000 }],
      { a: 1_000_000 },
    );
    const o = buildBudgetBulletOption(favLines, DEFAULT_PALETTE) as unknown as Record<string, unknown>;
    expect(labelColours(o)).toEqual([DEFAULT_PALETTE.fav]);
  });

  it('draws only budgeted lines: an unbudgeted account is not charted or judged', () => {
    const mixed = buildBudgetVsActualLines(
      [
        { id: 'a', account_code: '1000', account_name: 'Sales', account_type: 'revenue', actual_amount: 1_100_000 },
        { id: 'c', account_code: '6900', account_name: 'Unbudgeted spend', account_type: 'expense', actual_amount: 9_000_000 },
      ],
      { a: 1_000_000 },
    );
    const o = buildBudgetBulletOption(mixed, DEFAULT_PALETTE) as unknown as Record<string, unknown>;
    expect((o['yAxis'] as { data: string[] }).data).toEqual(['Sales']);
    expect(labelColours(o)).toEqual([DEFAULT_PALETTE.fav]);
  });

  it('a deliberate zero budget is charted and judged by favourable', () => {
    const zero = buildBudgetVsActualLines(
      [{ id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 500 }],
      { b: 0 },
    );
    const o = buildBudgetBulletOption(zero, DEFAULT_PALETTE) as unknown as Record<string, unknown>;
    expect((o['yAxis'] as { data: string[] }).data).toEqual(['Rent']);
    expect(labelColours(o)).toEqual([DEFAULT_PALETTE.unfav]);
  });

  it('prints the movement (actual − budget) in the tooltip and label, never the favourably signed variance', () => {
    const over = buildBudgetVsActualLines(
      [{ id: 'b', account_code: '6000', account_name: 'Rent', account_type: 'expense', actual_amount: 1200 }],
      { b: 1000 },
    );
    const o = buildBudgetBulletOption(over, DEFAULT_PALETTE) as unknown as TooltipOption & Record<string, unknown>;
    // An expense R200 over budget: +200 printed (as the screen and CSV do), coloured unfavourable.
    expect(o.tooltip.formatter([{ dataIndex: 0 }])).toContain(`Variance ${formatStatementFigure(200, { symbol: true })}`);
    const label = (named(o, 'Actual') as unknown as { label: { formatter: (p: { dataIndex: number }) => string } }).label;
    expect(label.formatter({ dataIndex: 0 })).toBe(formatStatementFigure(200));
    expect(labelColours(o)).toEqual([DEFAULT_PALETTE.unfav]);
  });

  it('shows the largest absolute variances first and honours the limit', () => {
    const o = buildBudgetBulletOption(LINES, DEFAULT_PALETTE, { limit: 1 }) as unknown as Record<string, unknown>;
    expect((o['yAxis'] as { data: string[] }).data).toEqual(['Sales']);
  });

  it('anchors the value axis at zero', () => {
    expect((opt['xAxis'] as { min: number }).min).toBe(0);
  });
});
